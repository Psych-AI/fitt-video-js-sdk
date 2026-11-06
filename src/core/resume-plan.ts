import type { SessionRecord } from './store.ts';

export type ResumeDecision =
    | 'tombstone'
    | 'purge'
    | 'discard'
    | 'reset'
    | 'resume_expired'
    | 'finalise'
    | 'interrupted';

/**
 * What a stored session becomes after a reload (author's call 15), in this
 * order: a tombstone until it expires; an owed discard, then an owed reset,
 * finished first even past the age limit; a purge past abandon_after_ms
 * without activity; resume_expired once the token lapsed; finalise only
 * after a completed stop() of a take that is closed and not rejected (spec
 * 6.5); otherwise interrupted.
 *
 * A record planned `discard` or `reset` that is also past the age limit keeps
 * only its session record: whoever reads it deletes its runs, segments and
 * batches (Task 15 item 3, Task 15b).
 */
export function planResume(
    record: SessionRecord,
    nowEpochMs: number,
): ResumeDecision {
    if (record.finalised) {
        return record.expires_at_ms !== null &&
            nowEpochMs <= record.expires_at_ms
            ? 'tombstone'
            : 'purge';
    }

    if (record.pending_discard) {
        return 'discard';
    }

    if (record.pending_reset_take !== null) {
        return 'reset';
    }

    if (
        nowEpochMs - record.last_activity_ms >
        record.descriptor.queue.abandon_after_ms
    ) {
        return 'purge';
    }

    if (nowEpochMs >= record.token_expires_at_ms) {
        return 'resume_expired';
    }

    if (
        record.stop_completed &&
        !record.take_open &&
        record.rejected_take !== record.take
    ) {
        return 'finalise';
    }

    return 'interrupted';
}
