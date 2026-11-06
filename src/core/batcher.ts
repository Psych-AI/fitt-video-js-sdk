import { backoffMs } from './backoff.ts';
import type { Clock, ClockJump } from './clock.ts';
import type { Environment } from './env.ts';
import type { SdkEvent } from './events.ts';
import { phpJsonBytes } from './events.ts';
import type { WireAnswer } from './http.ts';
import { classify } from './responses.ts';
import type { BatchRecord, QueueStore } from './store.ts';
import type { TokenKeeper } from './token.ts';
import type { TokenRef } from './wire.ts';

/**
 * The event batcher (author's call 11). Every batch is frozen before its
 * first send: `next_batch_seq` is stored first (synchronously too), then
 * the body is built once as a JSON string and stored, and every send of
 * that batch sends the stored string unchanged. The server silently drops
 * a replayed `batch_seq` with new content, so a body that changed between
 * two sends would lose its events.
 */
export interface Batcher {
    add(event: SdkEvent): void;
    /** A timer every batch_ms until stop(). With emptyHeartbeats false only non-empty batches go; a second call switches the mode. */
    startTimer(options: { emptyHeartbeats: boolean }): void;
    /** Freeze what is waiting and send every stored batch. */
    flush(): Promise<void>;
    /** Freeze what is waiting into stored batches (seq persisted first), send nothing. */
    freeze(): Promise<void>;
    /** Freeze what is waiting (synchronously), then send it and the stored batches with keepalive, at most 61,440 body bytes in total. */
    pagehide(): void;
    stop(): void;
}

export interface BatchRejection {
    batch_seq: number;
    code: string;
    status: number;
}

export interface BatcherDeps {
    env: Environment;
    clock: Clock;
    store: QueueStore;
    sessionId: string;
    take(): number;
    /** From the session record; the batcher starts at max(this, readNextBatchSeqSync()). */
    nextBatchSeq: number;
    batchMs: number;
    token: Pick<TokenKeeper, 'current' | 'expired' | 'ready'>;
    send(
        body: string,
        keepalive: boolean,
        token: TokenRef,
    ): Promise<WireAnswer>;
    persistNextBatchSeq(next: number): Promise<void>;
    /** A synchronous copy (localStorage in the browser) that survives a pagehide whose IndexedDB write never commits. */
    persistNextBatchSeqSync(next: number): void;
    readNextBatchSeqSync(): number | null;
    onClosed(code: 'session_closed' | 'discarded'): void;
    /** A batch the server refused for good; never raised as a queued event, which would ride in a batch the same rule refuses. */
    onRejected(rejection: BatchRejection): void;
    /** Called with a jump when the timer's clock check finds one (Task 15 raises session.clock_jump); without it the timer leaves the clock alone. */
    onClockJump?(jump: ClockJump): void;
}

/** The server's 500 events per batch. */
const MAX_EVENTS = 500;

/** Payload bytes per batch: a margin under the server's 1,048,576. */
const MAX_PAYLOAD_BYTES = 1_040_000;

/** The keepalive budget of one page (64 KiB) less headroom. */
const KEEPALIVE_BYTES = 61_440;

const CLOSING_CODES: readonly string[] = ['session_closed', 'discarded'];

interface Waiting {
    event: SdkEvent;
    bytes: number;
}

interface Group {
    events: SdkEvent[];
    bytes: number;
}

interface Frozen {
    batch_seq: number;
    take: number;
    body: string;
}

/** What one answer means for the batch it was sent for. */
type Outcome = 'next' | 'again' | 'stop';

const NETWORK_ERROR: WireAnswer = {
    status: 0,
    body: null,
    networkError: true,
    timedOut: false,
};

function bodyBytes(body: string): number {
    return new TextEncoder().encode(body).byteLength;
}

/** At most 500 events and 1,040,000 payload bytes per batch; one empty group when nothing waits. */
function cut(waiting: Waiting[]): Group[] {
    const groups: Group[] = [];
    let current: Group = { events: [], bytes: 0 };

    for (const { event, bytes } of waiting) {
        if (
            current.events.length > 0 &&
            (current.events.length >= MAX_EVENTS ||
                current.bytes + bytes > MAX_PAYLOAD_BYTES)
        ) {
            groups.push(current);
            current = { events: [], bytes: 0 };
        }

        current.events.push(event);
        current.bytes += bytes;
    }

    groups.push(current);

    return groups;
}

export function createBatcher(deps: BatcherDeps): Batcher {
    const { env, store, sessionId, token } = deps;
    let seq = Math.max(deps.nextBatchSeq, deps.readNextBatchSeqSync() ?? 0);
    let waiting: Waiting[] = [];
    let emptyHeartbeats = false;
    let tickTimer: number | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;
    /** stop() was called: no timer is scheduled any more. */
    let stopped = false;
    /** The server closed the session or its event budget is spent: nothing is sent again. */
    let dead = false;
    let running: Promise<void> | null = null;
    let again = false;
    let readyWait: Promise<void> | null = null;
    let parked = false;

    const clearTimer = (handle: number | null): null => {
        if (handle !== null) {
            env.timers.clearTimeout(handle);
        }

        return null;
    };

    const clearTimers = (): void => {
        tickTimer = clearTimer(tickTimer);
        retryTimer = clearTimer(retryTimer);
    };

    /** One token.ready() at a time, so a keeper that releases only its last waiter still releases this one. */
    const ready = (): Promise<void> => {
        readyWait ??= token.ready().then(() => {
            readyWait = null;
        });

        return readyWait;
    };

    /** Takes a seq and stores the next one first, synchronously, then in the store; returns the frozen body. */
    const reserve = (
        group: Group,
    ): { frozen: Frozen; persisted: Promise<void> } => {
        const batchSeq = seq;
        seq += 1;
        deps.persistNextBatchSeqSync(seq);
        const persisted = deps.persistNextBatchSeq(seq);
        const take = deps.take();
        const body = JSON.stringify({
            take,
            batch_seq: batchSeq,
            sent_at_ms: env.dateNow(),
            clock_epoch_ms: deps.clock.epochMs,
            events: group.events,
        });

        return { frozen: { batch_seq: batchSeq, take, body }, persisted };
    };

    const record = (frozen: Frozen, group: Group): BatchRecord => ({
        session_id: sessionId,
        batch_seq: frozen.batch_seq,
        take: frozen.take,
        body: frozen.body,
        payload_bytes: group.bytes,
    });

    /** Cuts what waits into groups, taking it out of the waiting list at once. */
    const takeWaiting = (includeEmpty: boolean): Group[] => {
        if (waiting.length === 0 && !includeEmpty) {
            return [];
        }

        const taken = waiting;
        waiting = [];

        return cut(taken);
    };

    const freezeGroups = async (groups: Group[]): Promise<void> => {
        for (const group of groups) {
            const { frozen, persisted } = reserve(group);
            await persisted;
            await store.putBatch(record(frozen, group));
        }
    };

    /** Drops everything stored and waiting, and never sends again. */
    const die = async (): Promise<void> => {
        dead = true;
        waiting = [];
        clearTimers();

        for (const batch of await store.listBatches(sessionId)) {
            await store.deleteBatch(sessionId, batch.batch_seq);
        }
    };

    const scheduleRetry = (waitMs: number): void => {
        retryTimer = clearTimer(retryTimer);

        if (stopped || dead) {
            return;
        }

        retryTimer = env.timers.setTimeout(
            () => {
                retryTimer = null;
                void kick();
            },
            Math.max(0, waitMs),
        );
    };

    /** The keeper is paused: send nothing until it holds a new token. */
    const park = (): void => {
        if (parked) {
            return;
        }

        parked = true;
        void ready().then(() => {
            parked = false;

            if (!dead && !stopped) {
                void kick();
            }
        });
    };

    const handle = async (
        batchSeq: number,
        answer: WireAnswer,
        used: TokenRef,
    ): Promise<Outcome> => {
        if (dead) {
            return 'stop';
        }

        if (answer.status >= 200 && answer.status < 300) {
            attempt = 0;
            retryTimer = clearTimer(retryTimer);
            await store.deleteBatch(sessionId, batchSeq);

            return 'next';
        }

        const verdict = classify(answer);

        if (verdict.kind === 'refresh') {
            if (token.expired(used.id) === 'retry') {
                return 'again';
            }

            park();

            return 'stop';
        }

        if (verdict.kind === 'terminal') {
            if (
                verdict.status === 409 &&
                CLOSING_CODES.includes(verdict.code)
            ) {
                await die();
                deps.onClosed(verdict.code as 'session_closed' | 'discarded');

                return 'stop';
            }

            deps.onRejected({
                batch_seq: batchSeq,
                code: verdict.code,
                status: verdict.status,
            });

            if (verdict.code === 'payload_too_large') {
                // Every batch is cut under the per-batch limit, so a 413 can
                // only be the session's event budget: nothing more fits.
                await die();

                return 'stop';
            }

            await store.deleteBatch(sessionId, batchSeq);

            return 'next';
        }

        // retry, blocked and step_down: the bytes stay and the pass waits.
        attempt += 1;
        scheduleRetry(
            verdict.kind === 'retry' && verdict.waitMs !== undefined
                ? verdict.waitMs
                : backoffMs(attempt, env.random()),
        );

        return 'stop';
    };

    const attemptSend = async (
        batchSeq: number,
        body: string,
        keepalive: boolean,
    ): Promise<Outcome> => {
        const used = token.current();
        const answer = await deps
            .send(body, keepalive, used)
            .catch((): WireAnswer => NETWORK_ERROR);

        return handle(batchSeq, answer, used);
    };

    /** One attempt per stored batch, in batch_seq order, until one has to wait. */
    const pass = async (): Promise<void> => {
        for (const batch of await store.listBatches(sessionId)) {
            for (;;) {
                if (dead || parked) {
                    return;
                }

                await ready();

                if (dead) {
                    return;
                }

                const outcome = await attemptSend(
                    batch.batch_seq,
                    batch.body,
                    false,
                );

                if (outcome === 'stop') {
                    return;
                }

                if (outcome === 'next') {
                    break;
                }
            }
        }
    };

    /** Runs a pass, or asks the running one for another round; resolves when the rounds are done. */
    const kick = (): Promise<void> => {
        if (running !== null) {
            again = true;

            return running;
        }

        running = (async () => {
            try {
                do {
                    again = false;
                    await pass();
                } while (again && !dead);
            } finally {
                running = null;
            }
        })();

        return running;
    };

    const checkClock = (): void => {
        if (deps.onClockJump === undefined) {
            return;
        }

        const jump = deps.clock.check();

        if (jump !== null) {
            deps.onClockJump(jump);
        }
    };

    const scheduleTick = (): void => {
        tickTimer = clearTimer(tickTimer);

        if (stopped || dead) {
            return;
        }

        tickTimer = env.timers.setTimeout(tick, deps.batchMs);
    };

    const tick = (): void => {
        tickTimer = null;
        scheduleTick();
        checkClock();
        const groups = takeWaiting(emptyHeartbeats);

        if (groups.length === 0 || dead) {
            return;
        }

        void freezeGroups(groups)
            .then(() => kick())
            .catch((error: unknown) => console.error(error));
    };

    return {
        add(event): void {
            if (dead) {
                return;
            }

            waiting.push({
                event,
                bytes:
                    event.payload === undefined
                        ? 0
                        : phpJsonBytes(event.payload),
            });
        },
        startTimer(options): void {
            emptyHeartbeats = options.emptyHeartbeats;

            if (tickTimer === null && !dead) {
                stopped = false;
                scheduleTick();
            }
        },
        async flush(): Promise<void> {
            if (dead) {
                return;
            }

            await freezeGroups(takeWaiting(false));
            await kick();
        },
        async freeze(): Promise<void> {
            if (dead) {
                return;
            }

            await freezeGroups(takeWaiting(false));
        },
        pagehide(): void {
            if (dead) {
                return;
            }

            let total = 0;
            let full = false;
            const sendKeepalive = (frozen: Frozen): void => {
                const bytes = bodyBytes(frozen.body);

                if (full || total + bytes > KEEPALIVE_BYTES) {
                    full = true;

                    return;
                }

                total += bytes;
                void attemptSend(frozen.batch_seq, frozen.body, true)
                    .then((outcome) => {
                        if (outcome === 'again') {
                            void kick();
                        }
                    })
                    .catch((error: unknown) => console.error(error));
            };
            const frozenNow: Frozen[] = [];

            for (const group of takeWaiting(false)) {
                const { frozen, persisted } = reserve(group);
                void persisted.catch((error: unknown) => console.error(error));
                void store
                    .putBatch(record(frozen, group))
                    .catch((error: unknown) => console.error(error));
                frozenNow.push(frozen);
            }

            // The batches just frozen exist only in memory until IndexedDB
            // commits, so they go first; the stored ones follow in order.
            frozenNow.forEach(sendKeepalive);
            const justFrozen = new Set(frozenNow.map((f) => f.batch_seq));

            void store
                .listBatches(sessionId)
                .then((batches) => {
                    for (const batch of batches) {
                        if (!justFrozen.has(batch.batch_seq)) {
                            sendKeepalive(batch);
                        }
                    }
                })
                .catch((error: unknown) => console.error(error));
        },
        stop(): void {
            stopped = true;
            clearTimers();
        },
    };
}
