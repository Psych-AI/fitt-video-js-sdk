import type { Clock } from './clock.ts';
import type { RecordingLimits } from './descriptor.ts';
import type { Environment } from './env.ts';
import type { ErrorCode } from './errors.ts';
import { FittVideoError } from './errors.ts';
import type { Phase } from './state.ts';

export type MilestoneName =
    | 'countdown_tick'
    | 'countdown_last'
    | 'countdown_cancelled'
    | 'started'
    | 'warning'
    | 'limit_reached'
    | 'forced_stop'
    | 'too_short';

export type ForcedReason = 'limit' | 'left_page' | 'session_cap';

export interface Milestone {
    name: MilestoneName;
    t_ms: number;
    remaining_ms?: number;
    reason?: ForcedReason;
}

export interface TakeEngine {
    startTake(takeStartMs: number): Promise<void>;
    stopTake(): Promise<void>;
}

export interface Lifecycle {
    phase(): Phase;
    setPhase(phase: Phase): void;
    start(): Promise<void>;
    /** The host's stop, or a forced one. */
    stop(options?: {
        sealTracks?: boolean;
        forced?: ForcedReason;
    }): Promise<void>;
    takeStartMs(): number | null;
    /** Set after stop({sealTracks: false}); finalise() seals with it. */
    unsealedEndMs(): number | null;
    /** Continue a take that a reload interrupted (author's call 12). */
    resumeTake(takeStartMs: number): void;
    /**
     * Raises what is due now and sets the timer again. The session calls it
     * when clock.check() reports a jump, because a jump moves the session cap
     * nearer in performance time.
     */
    recheck(): void;
}

export interface LifecycleDeps {
    env: Environment;
    clock: Clock;
    recording: RecordingLimits;
    sessionCapMs: number;
    engine: TakeEngine;
    resetTake(): Promise<void>;
    sealTracks(endMs: number): Promise<void>;
    onMilestone(milestone: Milestone): void;
    onPhase(phase: Phase): void;
    onError(code: ErrorCode): void;
    /** console.warn when absent. */
    warn?(message: string): void;
}

/** The forced stop comes this long before the session cap (author's call 6). */
const CAP_MARGIN_MS = 1000;

/** One countdown step. */
const SECOND_MS = 1000;

/**
 * The timer is never set further ahead than this, so the cap is read again
 * at least once a minute even when nobody calls recheck() after a jump.
 */
const MAX_TIMER_MS = 60_000;

interface CountdownStep {
    name: 'countdown_tick' | 'countdown_last' | 'started';
    /** performance.now() when it is due. */
    at: number;
    remaining_ms?: number;
}

interface Countdown {
    steps: CountdownStep[];
    resolve(): void;
    reject(error: unknown): void;
}

type LimitKind = 'warning' | 'limit' | 'forced_limit' | 'forced_cap';

/**
 * One take's phases and milestones (author's calls 6 and 12). Every
 * milestone's t_ms is clock.now() when it is raised. What is due is measured
 * on performance.now() within the page (author's call 7), so a forward
 * wall-clock correction forces no stop, except for the cap, which runs on
 * session time because the server checks start_ms against it. One timer is
 * set for the next due milestone, and each timer call raises everything due
 * by then, in order, once, so a throttled tab catches up.
 */
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
    const { env, clock, recording, engine } = deps;
    const warn = deps.warn ?? ((message: string) => console.warn(message));
    let phase: Phase = 'idle';
    let timer: number | null = null;
    let countdown: Countdown | null = null;
    /** Settles (never rejects) once the startTake() after `started` has answered. */
    let starting: Promise<void> | null = null;
    let stopping: Promise<void> | null = null;
    let takeStart: number | null = null;
    /** performance.now() at the take's start on this page. */
    let perfAtStart: number | null = null;
    let resumedFrom: number | null = null;
    let unsealedEnd: number | null = null;
    let warningRaised = false;
    let limitRaised = false;

    const moveTo = (next: Phase): void => {
        if (phase === next) {
            return;
        }

        phase = next;
        deps.onPhase(next);
    };

    const raise = (
        name: MilestoneName,
        extra: { remaining_ms?: number; reason?: ForcedReason } = {},
    ): number => {
        const tMs = clock.now();
        deps.onMilestone({ name, t_ms: tMs, ...extra });

        return tMs;
    };

    const clearTimer = (): void => {
        if (timer !== null) {
            env.timers.clearTimeout(timer);
            timer = null;
        }
    };

    const arm = (callback: () => void, delayMs: number): void => {
        clearTimer();
        timer = env.timers.setTimeout(
            () => {
                timer = null;
                callback();
            },
            Math.min(MAX_TIMER_MS, Math.max(0, delayMs)),
        );
    };

    const forgetTake = (): void => {
        takeStart = null;
        perfAtStart = null;
        resumedFrom = null;
        unsealedEnd = null;
    };

    const cancelCountdown = (): void => {
        const pending = countdown;

        if (pending === null) {
            return;
        }

        clearTimer();
        countdown = null;
        raise('countdown_cancelled');
        pending.reject(new FittVideoError('countdown_cancelled'));
    };

    const pumpLimits = (): void => {
        clearTimer();

        if (
            phase !== 'recording' ||
            stopping !== null ||
            perfAtStart === null
        ) {
            return;
        }

        const perfNow = env.perfNow();
        const sessionNow = clock.now();
        const max = recording.max_duration_ms;
        const warningMs = recording.warning_before_end_ms;
        const due: { kind: LimitKind; at: number }[] = [];

        if (warningMs > 0 && !warningRaised) {
            due.push({ kind: 'warning', at: perfAtStart + max - warningMs });
        }

        if (!limitRaised) {
            due.push({ kind: 'limit', at: perfAtStart + max });
        }

        due.push({
            kind: 'forced_limit',
            at: perfAtStart + max + recording.extension_ms,
        });
        due.push({
            kind: 'forced_cap',
            at: perfNow + (deps.sessionCapMs - CAP_MARGIN_MS - sessionNow),
        });
        // Stable, so the take's own limit wins a tie with the cap.
        due.sort((a, b) => a.at - b.at);

        for (const item of due) {
            if (item.at > perfNow) {
                arm(pumpLimits, item.at - perfNow);

                return;
            }

            if (item.kind === 'warning') {
                warningRaised = true;
                raise('warning', { remaining_ms: warningMs });
            } else if (item.kind === 'limit') {
                limitRaised = true;
                raise('limit_reached', {
                    remaining_ms: recording.extension_ms,
                });
            } else {
                const reason =
                    item.kind === 'forced_cap' ? 'session_cap' : 'limit';
                stop({ forced: reason }).catch((error: unknown) =>
                    warn(`The forced stop failed: ${String(error)}`),
                );

                return;
            }
        }
    };

    /** Runs the engine for a take that starts at session time takeStartMs. */
    const begin = (takeStartMs: number, perfStart: number): Promise<void> => {
        takeStart = takeStartMs;
        perfAtStart = perfStart;
        warningRaised = false;
        limitRaised = false;

        const run = (async (): Promise<void> => {
            try {
                await engine.startTake(takeStartMs);
            } catch (error) {
                starting = null;
                takeStart = resumedFrom;
                perfAtStart = null;
                moveTo('ready');

                throw error;
            }

            starting = null;
            resumedFrom = null;
            moveTo('recording');
            pumpLimits();
        })();
        starting = run.then(
            () => undefined,
            () => undefined,
        );

        return run;
    };

    const pumpCountdown = (): void => {
        clearTimer();
        const pending = countdown;

        if (pending === null) {
            return;
        }

        const perfNow = env.perfNow();

        for (
            let step = pending.steps[0];
            step !== undefined && step.at <= perfNow;
            step = pending.steps[0]
        ) {
            pending.steps.shift();

            if (step.name === 'started') {
                countdown = null;
                const startedMs = raise('started');
                begin(startedMs, env.perfNow()).then(
                    pending.resolve,
                    pending.reject,
                );

                return;
            }

            raise(step.name, { remaining_ms: step.remaining_ms });
        }

        const next = pending.steps[0];

        if (next !== undefined) {
            arm(pumpCountdown, next.at - perfNow);
        }
    };

    const start = (): Promise<void> => {
        if (phase !== 'ready' || starting !== null || countdown !== null) {
            return Promise.reject(
                new FittVideoError('invalid_state', { phase }),
            );
        }

        if (resumedFrom !== null) {
            const resumed = resumedFrom;

            return begin(resumed, env.perfNow() - (clock.now() - resumed));
        }

        const countdownMs = recording.countdown_ms;

        if (countdownMs < SECOND_MS) {
            return begin(raise('started'), env.perfNow());
        }

        const perf0 = env.perfNow();
        const steps: CountdownStep[] = [];

        for (let k = 0; countdownMs - k * SECOND_MS > SECOND_MS; k++) {
            steps.push({
                name: 'countdown_tick',
                at: perf0 + k * SECOND_MS,
                remaining_ms: countdownMs - k * SECOND_MS,
            });
        }

        steps.push({
            name: 'countdown_last',
            at: perf0 + countdownMs - SECOND_MS,
            remaining_ms: SECOND_MS,
        });
        steps.push({ name: 'started', at: perf0 + countdownMs });
        moveTo('countdown');

        return new Promise<void>((resolve, reject) => {
            countdown = { steps, resolve, reject };
            pumpCountdown();
        });
    };

    const finishTake = async (options: {
        sealTracks?: boolean;
        forced?: ForcedReason;
    }): Promise<void> => {
        clearTimer();
        const endMs = clock.now();
        const elapsedMs = endMs - (takeStart ?? endMs);
        const minMs = recording.min_duration_ms;

        if (options.forced === undefined && elapsedMs < minMs) {
            moveTo('stopping');
            await engine.stopTake();
            raise('too_short');

            try {
                await deps.resetTake();
                forgetTake();
                moveTo('ready');
            } catch (error) {
                warn(
                    `The take was too short, but its reset was refused: ${String(error)}`,
                );
                moveTo('stopped');
            }

            throw new FittVideoError('too_short', {
                duration_ms: elapsedMs,
                min_duration_ms: minMs,
            });
        }

        if (options.forced !== undefined) {
            raise('forced_stop', { reason: options.forced });

            if (options.forced === 'session_cap') {
                deps.onError('session_cap_reached');
            }
        }

        moveTo('stopping');
        await engine.stopTake();

        if (options.sealTracks === false) {
            unsealedEnd = endMs;
        } else {
            await deps.sealTracks(endMs);
        }

        moveTo('stopped');
    };

    const stop = (
        options: { sealTracks?: boolean; forced?: ForcedReason } = {},
    ): Promise<void> => {
        if (stopping !== null) {
            return stopping;
        }

        if (starting !== null) {
            // `started` was raised and the engine is still starting: stop the take once it runs.
            return starting.then(() => stop(options));
        }

        if (countdown !== null) {
            cancelCountdown();
            moveTo('ready');

            return Promise.resolve();
        }

        if (phase !== 'recording') {
            return Promise.resolve();
        }

        const finishing = finishTake(options).finally(() => {
            stopping = null;
        });
        stopping = finishing;

        return finishing;
    };

    return {
        phase: () => phase,
        setPhase(next: Phase): void {
            if (next !== 'countdown') {
                cancelCountdown();
            }

            if (next !== 'recording') {
                clearTimer();
            }

            if (
                next === 'ready' &&
                (phase === 'stopped' || phase === 'rejected')
            ) {
                forgetTake();
            }

            moveTo(next);
        },
        start,
        stop,
        takeStartMs: () => takeStart,
        unsealedEndMs: () => unsealedEnd,
        resumeTake(takeStartMs: number): void {
            resumedFrom = takeStartMs;
            takeStart = takeStartMs;
        },
        recheck(): void {
            if (countdown !== null) {
                pumpCountdown();
            } else if (starting === null) {
                pumpLimits();
            }
        },
    };
}
