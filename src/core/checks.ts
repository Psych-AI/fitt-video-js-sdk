import type { TrackName } from './descriptor.ts';
import type { Environment } from './env.ts';
import { FittVideoError } from './errors.ts';
import type { WireAnswer } from './http.ts';

/** reason: the meaningful verdict's free text, present only when the status carries a string checks.reason (owner question 7). */
export interface ChecksResult {
    status: 'pending' | 'done' | 'skipped';
    verdict: 'accept' | 'reject' | 'unknown' | null;
    take: number;
    reasons: string[];
    reason?: string;
}

/** How long the browser waits for a verdict before it settles on a local unknown (spec 6.7). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Polls every second up to here, then every two seconds. */
const FAST_UNTIL_MS = 10_000;
const FAST_MS = 1_000;
const SLOW_MS = 2_000;

const STATUSES: readonly string[] = ['pending', 'done', 'skipped'];
const VERDICTS: readonly string[] = ['accept', 'reject', 'unknown'];

type Value = Record<string, unknown>;

function isObject(value: unknown): value is Value {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The status body of a 200 answer, or null for any other answer (fail open: ignored). */
function statusBody(answer: WireAnswer): Value | null {
    return answer.status === 200 && isObject(answer.body) ? answer.body : null;
}

function readChecks(body: Value): ChecksResult | null {
    const checks = body.checks;

    if (
        !isObject(checks) ||
        typeof checks.status !== 'string' ||
        !STATUSES.includes(checks.status) ||
        typeof checks.take !== 'number'
    ) {
        return null;
    }

    const result: ChecksResult = {
        status: checks.status as ChecksResult['status'],
        verdict:
            typeof checks.verdict === 'string' &&
            VERDICTS.includes(checks.verdict)
                ? (checks.verdict as ChecksResult['verdict'])
                : null,
        take: checks.take,
        reasons: Array.isArray(checks.reasons)
            ? checks.reasons.filter(
                  (reason): reason is string => typeof reason === 'string',
              )
            : [],
    };

    if (typeof checks.reason === 'string') {
        result.reason = checks.reason;
    }

    return result;
}

/**
 * Polls the status at 0, every second until 10 s, then every two seconds,
 * while the elapsed time (on performance.now()) is below `timeoutMs`. A
 * slow answer is never overlapped: the next poll waits for it. `look`
 * returns true once it has settled the wait. When `cancelled` is true at the
 * start of a poll, the wait settles silently: it never resolves or rejects
 * and polls no more (Plan 9, a replaced or destroyed player).
 */
function poll(
    env: Environment,
    status: () => Promise<WireAnswer>,
    timeoutMs: number,
    look: (answer: WireAnswer) => boolean,
    onTimeout: () => void,
    cancelled: () => boolean = () => false,
): void {
    const startedAt = env.perfNow();
    let settled = false;

    const deadline = env.timers.setTimeout(() => {
        if (!settled) {
            settled = true;
            onTimeout();
        }
    }, timeoutMs);

    const once = (pollAt: number): void => {
        if (cancelled()) {
            settled = true;
            env.timers.clearTimeout(deadline);

            return;
        }

        status()
            .catch((): WireAnswer => ({
                status: 0,
                body: null,
                networkError: true,
                timedOut: false,
            }))
            .then((answer) => {
                if (settled) {
                    return;
                }

                if (look(answer)) {
                    settled = true;
                    env.timers.clearTimeout(deadline);

                    return;
                }

                const next =
                    pollAt + (pollAt < FAST_UNTIL_MS ? FAST_MS : SLOW_MS);

                if (next >= timeoutMs) {
                    return;
                }

                env.timers.setTimeout(
                    () => {
                        if (!settled) {
                            once(next);
                        }
                    },
                    Math.max(0, next - (env.perfNow() - startedAt)),
                );
            });
    };

    once(0);
}

/**
 * Waits for the checks verdict of the current take (spec 6.7). Never
 * rejects: network errors and non-200 answers are ignored, and at the
 * timeout the local verdict is `unknown`, which the default policy counts
 * as accept. `onChecks` is called once, with what the promise resolves.
 */
export function waitForChecks(
    deps: {
        env: Environment;
        status(): Promise<WireAnswer>;
        take(): number;
        onChecks(result: ChecksResult): void;
    },
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ChecksResult> {
    return new Promise((resolve) => {
        let lastStatus: ChecksResult['status'] = 'pending';
        const finish = (result: ChecksResult): void => {
            deps.onChecks(result);
            resolve(result);
        };

        poll(
            deps.env,
            () => deps.status(),
            timeoutMs,
            (answer) => {
                const body = statusBody(answer);
                const checks = body === null ? null : readChecks(body);

                if (checks === null || checks.take !== deps.take()) {
                    return false;
                }

                lastStatus = checks.status;

                if (checks.status === 'pending') {
                    return false;
                }

                finish(checks);

                return true;
            },
            () =>
                finish({
                    status: lastStatus,
                    verdict: 'unknown',
                    take: deps.take(),
                    reasons: [],
                }),
        );
    });
}

/**
 * Resolves the playback URL of `track` once the status carries one, polled
 * as waitForChecks() polls. Rejects `playback_not_enabled` as soon as a 200
 * status has no `playback` key (a session created without
 * `playback_in_status`, or any session until Plan 4), and with the same
 * code (detail `{reason: 'timeout'}`) when no URL arrived by `timeoutMs`.
 * Rejects `track_failed` (detail `{reason}`, the track's `failure_reason`) as
 * soon as a status shows the awaited track failed, before it looks for
 * playback. Once `cancelled` returns true it polls no more and never
 * settles.
 */
export function waitForReady(
    deps: { env: Environment; status(): Promise<WireAnswer> },
    track: TrackName,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    cancelled: () => boolean = () => false,
): Promise<string> {
    return new Promise((resolve, reject) => {
        poll(
            deps.env,
            () => deps.status(),
            timeoutMs,
            (answer) => {
                const body = statusBody(answer);

                if (body === null) {
                    return false;
                }

                const tracks = Array.isArray(body.tracks) ? body.tracks : [];
                const awaited = tracks.find(
                    (entry): entry is Record<string, unknown> =>
                        isObject(entry) && entry.track === track,
                );

                if (awaited !== undefined && awaited.status === 'failed') {
                    reject(
                        new FittVideoError('track_failed', {
                            reason:
                                typeof awaited.failure_reason === 'string'
                                    ? awaited.failure_reason
                                    : null,
                        }),
                    );

                    return true;
                }

                if (!('playback' in body)) {
                    reject(new FittVideoError('playback_not_enabled'));

                    return true;
                }

                const playback = body.playback;
                const entry = isObject(playback) ? playback[track] : undefined;

                if (isObject(entry) && typeof entry.url === 'string') {
                    resolve(entry.url);

                    return true;
                }

                return false;
            },
            () =>
                reject(
                    new FittVideoError('playback_not_enabled', {
                        reason: 'timeout',
                    }),
                ),
            cancelled,
        );
    });
}
