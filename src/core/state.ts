import type { ErrorCode } from './errors.ts';

export type Phase =
    | 'idle'
    | 'preparing'
    | 'ready'
    | 'countdown'
    | 'recording'
    | 'stopping'
    | 'stopped'
    | 'rejected'
    | 'error';

/** The review copy's state (Plan 9): off for the session or the take, empty, recording, held as one file, or cleared. */
export type LocalState = 'off' | 'empty' | 'recording' | 'held' | 'cleared';

/** Why the copy is off or was cleared. */
export type LocalReason =
    | 'not_allowed'
    | 'host_off'
    | 'unsupported'
    | 'second_run'
    | 'fallback'
    | 'over_budget'
    | 'unreadable'
    | 'unplayable'
    | 'server'
    | 'next_session'
    | 'reset'
    | 'discard'
    | 'destroy'
    | 'unload';

/** Where the review plays from (Plan 9): nothing yet, waiting for the server file, the local copy, or the server file. */
export type PlaybackSource = 'none' | 'preparing' | 'local' | 'server';

/** The fourth part of the state (spec 6.5, Plan 9). */
export interface PlaybackState {
    source: PlaybackSource;
    local: LocalState;
    localBytes: number;
    localReason: LocalReason | null;
    /** Object URLs of the copy handed out, and how many were revoked. */
    objectUrls: number;
    revoked: number;
}

export interface SessionState {
    phase: Phase;
    upload: {
        bytesSent: number;
        bytesTotal: number;
        backlog: number;
        tracksSealed: number;
        sessionFinalised: boolean;
    };
    checks: {
        status: string;
        verdict: string | null;
        take: number;
        reasons: string[];
        reason?: string;
    } | null;
    error: { code: ErrorCode; detail?: Record<string, unknown> } | null;
    audio: 'ok' | 'silent';
    /** The review (Plan 9, author's call 10): a state part, not a phase. */
    playback: PlaybackState;
}

export interface StateHolder {
    get(): SessionState;
    patch(change: Partial<SessionState>): void;
}

function initialState(): SessionState {
    return {
        phase: 'idle',
        upload: {
            bytesSent: 0,
            bytesTotal: 0,
            backlog: 0,
            tracksSealed: 0,
            sessionFinalised: false,
        },
        checks: null,
        error: null,
        audio: 'ok',
        playback: {
            source: 'none',
            local: 'empty',
            localBytes: 0,
            localReason: null,
            objectUrls: 0,
            revoked: 0,
        },
    };
}

/**
 * The session's state as the host reads it. A patch merges at the top level
 * (so `upload` is replaced whole) and hands onChange a frozen copy; get()
 * returns the same frozen copy, so a host can never change it in place.
 */
export function createState(
    onChange: (state: SessionState) => void,
): StateHolder {
    let current: SessionState = Object.freeze(initialState());

    return {
        get: () => current,
        patch(change: Partial<SessionState>): void {
            current = Object.freeze({ ...current, ...change });
            onChange(current);
        },
    };
}
