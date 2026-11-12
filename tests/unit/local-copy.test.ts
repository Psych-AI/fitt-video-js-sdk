import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createLocalCopy,
    dropPageCopy,
    type LocalCopyDeps,
    type LocalView,
} from '../../src/core/review.ts';
import type { SegmentRecord } from '../../src/core/store.ts';
import { createCutter } from '../../src/cut/select.ts';
import type { CutSegment } from '../../src/cut/types.ts';
import { fakeObjectUrls } from '../support/fake-video.ts';
import { concat, readSet } from '../support/fixtures.ts';
import { SID, segmentRecord } from '../support/records.ts';

const ANCHOR = 12;
/** chrome-vp8-kf: the 1,054-byte head plus 2,908,272 media bytes (Task 2). */
const HELD = 2_909_326;

/** chrome-vp8-kf cut as a run cuts it, as the camera records of take 1 and this run. */
function cameraRecords(run = 0): SegmentRecord[] {
    const set = readSet('chrome-vp8-kf');
    const cutter = createCutter(
        set.mimeType,
        { targetMs: 5000, maxMs: 30_000 },
        () => undefined,
    );
    const cut: CutSegment[] = [];
    set.blobs.forEach((blob, index) =>
        cut.push(...cutter.push(blob, index * 5000)),
    );
    cut.push(...cutter.end(set.blobs.length * 5000));

    return cut.map((segment, seq) =>
        segmentRecord({
            run_index: run,
            seq,
            kind: segment.kind,
            start_ms:
                segment.kind === 'init' ? ANCHOR : ANCHOR + segment.startMs,
            duration_ms: segment.durationMs,
            bytes: segment.bytes.byteLength,
            init:
                segment.kind === 'init'
                    ? {
                          anchor_ms: ANCHOR,
                          anchor_source: 'performance',
                          mime: set.mimeType,
                          started_ms: 10,
                      }
                    : null,
            data: segment.bytes.slice().buffer,
        }),
    );
}

function copyRig(overrides: Partial<LocalCopyDeps> = {}) {
    const urls = fakeObjectUrls();
    const copy = createLocalCopy({
        sessionId: SID,
        off: null,
        maxBytes: 100_000_000,
        objectUrls: urls,
        win: null,
        onChange: () => undefined,
        ...overrides,
    });

    return { copy, urls };
}

function holdAll(
    rig: ReturnType<typeof copyRig>,
    records = cameraRecords(),
): void {
    for (const record of records) {
        rig.copy.add(record);
    }

    rig.copy.complete(1, 2);
}

test('a single-run take becomes one seekable file at complete, built from the held buffers', async () => {
    const r = copyRig();
    const records = cameraRecords();

    for (const record of records) {
        r.copy.add(record);
    }

    assert.equal(r.copy.view().state, 'recording');
    r.copy.complete(1, 2);

    assert.deepEqual(r.copy.view(), {
        state: 'held',
        take: 1,
        bytes: HELD,
        reason: null,
        objectUrls: 0,
        revoked: 0,
    });
    assert.equal(r.copy.objectUrl(), 'blob:fake/1');
    assert.equal(r.copy.view().objectUrls, 1);

    const blob = r.urls.blobs[0];
    assert.equal(blob.type, 'video/webm;codecs=vp8,opus');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(
        Buffer.compare(
            Buffer.from(bytes.subarray(1054)),
            Buffer.from(
                concat(
                    records
                        .slice(1)
                        .map((record) => new Uint8Array(record.data!)),
                ),
            ),
        ),
        0,
    );
    assert.equal(r.copy.durationMs(), 60_004);
    assert.equal(r.copy.leadInMs(), ANCHOR - 2);
});

test('the copy keeps its own reference when the uploader frees a record', () => {
    const r = copyRig();

    for (const record of cameraRecords()) {
        r.copy.add(record);
        record.data = null;
    }

    r.copy.complete(1, 2);

    assert.equal(r.copy.view().bytes, HELD);
});

test('a record cut past max_ms gets no cue', () => {
    const r = copyRig();
    cameraRecords().forEach((record, index) => r.copy.add(record, index === 4));
    r.copy.complete(1, 2);

    assert.equal(r.copy.view().bytes, HELD - 69);
});

test('a second run drops the copy at once and says why', () => {
    const r = copyRig();

    for (const record of cameraRecords(0).slice(0, 3)) {
        r.copy.add(record);
    }

    r.copy.add(cameraRecords(1)[0]);
    r.copy.complete(1, 2);

    assert.deepEqual(r.copy.view(), {
        state: 'off',
        take: 1,
        bytes: 0,
        reason: 'second_run',
        objectUrls: 0,
        revoked: 0,
    });
    assert.equal(r.copy.objectUrl(), null);
});

test('a fallback run, a copy over the byte budget and an unreadable init are off', () => {
    const records = cameraRecords();
    const fallback = copyRig();
    fallback.copy.add(records[0]);
    fallback.copy.fellBack(1);

    const budget = copyRig({ maxBytes: 1_000_000 });
    holdAll(budget, records);

    const unreadable = copyRig();
    holdAll(unreadable, [
        { ...records[0], data: new ArrayBuffer(3) },
        ...records.slice(1),
    ]);

    assert.deepEqual(
        [fallback, budget, unreadable].map((rig) => [
            rig.copy.view().state,
            rig.copy.view().reason,
        ]),
        [
            ['off', 'fallback'],
            ['off', 'over_budget'],
            ['off', 'unreadable'],
        ],
    );
});

test('clearing revokes every object URL handed out, drops the file and says why', () => {
    const r = copyRig();
    holdAll(r);
    r.copy.objectUrl();
    r.copy.objectUrl();
    r.copy.clear('server');

    assert.deepEqual(r.urls.revoked, ['blob:fake/1', 'blob:fake/2']);
    assert.deepEqual(r.copy.view(), {
        state: 'cleared',
        take: 1,
        bytes: 0,
        reason: 'server',
        objectUrls: 2,
        revoked: 2,
    });
    assert.equal(r.copy.objectUrl(), null);
});

test('pagehide clears the copy once', () => {
    const win = new EventTarget();
    const views: LocalView[] = [];
    const r = copyRig({ win, onChange: (view) => views.push(view) });
    holdAll(r);
    win.dispatchEvent(new Event('pagehide'));
    win.dispatchEvent(new Event('pagehide'));

    assert.deepEqual(
        [r.copy.view().state, r.copy.view().reason],
        ['cleared', 'unload'],
    );
    assert.equal(views.filter((view) => view.state === 'cleared').length, 1);
});

test('one copy per page: a copy that starts holding clears the other, and dropPageCopy spares only its session', () => {
    const a = copyRig({ sessionId: '01jbz8q4w6x0k3m5n7p9r2t4a1' });
    const b = copyRig({ sessionId: '01jbz8q4w6x0k3m5n7p9r2t4b1' });
    const records = cameraRecords();
    holdAll(a, records);
    b.copy.add(records[0]);

    assert.deepEqual(
        [a.copy.view().state, a.copy.view().reason],
        ['cleared', 'next_session'],
    );

    dropPageCopy('01jbz8q4w6x0k3m5n7p9r2t4b1', 'next_session');
    assert.equal(b.copy.view().state, 'recording');

    dropPageCopy('01jbz8q4w6x0k3m5n7p9r2t4c1', 'next_session');
    assert.deepEqual(
        [b.copy.view().state, b.copy.view().reason],
        ['cleared', 'next_session'],
    );
});

test('a copy that may not hold never holds, and audio segments are never held', () => {
    const off = copyRig({ off: 'not_allowed' });
    const audio = copyRig();

    for (const record of cameraRecords()) {
        off.copy.add(record);
        audio.copy.add({ ...record, track: 'audio' });
    }

    off.copy.complete(1, 2);
    audio.copy.complete(1, 2);

    assert.deepEqual(
        [off.copy.view().state, off.copy.view().reason],
        ['off', 'not_allowed'],
    );
    assert.deepEqual(
        [audio.copy.view().state, audio.copy.view().bytes],
        ['empty', 0],
    );
});
