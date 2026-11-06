import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEbmlCutter } from '../../src/cut/ebml.ts';
import { keyframeOptionHonoured } from '../../src/cut/honoured.ts';
import {
    CutterError,
    type CutOptions,
    type CutSegment,
} from '../../src/cut/types.ts';
import { audioOnlyStream, badSizeStream } from '../support/ebml-writer.ts';
import {
    aligned,
    byteAtATime,
    initBin,
    offsetsOf,
    readSet,
    seededSplits,
    sha256,
} from '../support/fixtures.ts';

const OPTIONS: CutOptions = { targetMs: 5000, maxMs: 30000 };

function cut(
    chunks: Uint8Array[],
    options: CutOptions = OPTIONS,
): CutSegment[] {
    const cutter = createEbmlCutter(options);
    const segments = chunks.flatMap((chunk) => cutter.push(chunk));

    return [...segments, ...cutter.end()];
}

const EXPECTED_OFFSETS: Record<string, number[]> = {
    'chrome-vp8-kf': [
        0, 189, 247067, 483129, 716798, 955394, 1198270, 1445074, 1689585,
        1943297, 2184696, 2431965, 2684561,
    ],
    'chrome-vp9-kf': [
        0, 189, 219335, 442926, 670310, 907540, 1150855, 1394805, 1631641,
        1870711, 2110315, 2354130, 2587107,
    ],
    'chrome-vp8-nokf': [
        0, 189, 345952, 668219, 1003791, 1339204, 1685397, 2027947, 2366583,
        2703093,
    ],
    'firefox-vp8': [
        0, 313, 284927, 590166, 894224, 1190318, 1497323, 1807509, 2107496,
    ],
};

for (const name of Object.keys(EXPECTED_OFFSETS)) {
    const raw = readSet(name);
    const expected = aligned(name);
    const feeds: Record<string, Uint8Array[]> = {
        'the original blob edges': raw.blobs,
        'one byte at a time for the first 65,536 bytes': byteAtATime(
            raw.whole,
            65_536,
        ),
    };

    for (let seed = 1; seed <= 20; seed++) {
        feeds[`seeded split ${seed}`] = seededSplits(raw.whole, seed);
    }

    for (const [label, chunks] of Object.entries(feeds)) {
        test(`${name}, ${label}: gives the aligned cuts, bytes and times`, () => {
            const segments = cut(chunks);

            assert.deepEqual(offsetsOf(segments), EXPECTED_OFFSETS[name]);
            assert.deepEqual(
                segments.map((segment) => sha256(segment.bytes)),
                expected.fragments.map((fragment) => fragment.sha256),
            );
            assert.deepEqual(
                segments.map((segment) => segment.kind),
                expected.fragments.map((fragment) => fragment.kind),
            );
            assert.deepEqual(segments[0].bytes, initBin(`${name}-aligned`));
            assert.deepEqual(
                segments.map((segment) => segment.startMs),
                expected.fragments.map((fragment) => fragment.start_ms),
            );
            assert.deepEqual(
                segments.slice(0, -1).map((segment) => segment.durationMs),
                expected.fragments
                    .slice(0, -1)
                    .map((fragment) => fragment.duration_ms),
            );
            // The aligned last durations came from the recorder's wall clock; 150 ms is the scorer's duration tolerance.
            assert.ok(
                Math.abs(
                    segments.at(-1)!.durationMs -
                        expected.fragments.at(-1)!.duration_ms,
                ) <= 150,
            );
            assert.ok(segments.every((segment) => !segment.nonKeyframeStart));
        });
    }
}

test('past max_ms the next Cluster is cut without a keyframe, and flagged', () => {
    const segments = cut(readSet('chrome-vp8-nokf').blobs, {
        targetMs: 5000,
        maxMs: 4000,
    });

    assert.equal(offsetsOf(segments)[2], 274211);
    assert.equal(segments[2].startMs, 5111);
    assert.equal(segments[2].nonKeyframeStart, true);
    assert.equal(segments[1].nonKeyframeStart, false);
});

test('a Cluster with no video block is never a cut on a video track', () => {
    const offsets = offsetsOf(
        cut(readSet('chrome-vp8-nokf').blobs, { targetMs: 3000, maxMs: 30000 }),
    );

    assert.ok(!offsets.includes(2535541), 'the audio-only Cluster at 50471 ms');
    assert.ok(offsets.includes(2536043), 'the keyframe Cluster at 50485 ms');
});

test('the keyframe option counts as honoured only where segments land within 250 ms of the target', () => {
    const verdict = (name: string): boolean | null =>
        keyframeOptionHonoured(
            cut(readSet(name).blobs)
                .filter((segment) => segment.kind === 'media')
                .map((segment) => segment.durationMs),
            5000,
        );

    assert.deepEqual(
        [
            'chrome-vp8-kf',
            'chrome-vp9-kf',
            'chrome-vp8-nokf',
            'firefox-vp8',
        ].map(verdict),
        [true, true, false, false],
    );
    assert.equal(keyframeOptionHonoured([5000], 5000), null);
});

test('an audio-only track cuts at any Cluster once target minus 250 ms has passed', () => {
    const stream = audioOnlyStream([
        0, 1000, 2000, 3000, 4000, 4749, 4750, 6000, 7000, 8000, 9000, 9499,
        9500, 11000,
    ]);
    const segments = cut([stream], { ...OPTIONS, audioOnly: true });

    assert.deepEqual(
        segments
            .filter((segment) => segment.kind === 'media')
            .map((segment) => segment.startMs),
        [0, 4750, 9500],
    );
});

test('end() with no bytes pushed gives no segments', () => {
    assert.deepEqual(cut([]), []);
});

test('a size whose first byte is 0x00 is a CutterError, never a silent cut', () => {
    const cutter = createEbmlCutter(OPTIONS);

    assert.throws(() => {
        cutter.push(badSizeStream());
        cutter.end();
    }, CutterError);
});

test('bad bytes mid-push keep the segments completed before them, and pending() holds the rest', () => {
    const whole = readSet('chrome-vp8-kf').whole.slice();
    whole[716798] = 0x00; // the first byte of the Cluster ID that starts the fourth media segment
    const cutter = createEbmlCutter(OPTIONS);
    let error: unknown = null;

    try {
        cutter.push(whole);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error instanceof CutterError);
    assert.equal(error.reason, 'parse_error');
    assert.deepEqual(offsetsOf(error.completed), [0, 189, 247067]);
    assert.equal(cutter.initDone(), true);
    assert.deepEqual(cutter.pending(), whole.subarray(483129));
});
