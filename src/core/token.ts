import { backoffMs } from './backoff.ts';
import type { Descriptor } from './descriptor.ts';
import { readDescriptor } from './descriptor.ts';
import type { Environment } from './env.ts';
import type { WireAnswer } from './http.ts';
import { classify } from './responses.ts';
import type { TokenRef } from './wire.ts';

/**
 * Keeps the session's upload token fresh (author's call 10). The refresh
 * deadline is an epoch time measured on Date.now() from the stored receipt
 * time, so a reload keeps it. Platform timers stop while a laptop sleeps or
 * an iOS page is frozen, so the session also calls check(), which refreshes
 * at once once Date.now() has passed the deadline.
 */
export interface TokenKeeper {
    current(): TokenRef;
    /** Ignores a descriptor whose token.id is not greater than the held one (ULIDs sort by issue time); true when accepted. */
    set(descriptor: Descriptor): boolean;
    /** A request made with token `usedId` got 401 token_expired. */
    expired(usedId: string): 'retry' | 'paused';
    ready(): Promise<void>;
    /** Refreshes at once when Date.now() has passed the stored deadline; cheap when it has not. */
    check(): void;
    /**
     * Refreshes at once, or waits for the refresh in flight (the direct
     * rung's window renewal, author's call 10). Resolves at once while the
     * keeper is stopped, gone, paused or backing off.
     */
    renew(): Promise<void>;
    /** Date.now() when the held descriptor was received. */
    receivedAt(): number;
    /** Waits for a refresh in flight and passes its accepted descriptor to onDescriptor before it resolves; schedules nothing after. */
    stop(): Promise<void>;
}

export interface TokenKeeperDeps {
    env: Environment;
    descriptor: Descriptor;
    /** Date.now() when the descriptor's token was received; default env.dateNow(). */
    receivedAtMs?: number;
    refresh(token: TokenRef): Promise<WireAnswer>;
    onDescriptor(descriptor: Descriptor): void;
    emit(type: string, payload: Record<string, unknown>): void;
    setError(code: 'token_expired' | 'token_refresh_blocked' | null): void;
}

type KeeperError = 'token_expired' | 'token_refresh_blocked' | null;

/** Refresh network errors in a row that mean the network blocks the preflight. */
const BLOCKED_AFTER = 2;

/** Seconds before expiry by which the refresh is due at the latest. */
const EXPIRY_MARGIN_S = 60;

/** The 409 codes after which no refresh can ever succeed. */
const GONE_CODES: readonly string[] = ['session_closed', 'discarded'];

function tokenOf(descriptor: Descriptor): TokenRef {
    return { id: descriptor.token.id, secret: descriptor.token.secret };
}

function descriptorIn(body: unknown): Descriptor | null {
    if (typeof body !== 'object' || body === null || !('descriptor' in body)) {
        return null;
    }

    const result = readDescriptor(body.descriptor);

    return result.ok ? result.descriptor : null;
}

export function createTokenKeeper(deps: TokenKeeperDeps): TokenKeeper {
    const { env } = deps;
    let held = deps.descriptor;
    let receivedAtMs = deps.receivedAtMs ?? env.dateNow();
    let timer: number | null = null;
    let waitingOnBackoff = false;
    let inFlight: Promise<void> | null = null;
    let attempt = 0;
    let networkErrorsInRow = 0;
    let blocked = false;
    let paused = false;
    let gone = false;
    let stopped = false;
    let shownError: KeeperError = null;
    let waiters: (() => void)[] = [];

    const deadlineMs = (): number =>
        receivedAtMs +
        Math.min(
            held.token.refresh_after_s,
            held.token.expires_in_s - EXPIRY_MARGIN_S,
        ) *
            1000;

    const cancel = (): void => {
        if (timer !== null) {
            env.timers.clearTimeout(timer);
            timer = null;
        }

        waitingOnBackoff = false;
    };

    /** Reports the keeper's own error only when it changes. */
    const syncError = (): void => {
        const wanted: KeeperError = paused
            ? 'token_expired'
            : blocked
              ? 'token_refresh_blocked'
              : null;

        if (wanted !== shownError) {
            shownError = wanted;
            deps.setError(wanted);
        }
    };

    const pause = (): void => {
        if (paused) {
            return;
        }

        paused = true;
        cancel();
        syncError();
        deps.emit('upload.refresh_failed', { code: 'token_expired' });
    };

    const schedule = (delayMs: number, isBackoff: boolean): void => {
        cancel();

        if (stopped || gone || paused) {
            return;
        }

        waitingOnBackoff = isBackoff;
        timer = env.timers.setTimeout(
            () => {
                timer = null;
                waitingOnBackoff = false;
                start();
            },
            Math.max(0, delayMs),
        );
    };

    const scheduleDeadline = (): void => {
        schedule(deadlineMs() - env.dateNow(), false);
    };

    /** A deadline timer that fired while a refresh was out is set again. */
    const keepDeadline = (): void => {
        if (timer === null) {
            scheduleDeadline();
        }
    };

    const backOff = (): void => {
        attempt += 1;
        schedule(backoffMs(attempt, env.random()), true);
    };

    const accept = (descriptor: Descriptor): boolean => {
        if (descriptor.token.id.toLowerCase() <= held.token.id.toLowerCase()) {
            return false;
        }

        held = descriptor;
        receivedAtMs = env.dateNow();
        deps.onDescriptor(descriptor);

        if (paused) {
            paused = false;
            const resolved = waiters;
            waiters = [];
            resolved.forEach((resolve) => resolve());
        }

        syncError();

        scheduleDeadline();

        return true;
    };

    const answered = (answer: WireAnswer, used: TokenRef): void => {
        const renewed =
            answer.status === 201 ? descriptorIn(answer.body) : null;

        if (renewed !== null) {
            attempt = 0;
            networkErrorsInRow = 0;
            blocked = false;

            if (!accept(renewed)) {
                // A newer token arrived while this refresh was out.
                syncError();
                keepDeadline();
            }

            return;
        }

        if (stopped || used.id.toLowerCase() !== held.token.id.toLowerCase()) {
            // Stopped, or a newer token arrived while this refresh was out:
            // this answer decides nothing.
            keepDeadline();

            return;
        }

        if (answer.networkError && !answer.timedOut) {
            networkErrorsInRow += 1;

            if (networkErrorsInRow >= BLOCKED_AFTER && !blocked) {
                blocked = true;
                syncError();
                deps.emit('upload.refresh_failed', { code: 'network' });
            }
        } else if (answer.status > 0) {
            networkErrorsInRow = 0;
        }

        const verdict = classify(answer);

        if (verdict.kind === 'refresh') {
            expired(used.id);

            return;
        }

        if (
            verdict.kind === 'terminal' &&
            verdict.status === 409 &&
            GONE_CODES.includes(verdict.code)
        ) {
            gone = true;
            cancel();

            return;
        }

        if (verdict.kind === 'retry' && verdict.waitMs !== undefined) {
            schedule(verdict.waitMs, true);

            return;
        }

        backOff();
    };

    const start = (): void => {
        if (stopped || gone || paused || inFlight !== null) {
            return;
        }

        cancel();
        const used = current();
        inFlight = deps
            .refresh(used)
            .catch((): WireAnswer => ({
                status: 0,
                body: null,
                networkError: false,
                timedOut: false,
            }))
            .then((answer) => {
                inFlight = null;
                answered(answer, used);
            });
    };

    const current = (): TokenRef => tokenOf(held);

    const expired = (usedId: string): 'retry' | 'paused' => {
        if (current().id.toLowerCase() !== usedId.toLowerCase()) {
            return 'retry';
        }

        pause();

        return 'paused';
    };

    if (receivedAtMs + held.token.expires_in_s * 1000 <= env.dateNow()) {
        // A stored record after a long absence: strict mode would refuse a
        // refresh with this token, so wait for the host to hand a new one.
        pause();
    } else {
        scheduleDeadline();
    }

    return {
        current,
        set: accept,
        expired,
        ready(): Promise<void> {
            if (!paused) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                waiters.push(resolve);
            });
        },
        check(): void {
            if (
                stopped ||
                gone ||
                paused ||
                inFlight !== null ||
                waitingOnBackoff
            ) {
                return;
            }

            if (env.dateNow() >= deadlineMs()) {
                start();
            }
        },
        renew(): Promise<void> {
            if (stopped || gone || paused || waitingOnBackoff) {
                return Promise.resolve();
            }

            start();

            return inFlight ?? Promise.resolve();
        },
        receivedAt(): number {
            return receivedAtMs;
        },
        async stop(): Promise<void> {
            stopped = true;
            cancel();

            if (inFlight !== null) {
                await inFlight;
            }
        },
    };
}
