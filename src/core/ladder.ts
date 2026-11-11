import type { Transport } from './store.ts';

/**
 * The transport ladder (author's call 9). A refused origin and a blocked
 * preflight both look like an offline TypeError to a page, so the ladder
 * steps down one rung after 2 online network errors in a row, or at once on
 * a 405 or a proxy 403, and never steps back up. The rungs are the direct
 * PUT to the bucket (Plan 8, author's call 10), then the passthrough PUT,
 * then the preflight-free signed POST. `network_blocked` is not terminal: it is set at once on a
 * readable `403 origin_not_allowed`, or when the POST rung fails the same
 * way and no request of the session has ever succeeded.
 */
export type FailureKind = 'network' | 'method' | 'proxy' | 'blocked';

/** The request that failed: when it was sent and answered (env.perfNow()), on which rung, and whether it timed out. */
export interface Attempt {
    startedAtMs: number;
    endedAtMs: number;
    rung: Transport;
    timedOut?: boolean;
}

export interface Ladder {
    rung(): Transport;
    /** True only when it changed the rung or set blocked for the first time; the caller retries at once only then. */
    failure(kind: FailureKind, online: boolean, attempt: Attempt): boolean;
    success(): void;
    /** A 2xx from any other API call: sets everSucceeded and clears a blocked state the failure count set, without resetting the segment failure count. */
    markSucceeded(): void;
    blocked(): boolean;
}

export interface LadderOptions {
    rung: Transport;
    everSucceeded: boolean;
    forcePost?: boolean;
    persist(rung: Transport, everSucceeded: boolean): Promise<void>;
    emit(type: string, payload: Record<string, unknown>): void;
    onBlocked?(): void;
    /** A success or markSucceeded() cleared a blocked state. */
    onUnblocked?(): void;
}

/** Failures in a row that step down one rung, or set blocked on the POST rung. */
const IN_A_ROW = 2;

export function createLadder(options: LadderOptions): Ladder {
    let rung: Transport = options.forcePost ? 'post' : options.rung;
    let everSucceeded = options.everSucceeded;
    let isBlocked = false;
    let count = 0;
    let lastCountedEndMs = Number.NEGATIVE_INFINITY;

    const persist = (): void => {
        options.persist(rung, everSucceeded).catch(() => undefined);
    };

    if (options.forcePost && options.rung !== 'post') {
        persist();
    }

    const block = (): boolean => {
        if (isBlocked) {
            return false;
        }

        isBlocked = true;
        options.onBlocked?.();

        return true;
    };

    const stepDown = (reason: 'network' | 'method' | 'proxy'): boolean => {
        const from = rung;
        rung = from === 'direct' ? 'put' : 'post';
        count = 0;
        options.emit('upload.transport_fallback', {
            from,
            to: rung,
            reason,
        });
        persist();

        return true;
    };

    const succeeded = (): void => {
        if (!everSucceeded) {
            everSucceeded = true;
            persist();
        }

        if (isBlocked) {
            isBlocked = false;
            options.onUnblocked?.();
        }
    };

    /** One more failure in a row, unless it was in flight with the last one counted. */
    const counted = (attempt: Attempt): boolean => {
        if (attempt.startedAtMs < lastCountedEndMs) {
            return false;
        }

        count += 1;
        lastCountedEndMs = attempt.endedAtMs;

        return true;
    };

    return {
        rung: () => rung,
        blocked: () => isBlocked,
        failure(kind, online, attempt) {
            if (kind === 'blocked') {
                return block();
            }

            // A request sent on the old rung says nothing about the new one.
            if (attempt.rung !== rung) {
                return false;
            }

            if (kind === 'method' || kind === 'proxy') {
                if (rung !== 'post') {
                    return stepDown(kind);
                }
            } else if (!online || attempt.timedOut === true) {
                // Offline failures and timeouts neither count nor reset.
                return false;
            }

            if (!counted(attempt) || count < IN_A_ROW) {
                return false;
            }

            if (rung !== 'post') {
                return stepDown('network');
            }

            return everSucceeded ? false : block();
        },
        success() {
            count = 0;
            succeeded();
        },
        markSucceeded() {
            succeeded();
        },
    };
}
