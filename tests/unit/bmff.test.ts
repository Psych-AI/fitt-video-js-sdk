import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBmffCutter } from '../../src/cut/bmff.ts';
import { createCutter } from '../../src/cut/select.ts';
import { CutterError, type CutSegment } from '../../src/cut/types.ts';
import {
    byteAtATime,
    concat,
    initBin,
    offsetsOf,
    readSet,
    seededSplits,
} from '../support/fixtures.ts';
import {
    fragment,
    initSegment,
    largeBox,
    NON_SYNC,
    SYNC,
    u32,
} from '../support/mp4-writer.ts';

const OPTIONS = { targetMs: 5000, maxMs: 30000 };

function cut(chunks: Uint8Array[]): CutSegment[] {
    const cutter = createBmffCutter(OPTIONS);

    return [...chunks.flatMap((chunk) => cutter.push(chunk)), ...cutter.end()];
}

const raw = readSet('webkit-mp4');
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
    test(`webkit-mp4, ${label}: init then one segment per sync moof`, () => {
        const segments = cut(chunks);

        assert.deepEqual(
            offsetsOf(segments),
            [
                0, 1135, 146758, 308543, 482968, 646693, 811655, 979556,
                1153606, 1328741, 1493660, 1659899, 1834195,
            ],
        );
        assert.equal(
            segments.reduce(
                (total, segment) => total + segment.bytes.length,
                0,
            ),
            1995398,
        );
        assert.deepEqual(segments[0].bytes, initBin('webkit-mp4'));
        assert.deepEqual(
            [segments[0].kind, segments[0].startMs, segments[0].durationMs],
            ['init', 0, 0],
        );
        assert.deepEqual(
            segments.slice(1).map((segment) => segment.startMs),
            [
                43, 5060, 10100, 15137, 20158, 25198, 30260, 35300, 40318,
                45358, 50398, 55417,
            ],
        );
        assert.deepEqual(
            segments.slice(1).map((segment) => segment.durationMs),
            [
                5017, 5040, 5037, 5021, 5040, 5062, 5040, 5018, 5040, 5040,
                5019, 4626,
            ],
        );
    });
}

/** Media segments when a second fragment, 5000 ms after the first, follows a sync first fragment. */
function segmentsWith(
    second: Parameters<typeof fragment>[0],
    trexVideoFlags = NON_SYNC,
): number {
    const stream = concat([
        initSegment(trexVideoFlags),
        fragment({
            tfdt: 0,
            samples: 3,
            duration: 1000,
            firstSampleFlags: SYNC,
        }),
        fragment(second),
    ]);

    return cut([stream]).filter((segment) => segment.kind === 'media').length;
}

test('first_sample_flags decide over the tfhd default', () => {
    assert.equal(
        segmentsWith({
            tfdt: 3000,
            samples: 3,
            duration: 1000,
            firstSampleFlags: SYNC,
            tfhdDefaultFlags: NON_SYNC,
        }),
        2,
    );
});

test('per-sample flags decide over the tfhd default', () => {
    assert.equal(
        segmentsWith({
            tfdt: 3000,
            samples: 3,
            duration: 1000,
            sampleFlags: [SYNC, NON_SYNC, NON_SYNC],
            tfhdDefaultFlags: NON_SYNC,
        }),
        2,
    );
});

test('the tfhd default decides over the trex default', () => {
    assert.equal(
        segmentsWith(
            { tfdt: 3000, samples: 3, duration: 1000, tfhdDefaultFlags: SYNC },
            NON_SYNC,
        ),
        2,
    );
});

test('with nothing in the fragment the trex default decides', () => {
    assert.equal(
        segmentsWith({ tfdt: 3000, samples: 3, duration: 1000 }, NON_SYNC),
        1,
    );
    assert.equal(
        segmentsWith({ tfdt: 3000, samples: 3, duration: 1000 }, 0),
        2,
    );
});

test('a fragment whose first video sample is not sync is not a cut', () => {
    assert.equal(
        segmentsWith({
            tfdt: 3000,
            samples: 3,
            duration: 1000,
            firstSampleFlags: NON_SYNC,
            sampleFlags: undefined,
        }),
        1,
    );
});

test('tfdt version 0 and a 64-bit box size read the same', () => {
    const stream = concat([
        initSegment(),
        fragment({
            tfdt: 0,
            samples: 3,
            duration: 1000,
            firstSampleFlags: SYNC,
        }),
        largeBox('free', new Uint8Array(32)),
        fragment({
            tfdt: 3000,
            samples: 3,
            duration: 1000,
            firstSampleFlags: SYNC,
            tfdtVersion: 0,
        }),
    ]);
    const media = cut([stream]).filter((segment) => segment.kind === 'media');

    assert.deepEqual(
        media.map((segment) => segment.startMs),
        [0, 5000],
    );
});

test('a box of size 0 is a CutterError', () => {
    const cutter = createBmffCutter(OPTIONS);

    assert.throws(() => {
        cutter.push(
            concat([initSegment(), u32(0), new TextEncoder().encode('moof')]),
        );
        cutter.end();
    }, CutterError);
});

test('an audio-only fragmented MP4 is cut on moof boxes with no fallback, and init plus media join back to the recording', () => {
    const set = readSet('webkit-aac-audio');
    let fellBack = false;
    const cutter = createCutter(
        set.mimeType,
        { targetMs: 5000, maxMs: 30_000, audioOnly: true },
        () => {
            fellBack = true;
        },
    );
    const cut: CutSegment[] = [];
    set.blobs.forEach((blob, index) =>
        cut.push(...cutter.push(blob, index * 5000)),
    );
    cut.push(...cutter.end(set.blobs.length * 5000));
    const [init, ...media] = cut;
    const type = (bytes: Uint8Array): string =>
        String.fromCharCode(...bytes.subarray(4, 8));

    assert.equal(fellBack, false);
    assert.equal(init.kind, 'init');
    assert.equal(type(init.bytes), 'ftyp');
    assert.ok(media.length > 0);
    assert.deepEqual(
        [...new Set(media.map((segment) => type(segment.bytes)))],
        ['moof'],
    );
    assert.equal(
        Buffer.compare(
            Buffer.from(concat(cut.map((segment) => segment.bytes))),
            Buffer.from(set.whole),
        ),
        0,
    );
});
