import type { DescriptorTrack, DirectUpload, TrackName } from './descriptor.ts';

/**
 * The direct rung's slots (Plan 8). A direct track's `upload.direct` block is
 * one window: a fresh `attempt` with numbered slots, one slot for one whole
 * segment (author's call 1). `s3` and `oss` carry one presigned URL per slot;
 * `cloudfront` carries one signed base and query over the take's direct
 * prefix, so its slot URLs are built here and only `max_slot` bounds them.
 *
 * A window is renewed (author's call 10) when this page did not receive it
 * (a window stored before a reload or a resume may already hold earlier
 * segments in its slots, and its clock is unknown), when its take is not the
 * segment's take, when its slots are used up, or within RENEW_MARGIN_MS of
 * its expiry, measured from the token keeper's receipt time on Date.now().
 * This module only answers 'renew': the uploader renews, at most once per
 * RENEW_GAP_MS per track.
 */

export interface DirectSlot {
    url: string;
    attempt: string;
    slot: number;
    headers: Record<string, string>;
}

/** Renew a window this long before `direct.expires_in_s` runs out. */
export const RENEW_MARGIN_MS = 60_000;

/** At most one renewal per track in this time (author's call 10). */
export const RENEW_GAP_MS = 10_000;

/** The last slot of a base and query window (`video.direct.max_slot`). */
const MAX_SLOT = 9999;

export interface DirectSlots {
    /** The slot of one segment, the same again for its retries within one window; 'renew' when the window cannot serve it; 'none' when the track has no direct block. */
    slotFor(
        track: TrackName,
        key: string,
        take: number,
        sha256: string,
    ): DirectSlot | 'renew' | 'none';
    /** The PUT of this segment answered 2xx or 412: a retry only confirms again. */
    markUploaded(key: string): void;
    uploaded(key: string): boolean;
    /** A size_mismatch: the next attempt PUTs again, to the same slot. */
    markNotUploaded(key: string): void;
    /** The segment is delivered or given up. */
    release(key: string): void;
}

export interface DirectSlotsDeps {
    tracks(): DescriptorTrack[];
    /** Date.now(): the clock the token keeper's receipt time is on, so a reload keeps it. */
    dateNow(): number;
    /** Date.now() when the held descriptor was received (TokenKeeper.receivedAt(), Task 10). */
    receivedAt(): number;
    /** True when this page received the window of this attempt (author's call 10). */
    fresh(attempt: string): boolean;
}

/** The slot URL of a window, or null when the window has no such slot. */
function urlOf(direct: DirectUpload, slot: number): string | null {
    if (direct.slots !== undefined) {
        return slot < direct.slots.length ? direct.slots[slot] : null;
    }

    if (direct.base === undefined || direct.query === undefined) {
        return null;
    }

    return slot <= MAX_SLOT
        ? `${direct.base}${direct.attempt}-${String(slot).padStart(4, '0')}.bin?${direct.query}`
        : null;
}

export function createDirectSlots(deps: DirectSlotsDeps): DirectSlots {
    /** Each segment's slot, by key. */
    const assigned = new Map<string, { attempt: string; slot: number }>();
    /** The next free slot of each track's current window. */
    const next = new Map<TrackName, { attempt: string; slot: number }>();
    const done = new Set<string>();

    const slotOf = (
        direct: DirectUpload,
        slot: number,
        sha256: string,
    ): DirectSlot | null => {
        const url = urlOf(direct, slot);

        if (url === null) {
            return null;
        }

        const headers = { ...direct.headers };

        if (direct.content_sha256) {
            headers['x-amz-content-sha256'] = sha256;
        }

        return { url, attempt: direct.attempt, slot, headers };
    };

    return {
        slotFor(track, key, take, sha256) {
            const direct = deps
                .tracks()
                .find((candidate) => candidate.track === track)?.upload.direct;

            if (direct === undefined) {
                return 'none';
            }

            const held = assigned.get(key);

            // An uploaded object only needs its confirm, which names the
            // attempt and slot it went to, so it keeps them across a renewal.
            // Its URL is empty once its window is gone: it is never PUT again
            // unless markNotUploaded() hands it a new slot.
            if (held !== undefined && done.has(key)) {
                const same =
                    held.attempt === direct.attempt
                        ? slotOf(direct, held.slot, sha256)
                        : null;

                return (
                    same ?? {
                        url: '',
                        attempt: held.attempt,
                        slot: held.slot,
                        headers: {},
                    }
                );
            }

            if (
                !deps.fresh(direct.attempt) ||
                direct.take !== take ||
                deps.dateNow() >=
                    deps.receivedAt() +
                        direct.expires_in_s * 1000 -
                        RENEW_MARGIN_MS
            ) {
                return 'renew';
            }

            if (held !== undefined && held.attempt === direct.attempt) {
                return slotOf(direct, held.slot, sha256) ?? 'renew';
            }

            const cursor = next.get(track);
            const slot =
                cursor !== undefined && cursor.attempt === direct.attempt
                    ? cursor.slot
                    : 0;
            const found = slotOf(direct, slot, sha256);

            if (found === null) {
                return 'renew';
            }

            next.set(track, { attempt: direct.attempt, slot: slot + 1 });
            assigned.set(key, { attempt: direct.attempt, slot });

            return found;
        },
        markUploaded(key) {
            if (assigned.has(key)) {
                done.add(key);
            }
        },
        uploaded(key) {
            return done.has(key);
        },
        markNotUploaded(key) {
            done.delete(key);
        },
        release(key) {
            assigned.delete(key);
            done.delete(key);
        },
    };
}
