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
