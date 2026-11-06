import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBlobCutter } from '../../src/cut/blob.ts';
import { createBmffCutter } from '../../src/cut/bmff.ts';
import { createCutter } from '../../src/cut/select.ts';
import { badSizeStream } from '../support/ebml-writer.ts';
import { aligned, concat, readSet, sha256 } from '../support/fixtures.ts';

const OPTIONS = { targetMs: 5000, maxMs: 30000 };
const ignore = (): void => {};

test('the cutter is picked from the MIME type', () => {
    assert.equal(
        createCutter('video/webm;codecs=vp8,opus', OPTIONS, ignore).segmenting,
        'cluster',
    );
    assert.equal(
        createCutter(
            'audio/webm;codecs=opus',
            { ...OPTIONS, audioOnly: true },
            ignore,
        ).segmenting,
        'cluster',
    );
    assert.equal(
        createCutter('video/mp4; codecs=avc1.42000a,mp4a.40.2', OPTIONS, ignore)
            .segmenting,
        'moof',
    );
    assert.equal(createCutter('', OPTIONS, ignore).segmenting, 'blob');
    assert.equal(
        createCutter('video/x-matroska', OPTIONS, ignore).segmenting,
        'blob',
    );
});

test('a parse error keeps the cuts already made, sends the rest as raw groups and reports blob once', () => {
    const raw = readSet('chrome-vp8-kf');
    const corrupted = raw.whole.slice();
    corrupted.fill(0, 716798, 716806); // the Cluster ID at the start of aligned segment 4
    const edges: Uint8Array[] = [];
    let offset = 0;

    for (const blob of raw.blobs) {
        edges.push(corrupted.subarray(offset, offset + blob.length));
        offset += blob.length;
    }

    const reasons: string[] = [];
    const cutter = createCutter(raw.mimeType, OPTIONS, (reason) =>
        reasons.push(reason),
    );
    const segments = [
        ...edges.flatMap((chunk, index) => cutter.push(chunk, index * 5000)),
        ...cutter.end(edges.length * 5000),
    ];
    const expected = aligned('chrome-vp8-kf').fragments;

    assert.deepEqual(
        segments.slice(0, 3).map((segment) => sha256(segment.bytes)),
        expected.slice(0, 3).map((fragment) => fragment.sha256),
    );
    assert.deepEqual(
        concat(segments.map((segment) => segment.bytes)),
        corrupted,
    );
    assert.ok(segments.slice(3).every((segment) => segment.kind === 'media'));
    assert.equal(cutter.segmenting, 'blob');
    assert.deepEqual(reasons, ['parse_error']);
});

test('the blob cutter groups by arrival time, and its first group is the init', () => {
    const cutter = createBlobCutter({ ...OPTIONS, timesliceMs: 1000 });
    const blobs = Array.from({ length: 12 }, (_, index) =>
        Uint8Array.of(index),
    );
    const segments = [
        ...blobs.flatMap((blob, index) => cutter.push(blob, index * 1000)),
        ...cutter.end(12_000),
    ];

    assert.deepEqual(
        segments.map((segment) => segment.bytes.length),
        [5, 5, 2],
    );
    assert.deepEqual(
        segments.map((segment) => segment.kind),
        ['init', 'media', 'media'],
    );
    assert.deepEqual(
        segments.map((segment) => [segment.startMs, segment.durationMs]),
        [
            [0, 5000],
            [5000, 5000],
            [10000, 2000],
        ],
    );
});

test('a parse error before the first Cluster sends every byte as raw groups, the first as the init', () => {
    const reasons: string[] = [];
    const cutter = createCutter(
        'video/webm;codecs=vp8,opus',
        OPTIONS,
        (reason) => reasons.push(reason),
    );
    const bad = badSizeStream();
    const later = Uint8Array.of(1, 2, 3);
    const segments = [
        ...cutter.push(bad, 0),
        ...cutter.push(later, 1000),
        ...cutter.end(2000),
    ];

    assert.deepEqual(
        segments.map((segment) => segment.kind),
        ['init'],
    );
    assert.deepEqual(
        concat(segments.map((segment) => segment.bytes)),
        concat([bad, later]),
    );
    assert.equal(cutter.segmenting, 'blob');
    assert.equal(cutter.initDone(), true);
    assert.deepEqual(reasons, ['parse_error']);
});

test('an MP4 parse error keeps the moof cuts already made and starts the raw groups where they stopped', () => {
    const raw = readSet('webkit-mp4');
    const corrupted = raw.whole.slice();
    corrupted.fill(0, 482968, 482972); // the size of the moof that starts clean media segment 4
    const clean = createBmffCutter(OPTIONS);
    const expected = [...clean.push(raw.whole), ...clean.end()];
    const reasons: string[] = [];
    const cutter = createCutter(raw.mimeType, OPTIONS, (reason) =>
        reasons.push(reason),
    );
    const segments = [...cutter.push(corrupted, 0), ...cutter.end(60_000)];

    assert.deepEqual(
        segments.slice(0, 3).map((segment) => sha256(segment.bytes)),
        expected.slice(0, 3).map((segment) => sha256(segment.bytes)),
    );
    assert.deepEqual(
        concat(segments.map((segment) => segment.bytes)),
        corrupted,
    );
    assert.deepEqual(
        segments.slice(3).map((segment) => [segment.kind, segment.startMs]),
        [['media', expected[3].startMs]],
    );
    assert.equal(cutter.segmenting, 'blob');
    assert.deepEqual(reasons, ['parse_error']);
});
