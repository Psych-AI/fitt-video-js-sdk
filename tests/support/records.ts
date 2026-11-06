import { readFileSync } from 'node:fs';
import type { Descriptor } from '../../src/core/descriptor.ts';
import type {
    RunRecord,
    SegmentRecord,
    SessionRecord,
} from '../../src/core/store.ts';

/** The session every record builder defaults to. */
export const SID = '01jbz8q4w6x0k3m5n7p9r2t4aa';

/** The run every run and segment builder defaults to. */
export const RUN = '01jbz8q4w6x0k3m5n7p9r2t4v6';

/** A descriptor fixture as DescriptorBuilder writes it (pinned by DescriptorShapeTest). */
export function descriptorFixture(recipe = 'answer'): Descriptor {
    return JSON.parse(
        readFileSync(
            new URL(`../fixtures/descriptor-${recipe}.json`, import.meta.url),
            'utf8',
        ),
    ) as Descriptor;
}

export function sessionRecord(
    overrides: Partial<SessionRecord> = {},
): SessionRecord {
    return {
        session_id: SID,
        descriptor: descriptorFixture(),
        epoch_ms: 1_762_400_000_000,
        take: 1,
        take_start_ms: null,
        take_open: false,
        take_end_ms: null,
        next_batch_seq: 0,
        ladder_rung: 'put',
        ever_succeeded: false,
        stop_completed: false,
        rejected_take: null,
        pending_discard: false,
        last_activity_ms: 1_762_400_000_000,
        token_expires_at_ms: 1_762_400_900_000,
        pending_reset_take: null,
        manifest_owed: {},
        max_session_ms: 0,
        finalised: false,
        expires_at_ms: null,
        ...overrides,
    };
}

export function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
        session_id: SID,
        track: 'camera',
        take: 1,
        run_index: 0,
        run_id: RUN,
        anchor_ms: 12,
        anchor_source: 'performance',
        mime_type: 'video/webm;codecs=vp8,opus',
        started_ms: 10,
        ended_ms: null,
        ended_reason: null,
        segmenting: 'cluster',
        keyframe_option_honoured: null,
        ua: 'Mozilla/5.0 (test)',
        ...overrides,
    };
}

export function segmentRecord(
    overrides: Partial<SegmentRecord> = {},
): SegmentRecord {
    const seq = overrides.seq ?? 1;

    return {
        session_id: SID,
        track: 'camera',
        take: 1,
        run_index: 0,
        run_id: RUN,
        seq,
        kind: seq === 0 ? 'init' : 'media',
        start_ms: seq === 0 ? 12 : 12 + (seq - 1) * 5000,
        duration_ms: seq === 0 ? 0 : 5000,
        recorded_at: 1_762_400_005_000,
        bytes: 300,
        sha256: 'ab'.repeat(32),
        part_count: 1,
        created_ms: 0,
        state: 'pending',
        failures: 0,
        init:
            seq === 0
                ? {
                      anchor_ms: 12,
                      anchor_source: 'performance',
                      mime: 'video/webm;codecs=vp8,opus',
                      started_ms: 10,
                  }
                : null,
        data: new ArrayBuffer(overrides.bytes ?? 300),
        ...overrides,
    };
}
