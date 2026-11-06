import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest } from '../../src/core/manifest.ts';
import type { SegmentRecord } from '../../src/core/store.ts';
import { runRecord, segmentRecord } from '../support/records.ts';

const A = '01jbz8q4w6x0k3m5n7p9r2t4va';
const B = '01jbz8q4w6x0k3m5n7p9r2t4vb';
const sha = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const RUNS = [
    runRecord({
        run_id: A,
        run_index: 0,
        anchor_ms: 3012,
        started_ms: 3010,
        ended_ms: 13_000,
        ended_reason: 'device_switch',
        keyframe_option_honoured: true,
        ua: 'U'.repeat(600),
    }),
    runRecord({
        run_id: B,
        run_index: 1,
        anchor_ms: 13_050,
        started_ms: 13_040,
        ended_ms: 25_000,
        ended_reason: 'stop',
        keyframe_option_honoured: null,
        ua: 'U'.repeat(600),
    }),
];
const SEGMENTS: SegmentRecord[] = [
    segmentRecord({
        run_id: A,
        run_index: 0,
        seq: 0,
        start_ms: 3012,
        duration_ms: 0,
        bytes: 189,
        sha256: sha(1),
        state: 'delivered',
        data: null,
    }),
    segmentRecord({
        run_id: A,
        run_index: 0,
        seq: 1,
        start_ms: 3012,
        duration_ms: 5000,
        bytes: 1000,
        sha256: sha(2),
        state: 'pending',
    }),
    segmentRecord({
        run_id: A,
        run_index: 0,
        seq: 2,
        start_ms: 8012,
        duration_ms: 4000,
        bytes: 1000,
        sha256: sha(3),
        state: 'abandoned',
        data: null,
    }),
    segmentRecord({
        run_id: A,
        run_index: 0,
        seq: 3,
        start_ms: 12_012,
        duration_ms: 988,
        bytes: 1000,
        sha256: sha(4),
        state: 'dropped',
        data: null,
    }),
    segmentRecord({
        run_id: B,
        run_index: 1,
        seq: 0,
        start_ms: 13_050,
        duration_ms: 0,
        bytes: 189,
        sha256: sha(5),
        state: 'delivered',
        data: null,
    }),
    segmentRecord({
        run_id: B,
        run_index: 1,
        seq: 1,
        start_ms: 13_050,
        duration_ms: 5000,
        bytes: 1000,
        sha256: sha(6),
        state: 'rejected',
        data: null,
    }),
    segmentRecord({
        run_id: B,
        run_index: 1,
        seq: 2,
        start_ms: 18_050,
        duration_ms: 6950,
        bytes: 6_000_000,
        sha256: sha(7),
        state: 'pending',
    }),
];

test('two runs give the exact manifest body, every seq listed', () => {
    const body = buildManifest({
        take: 1,
        takeStartMs: 3000,
        endMs: 25_000,
        partSize: 5_242_880,
        runs: RUNS,
        segments: SEGMENTS,
    });
    const run = (r: (typeof RUNS)[number]) => ({
        run_id: r.run_id,
        anchor_ms: r.anchor_ms,
        anchor_source: 'performance',
        mime_type: 'video/webm;codecs=vp8,opus',
        started_ms: r.started_ms,
        ended_ms: r.ended_ms,
        ended_reason: r.ended_reason,
        segmenting: 'cluster',
        ua: 'U'.repeat(512),
    });

    assert.deepEqual(body, {
        take: 1,
        take_start_ms: 3000,
        end_ms: 25_000,
        runs: [
            { ...run(RUNS[0]), keyframe_option_honoured: true },
            run(RUNS[1]),
        ],
        segments: [
            {
                run_id: A,
                seq: 0,
                kind: 'init',
                start_ms: 3012,
                duration_ms: 0,
                bytes: 189,
                sha256: sha(1),
                status: 'expected',
            },
            {
                run_id: A,
                seq: 1,
                kind: 'media',
                start_ms: 3012,
                duration_ms: 5000,
                bytes: 1000,
                sha256: sha(2),
                status: 'expected',
            },
            {
                run_id: A,
                seq: 2,
                kind: 'media',
                start_ms: 8012,
                duration_ms: 4000,
                bytes: 1000,
                sha256: sha(3),
                status: 'abandoned',
            },
            {
                run_id: A,
                seq: 3,
                kind: 'media',
                start_ms: 12_012,
                duration_ms: 988,
                bytes: 1000,
                sha256: sha(4),
                status: 'expected',
            },
            {
                run_id: B,
                seq: 0,
                kind: 'init',
                start_ms: 13_050,
                duration_ms: 0,
                bytes: 189,
                sha256: sha(5),
                status: 'expected',
            },
            {
                run_id: B,
                seq: 1,
                kind: 'media',
                start_ms: 13_050,
                duration_ms: 5000,
                bytes: 1000,
                sha256: sha(6),
                status: 'abandoned',
            },
            {
                run_id: B,
                seq: 2,
                kind: 'media',
                start_ms: 18_050,
                duration_ms: 6950,
                bytes: 6_000_000,
                sha256: sha(7),
                part_count: 2,
                status: 'expected',
            },
        ],
    });
});

test('a delivered seq is still listed on a re-post, and a rejected seq 0 stays expected', () => {
    const body = buildManifest({
        take: 1,
        takeStartMs: null,
        endMs: 10_000,
        partSize: 5_242_880,
        runs: [RUNS[0]],
        segments: [
            segmentRecord({ run_id: A, seq: 0, state: 'rejected', data: null }),
            segmentRecord({
                run_id: A,
                seq: 1,
                state: 'delivered',
                data: null,
            }),
        ],
    });

    assert.deepEqual(
        body.segments.map((s) => [s.seq, s.status]),
        [
            [0, 'expected'],
            [1, 'expected'],
        ],
    );
    assert.equal('take_start_ms' in body, false);
});

test('an abandoned seq 0 is still listed expected, because the server never accepts it abandoned', () => {
    const body = buildManifest({
        take: 1,
        takeStartMs: 0,
        endMs: 1,
        partSize: 5_242_880,
        runs: [RUNS[0]],
        segments: [
            segmentRecord({
                run_id: A,
                seq: 0,
                state: 'abandoned',
                data: null,
            }),
        ],
    });

    assert.deepEqual(
        body.segments.map((s) => [s.seq, s.status]),
        [[0, 'expected']],
    );
});
