/**
 * The review copy (Plan 9, spec 6.10): the playback-track segments of the current take, held in
 * memory only (author's calls 1, 5 and 6). It is never written to any store. The playback track
 * is the camera, else the audio track of an audio-only session (Plan 10, author's call 4).
 *
 * The copy keeps a reference to each playback-track record's `data` buffer as the run adds it, and at
 * `complete()` builds one Blob: a seekable head (`seekableHead()`) followed by the media
 * segments unchanged. A second run, a blob fallback, more bytes than the budget or an init it
 * cannot read turn it off for the take. At most one copy per page holds bytes at a time.
 */

import { seekableHead } from '../cut/seekable.ts';
import type { LocalReason, LocalState } from './state.ts';
import type { SegmentRecord } from './store.ts';

/** `URL.createObjectURL` and `URL.revokeObjectURL`, as a seam. */
export interface ObjectUrls {
    create(blob: Blob): string;
    revoke(url: string): void;
}

/** What the session's state carries about the copy. */
export interface LocalView {
    state: LocalState;
    take: number | null;
    bytes: number;
    reason: LocalReason | null;
    /** Object URLs handed out, ever. */
    objectUrls: number;
    /** Object URLs revoked, ever. */
    revoked: number;
}

export interface LocalCopyDeps {
    sessionId: string;
    /** Why this session never holds a copy, or null when it may. */
    off: 'not_allowed' | 'host_off' | 'unsupported' | null;
    maxBytes: number;
    objectUrls: ObjectUrls | null;
    /** Where pagehide is heard; null outside a browser. */
    win: EventTarget | null;
    onChange(view: LocalView): void;
    /** The playback track whose segments the copy holds (Plan 10, author's call 4). */
    track: 'camera' | 'audio';
}

export interface LocalCopy {
    view(): LocalView;
    add(segment: SegmentRecord, nonKeyframeStart?: boolean): void;
    fellBack(take: number): void;
    complete(take: number, takeStartMs: number | null): void;
    objectUrl(): string | null;
    /** The run anchor minus the take start, in ms: where the copy's time 0 sits in the take. */
    leadInMs(): number;
    durationMs(): number;
    clear(reason: LocalReason): void;
}

interface HeldInit {
    data: ArrayBuffer;
    anchorMs: number;
    mime: string;
}

interface HeldPart {
    data: ArrayBuffer;
    startMs: number;
    durationMs: number;
    nonKeyframeStart: boolean;
}

/** The page's one copy that holds bytes (author's call 6). */
let pageCopy: { sessionId: string; copy: LocalCopy } | null = null;

/** Reasons after which the copy never holds again. */
const RETIRING: readonly LocalReason[] = ['destroy', 'unload', 'next_session'];

/** Clears the page's copy unless it belongs to `sessionId` (author's call 6). */
export function dropPageCopy(sessionId: string, reason: 'next_session'): void {
    if (pageCopy !== null && pageCopy.sessionId !== sessionId) {
        pageCopy.copy.clear(reason);
    }
}

export function createLocalCopy(deps: LocalCopyDeps): LocalCopy {
    let state: LocalState = deps.off === null ? 'empty' : 'off';
    let reason: LocalReason | null = deps.off;
    let take: number | null = null;
    let init: HeldInit | null = null;
    let parts: HeldPart[] = [];
    let bytes = 0;
    let file: Blob | null = null;
    let leadIn = 0;
    let duration = 0;
    let urls: string[] = [];
    let made = 0;
    let revoked = 0;
    let retired = false;
    let listening = false;

    const onPageHide = (): void => copy.clear('unload');

    function view(): LocalView {
        return { state, take, bytes, reason, objectUrls: made, revoked };
    }

    function changed(): void {
        deps.onChange(view());
    }

    function release(): void {
        for (const url of urls) {
            deps.objectUrls?.revoke(url);
            revoked++;
        }

        urls = [];

        if (listening) {
            deps.win?.removeEventListener('pagehide', onPageHide);
            listening = false;
        }

        if (pageCopy !== null && pageCopy.copy === copy) {
            pageCopy = null;
        }
    }

    function drop(): void {
        init = null;
        file = null;
        parts = [];
        bytes = 0;
    }

    function turnOff(why: LocalReason): void {
        release();
        drop();
        state = 'off';
        reason = why;
        changed();
    }

    /**
     * A segment or a fallback of a later take starts the copy over. One of an older take (a late
     * cut of the take before) is ignored, as the session never goes back a take.
     */
    function startOver(nextTake: number): void {
        release();
        drop();
        take = nextTake;
        state = 'empty';
        reason = null;
    }

    function hold(): void {
        if (pageCopy !== null && pageCopy.copy !== copy) {
            pageCopy.copy.clear('next_session');
        }

        pageCopy = { sessionId: deps.sessionId, copy };

        if (deps.win !== null && !listening) {
            deps.win.addEventListener('pagehide', onPageHide);
            listening = true;
        }

        state = 'recording';
    }

    const copy: LocalCopy = {
        view,

        add(segment: SegmentRecord, nonKeyframeStart = false): void {
            if (deps.off !== null || retired || segment.track !== deps.track) {
                return;
            }

            if (take !== null && segment.take < take) {
                return;
            }

            if (segment.take !== take) {
                startOver(segment.take);
            }

            if (state === 'off' || state === 'held' || state === 'cleared') {
                return;
            }

            if (segment.run_index > 0) {
                turnOff('second_run');

                return;
            }

            const data = segment.data;

            if (data === null) {
                turnOff('unreadable');

                return;
            }

            if (segment.kind === 'init') {
                if (segment.init === null) {
                    turnOff('unreadable');

                    return;
                }

                init = {
                    data,
                    anchorMs: segment.init.anchor_ms,
                    mime: segment.init.mime,
                };
            } else {
                if (init === null) {
                    turnOff('unreadable');

                    return;
                }

                parts.push({
                    data,
                    startMs: segment.start_ms - init.anchorMs,
                    durationMs: segment.duration_ms,
                    nonKeyframeStart,
                });
            }

            bytes += data.byteLength;

            if (bytes > deps.maxBytes) {
                turnOff('over_budget');

                return;
            }

            if (state === 'empty') {
                hold();
            }

            changed();
        },

        fellBack(fellBackTake: number): void {
            if (deps.off !== null || retired) {
                return;
            }

            if (take !== null && fellBackTake < take) {
                return;
            }

            if (fellBackTake !== take) {
                startOver(fellBackTake);
            }

            if (state === 'empty' || state === 'recording') {
                turnOff('fallback');
            }
        },

        complete(completedTake: number, takeStartMs: number | null): void {
            if (
                state !== 'recording' ||
                completedTake !== take ||
                init === null
            ) {
                return;
            }

            if (parts.length === 0) {
                turnOff('unreadable');

                return;
            }

            const head = seekableHead(
                init.mime,
                new Uint8Array(init.data),
                parts.map((part) => ({
                    bytes: new Uint8Array(part.data),
                    startMs: part.startMs,
                    durationMs: part.durationMs,
                    nonKeyframeStart: part.nonKeyframeStart,
                })),
            );

            if (head === null) {
                turnOff('unreadable');

                return;
            }

            const last = parts[parts.length - 1];
            duration = last.startMs + last.durationMs;
            leadIn =
                takeStartMs === null
                    ? 0
                    : Math.max(0, init.anchorMs - takeStartMs);
            file = new Blob(
                [head as BlobPart, ...parts.map((part) => part.data)],
                { type: init.mime },
            );
            init = null;
            parts = [];
            bytes = file.size;
            state = 'held';
            changed();
        },

        objectUrl(): string | null {
            if (state !== 'held' || file === null || deps.objectUrls === null) {
                return null;
            }

            const url = deps.objectUrls.create(file);
            urls.push(url);
            made++;
            changed();

            return url;
        },

        leadInMs(): number {
            return leadIn;
        },

        durationMs(): number {
            return duration;
        },

        clear(why: LocalReason): void {
            if (RETIRING.includes(why)) {
                retired = true;
            }

            if (state !== 'recording' && state !== 'held') {
                return;
            }

            release();
            drop();
            state = 'cleared';
            reason = why;
            changed();
        },
    };

    return copy;
}
