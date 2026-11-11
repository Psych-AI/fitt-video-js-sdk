import { backoffMs } from './backoff.ts';
import { sha256Hex } from './crypto.ts';
import type { DescriptorTrack, TrackName } from './descriptor.ts';
import { createDirectSlots, RENEW_GAP_MS } from './direct.ts';
import type { Environment } from './env.ts';
import { send } from './http.ts';
import type { FailureKind, Ladder } from './ladder.ts';
import { partCount, partsOf } from './parts.ts';
import type { Queue } from './queue.ts';
import { classify, classifyDirect } from './responses.ts';
import type {
    QueueStore,
    SegmentKey,
    SegmentRecord,
    Transport,
} from './store.ts';
import type { TokenKeeper } from './token.ts';
import type { SegmentMeta, TokenRef, WireRequest } from './wire.ts';
import { directPut, segmentConfirm, segmentPost, segmentPut } from './wire.ts';

/**
 * The uploader (author's call 8): one lane per track, each sending its
 * segments in order with at most two in flight. A segment is given up only
 * by the queue's age or budget rules, never by its failure count. Every
 * store write is conditional on the record still being pending, so an
 * answer that lands after the sweep abandoned a record writes nothing back.
 *
 * On the direct rung (Plan 8) a whole segment is PUT to a slot of its
 * track's window with no token (author's calls 1 and 2), then confirmed to
 * the API with the token; the confirm's answer is read as a passthrough
 * answer. A window that cannot serve a segment is renewed through the token
 * keeper, at most once per RENEW_GAP_MS per track (author's call 10).
 */
export interface UploadStats {
    bytesSent: number;
    bytesTotal: number;
    backlog: number;
}

export interface Uploader {
    enqueue(record: SegmentRecord): void;
    start(): void;
    /** Aborts every request in flight through its AbortController and ignores their answers; no store write happens after it resolves. */
    stop(): Promise<void>;
    /** Debug hook (author's call 14): the next segment of the track is dropped locally and listed expected. */
    dropNext(track?: TrackName): void;
    /** After a reset: removes every lane record of an earlier take (the session deletes them from the store). */
    dropTakesBelow(take: number): void;
    /** Resolves when nothing for the track (or any track) is pending or in flight. */
    idle(track?: TrackName): Promise<void>;
    stats(): UploadStats;
}

export interface UploaderDeps {
    env: Environment;
    store: QueueStore;
    queue: Queue;
    now(): number;
    tracks(): DescriptorTrack[];
    token: TokenKeeper;
    ladder: Ladder;
    emit(type: string, payload: Record<string, unknown>): void;
    /** A segment of `take` was abandoned or rejected: the session may re-post that take's manifest. */
    onAbandon(track: TrackName, take: number): void;
    /** The session's local take. */
    currentTake(): number;
    /** A stale_take for the current local take: the server is on `currentTake`, so the local state is behind. */
    onTakeBehind(currentTake: number): void;
    /** console.warn in the browser (the local_corrupt warning). */
    warn(message: string): void;
    /** True when this page received the direct window of `attempt` (author's call 10); default never, so every window is renewed before use. */
    freshAttempt?(attempt: string): boolean;
}

/** Segments of one track sent at the same time. */
export const MAX_IN_FLIGHT = 2;

/** A request that has not answered by then is aborted and tried again. */
export const SEND_TIMEOUT_MS = 30_000;

/** How often the sweep runs and the backlog is reported. */
const TICK_MS = 1000;

/** Two attempts of one request never start in the same millisecond, so an answer that comes back at once cannot spin a lane. */
const MIN_GAP_MS = 1;

/** What a waiting attempt waits for. An `online` event ends the offline and network waits early. */
type Wait = 'backoff' | 'network' | 'offline' | 'token';

interface Part {
    index: number;
    count: number;
    bytes: ArrayBuffer;
    sha256: string;
}

interface Entry {
    key: SegmentKey;
    bytes: number;
    active: boolean;
    cancelled: boolean;
    /** env.perfNow() before which the lane does not start it again. */
    restUntil: number;
    wait: Wait | null;
    wake: (() => void) | null;
}

interface Lane {
    track: TrackName;
    /** Waiting and in-flight records, in take, run_index, seq order. */
    entries: Entry[];
    active: number;
    /** Store writes the lane made outside an attempt (a dropped record). */
    chores: number;
    reportedBacklog: number;
}

type Outcome = 'remove' | 'keep';

/** A segment's key among the direct slots. */
function directKeyOf(key: SegmentKey): string {
    return `${key.track}:${key.take}:${key.run_index}:${key.seq}`;
}

function keyOf(record: SegmentKey): SegmentKey {
    return {
        session_id: record.session_id,
        track: record.track,
        take: record.take,
        run_index: record.run_index,
        seq: record.seq,
    };
}

function sameKey(a: SegmentKey, b: SegmentKey): boolean {
    return (
        a.session_id === b.session_id &&
        a.track === b.track &&
        a.take === b.take &&
        a.run_index === b.run_index &&
        a.seq === b.seq
    );
}

function order(a: SegmentKey, b: SegmentKey): number {
    return a.take - b.take || a.run_index - b.run_index || a.seq - b.seq;
}

/** `error.current_take` from a stale_take envelope, or null. */
function serverTakeIn(body: unknown): number | null {
    if (typeof body !== 'object' || body === null) {
        return null;
    }

    const error = (body as { error?: unknown }).error;

    if (typeof error !== 'object' || error === null) {
        return null;
    }

    const take = (error as { current_take?: unknown }).current_take;

    return typeof take === 'number' && Number.isInteger(take) ? take : null;
}

function metaOf(record: SegmentRecord, part: Part): SegmentMeta {
    return {
        take: record.take,
        run: record.run_id,
        seq: record.seq,
        kind: record.kind,
        startMs: record.start_ms,
        durationMs: record.duration_ms,
        recordedAt: record.recorded_at,
        sha256: record.sha256,
        ...(part.count > 1
            ? {
                  part: {
                      index: part.index,
                      count: part.count,
                      sha256: part.sha256,
                  },
              }
            : {}),
        ...(record.init !== null
            ? {
                  init: {
                      anchorMs: record.init.anchor_ms,
                      anchorSource: record.init.anchor_source,
                      mime: record.init.mime,
                      startedMs: record.init.started_ms,
                  },
              }
            : {}),
    };
}

/**
 * True when an ok answer to one part of a split segment shows the server
 * still lacks some of its parts: `already_present` for a part it holds,
 * with the segment still `expected` (or `missing`, sealed while expected),
 * or with fewer parts present than the count. Any other status (present,
 * or corrupt and closed to parts) means more parts would change nothing.
 */
function partsMissingIn(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) {
        return false;
    }

    const segment = (body as { segment?: unknown }).segment;

    if (typeof segment !== 'object' || segment === null) {
        return false;
    }

    const {
        status,
        parts_present: present,
        part_count: count,
    } = segment as {
        status?: unknown;
        parts_present?: unknown;
        part_count?: unknown;
    };

    if (status === 'expected' || status === 'missing') {
        return true;
    }

    return (
        status === undefined &&
        typeof present === 'number' &&
        typeof count === 'number' &&
        present < count
    );
}

/** True when the stored bytes no longer match the record: the local copy is corrupt. */
async function corrupt(record: SegmentRecord): Promise<boolean> {
    if (record.data === null || record.data.byteLength !== record.bytes) {
        return true;
    }

    return (await sha256Hex(record.data)) !== record.sha256.toLowerCase();
}

export function createUploader(deps: UploaderDeps): Uploader {
    const { env, store, queue, token, ladder } = deps;
    const lanes = new Map<TrackName, Lane>();
    const halted = new Set<number>();
    const counted = new Set<string>();
    const drops = new Map<TrackName | '*', number>();
    const warnedTracks = new Set<TrackName>();
    const flights = new Set<Promise<unknown>>();
    const writes = new Set<Promise<unknown>>();
    let idleWaiters: { track?: TrackName; resolve: () => void }[] = [];
    let started = false;
    let stopped = false;
    let floorTake = Number.NEGATIVE_INFINITY;
    let bytesTotal = 0;
    let bytesSent = 0;
    let tickTimer: number | null = null;
    let sweeping: Promise<void> | null = null;
    const slots = createDirectSlots({
        tracks: deps.tracks,
        dateNow: () => env.dateNow(),
        receivedAt: () => token.receivedAt(),
        fresh: (attempt) => deps.freshAttempt?.(attempt) ?? false,
    });
    /** env.perfNow() of each track's last window renewal. */
    const renewedAt = new Map<TrackName, number>();

    /** One controller for the whole uploader: stop() aborts every request still out. */
    const stopping = new AbortController();
    const sendEnv: Environment = {
        ...env,
        fetch(url: string, init: RequestInit): Promise<Response> {
            const controller = new AbortController();
            const timeout = init.signal ?? null;
            const abort = (): void => controller.abort();

            if (timeout?.aborted === true || stopping.signal.aborted) {
                abort();
            }

            timeout?.addEventListener('abort', abort);
            stopping.signal.addEventListener('abort', abort);

            return env
                .fetch(url, { ...init, signal: controller.signal })
                .finally(() => {
                    timeout?.removeEventListener('abort', abort);
                    stopping.signal.removeEventListener('abort', abort);
                });
        },
    };

    const tracked = <T>(set: Set<Promise<unknown>>, promise: Promise<T>) => {
        set.add(promise);
        promise.then(
            () => set.delete(promise),
            () => set.delete(promise),
        );

        return promise;
    };

    /** A store write only while the record is still pending, and never once stop() was called; undefined when it is not written. */
    const update = (
        key: SegmentKey,
        change: (current: SegmentRecord) => SegmentRecord,
    ): Promise<SegmentRecord | undefined> =>
        stopped
            ? Promise.resolve(undefined)
            : tracked(
                  writes,
                  store.updateSegment(key, (current) =>
                      current.state === 'pending' ? change(current) : undefined,
                  ),
              );

    const laneOf = (track: TrackName): Lane => {
        let lane = lanes.get(track);

        if (lane === undefined) {
            lane = {
                track,
                entries: [],
                active: 0,
                chores: 0,
                reportedBacklog: 0,
            };
            lanes.set(track, lane);
        }

        return lane;
    };

    const isIdle = (track?: TrackName): boolean =>
        [...lanes.values()]
            .filter((lane) => track === undefined || lane.track === track)
            .every((lane) => lane.entries.length === 0 && lane.chores === 0);

    const notifyIdle = (): void => {
        idleWaiters = idleWaiters.filter((waiter) => {
            if (!isIdle(waiter.track)) {
                return true;
            }

            waiter.resolve();

            return false;
        });
    };

    const removeEntry = (lane: Lane, entry: Entry): void => {
        lane.entries = lane.entries.filter((other) => other !== entry);
    };

    /** Takes the entry out of its lane and ends whatever its attempt is waiting on. */
    const cancel = (lane: Lane, entry: Entry): void => {
        entry.cancelled = true;
        removeEntry(lane, entry);
        entry.wake?.();
        notifyIdle();
    };

    const waitFor = (
        entry: Entry,
        wait: Wait,
        begin: (end: () => void) => (() => void) | void,
    ): Promise<void> =>
        new Promise<void>((resolve) => {
            if (stopped || entry.cancelled) {
                resolve();

                return;
            }

            let done = false;
            let cleanup: (() => void) | void = undefined;
            const end = (): void => {
                if (done) {
                    return;
                }

                done = true;
                entry.wait = null;
                entry.wake = null;
                cleanup?.();
                resolve();
            };

            entry.wait = wait;
            entry.wake = end;
            cleanup = begin(end);
        });

    const sleep = (entry: Entry, ms: number, wait: Wait): Promise<void> => {
        if (ms <= 0) {
            return Promise.resolve();
        }

        return waitFor(entry, wait, (end) => {
            const handle = env.timers.setTimeout(end, ms);

            return () => env.timers.clearTimeout(handle);
        });
    };

    const whenOnline = (entry: Entry): Promise<void> =>
        env.online()
            ? Promise.resolve()
            : waitFor(entry, 'offline', () => undefined);

    const whenTokenReady = (entry: Entry): Promise<void> =>
        waitFor(entry, 'token', (end) => {
            token.ready().then(end, end);
        });

    /** The segment URL (always the passthrough URL, author's call 9), the part size and the confirm URL of a track. */
    const targetOf = (
        track: TrackName,
    ): { url: string; partSize: number; confirmUrl: string | null } | null => {
        const found = deps
            .tracks()
            .find((candidate) => candidate.track === track);

        if (found === undefined) {
            return null;
        }

        return {
            url: found.upload.fallback_url ?? found.upload.url,
            partSize: found.segments.part_size,
            confirmUrl: found.upload.confirm_url ?? null,
        };
    };

    /** True when the segment goes to the bucket now: the direct rung, and a track with a direct window and a confirm URL. */
    const sendsDirect = (track: TrackName): boolean => {
        if (ladder.rung() !== 'direct') {
            return false;
        }

        const found = deps
            .tracks()
            .find((candidate) => candidate.track === track);

        return (
            found?.upload.direct !== undefined &&
            found.upload.confirm_url !== undefined
        );
    };

    /** Waits out the track's renewal gap, then renews its window once. */
    const renewWindow = async (lane: Lane, entry: Entry): Promise<void> => {
        const restMs =
            (renewedAt.get(lane.track) ?? Number.NEGATIVE_INFINITY) +
            RENEW_GAP_MS -
            env.perfNow();

        if (restMs > 0) {
            await sleep(entry, restMs, 'backoff');

            return;
        }

        renewedAt.set(lane.track, env.perfNow());
        await waitFor(entry, 'token', (end) => {
            token.renew().then(end, end);
        });
    };

    const requestFor = async (
        rung: Transport,
        url: string,
        used: TokenRef,
        record: SegmentRecord,
        part: Part,
    ): Promise<WireRequest> => {
        const meta = metaOf(record, part);

        return rung === 'put'
            ? segmentPut(url, used, meta, part.bytes)
            : segmentPost(url, used, meta, part.bytes, env.dateNow());
    };

    /** Delivers one segment, part after part, until it is delivered, given up, halted or cancelled. */
    const deliver = async (lane: Lane, entry: Entry): Promise<Outcome> => {
        const gone = (): boolean => stopped || entry.cancelled;
        const report = { track: lane.track, seq: entry.key.seq };
        let record = await store.getSegment(entry.key);

        if (
            gone() ||
            record === undefined ||
            record.state !== 'pending' ||
            record.data === null
        ) {
            return 'remove';
        }

        let parts: AsyncGenerator<Part> | null = null;
        let part: Part | null = null;
        /** The part was cut for the direct rung: always the whole segment (author's call 2). */
        let partDirect = false;
        const directKey = directKeyOf(entry.key);
        let lastStartMs = Number.NEGATIVE_INFINITY;
        let sentMs = 0;

        /** failures += 1 (stored), upload.chunk_failed, then the wait. False when the record is no longer pending. */
        const retryLater = async (
            code: string,
            waitMs: number | undefined,
            wait: Wait,
        ): Promise<boolean> => {
            if (gone()) {
                return false;
            }

            const written = await update(entry.key, (current) => ({
                ...current,
                failures: current.failures + 1,
            }));

            if (gone() || written === undefined) {
                return false;
            }

            const retryInMs =
                waitMs ?? backoffMs(written.failures, env.random());
            deps.emit('upload.chunk_failed', {
                ...report,
                attempt: written.failures,
                retry_in_ms: retryInMs,
                code,
            });
            await sleep(entry, retryInMs, wait);

            return true;
        };

        /** The whole segment as one part when it fits, else the next part the generator cuts. */
        const nextPart = async (
            data: ArrayBuffer,
            sha256: string,
        ): Promise<Part | null> => {
            if (parts === null) {
                return { index: 0, count: 1, bytes: data, sha256 };
            }

            const next = await parts.next();

            return next.done === true ? null : next.value;
        };

        for (;;) {
            if (gone()) {
                return 'remove';
            }

            if (halted.has(entry.key.take)) {
                return 'keep';
            }

            const target = targetOf(lane.track);

            if (target === null) {
                if (!warnedTracks.has(lane.track)) {
                    warnedTracks.add(lane.track);
                    deps.warn(
                        `Fitt Video: the descriptor has no ${lane.track} track, so its segments wait.`,
                    );
                }

                entry.restUntil = env.perfNow() + TICK_MS;

                return 'keep';
            }

            if (part === null) {
                const data = record.data as ArrayBuffer;
                partDirect = sendsDirect(lane.track);
                parts =
                    !partDirect &&
                    partCount(data.byteLength, target.partSize) > 1
                        ? partsOf(data, target.partSize)
                        : null;
                part = await nextPart(data, record.sha256);
                sentMs = 0;

                if (gone()) {
                    return 'remove';
                }

                if (part === null) {
                    return 'keep';
                }
            }

            await whenOnline(entry);
            await whenTokenReady(entry);
            await sleep(
                entry,
                lastStartMs + MIN_GAP_MS - env.perfNow(),
                'backoff',
            );

            if (gone()) {
                return 'remove';
            }

            if (!env.online() || halted.has(entry.key.take)) {
                continue;
            }

            const rung = ladder.rung();
            const direct = sendsDirect(lane.track);

            if (direct !== partDirect) {
                // The ladder stepped down, or the window came or went: cut again for this rung.
                part = null;
                slots.release(directKey);

                continue;
            }

            let request: WireRequest;
            let used = token.current();

            if (direct) {
                const slot = slots.slotFor(
                    lane.track,
                    directKey,
                    record.take,
                    record.sha256,
                );

                if (slot === 'renew') {
                    await renewWindow(lane, entry);

                    continue;
                }

                if (slot === 'none') {
                    part = null;

                    continue;
                }

                if (!slots.uploaded(directKey)) {
                    const startedAtMs = env.perfNow();
                    lastStartMs = startedAtMs;
                    const answer = await tracked(
                        flights,
                        send(
                            sendEnv,
                            directPut(
                                slot.url,
                                slot.headers,
                                record.data as ArrayBuffer,
                            ),
                            SEND_TIMEOUT_MS,
                        ),
                    );
                    const endedAtMs = env.perfNow();

                    if (gone()) {
                        return 'remove';
                    }

                    const current = await store.getSegment(entry.key);

                    if (
                        gone() ||
                        current === undefined ||
                        current.state !== 'pending'
                    ) {
                        return 'remove';
                    }

                    record = current;
                    const verdict = classifyDirect(answer);
                    const attempt = { startedAtMs, endedAtMs, rung };

                    if (verdict.kind === 'ok') {
                        ladder.success();
                        sentMs += endedAtMs - startedAtMs;
                        slots.markUploaded(directKey);
                    } else if (verdict.kind === 'step_down') {
                        if (
                            ladder.failure(verdict.reason, true, attempt) ||
                            ladder.rung() !== rung
                        ) {
                            // Bounded: the ladder moves only once per change, and never back up.
                            part = null;
                            slots.release(directKey);
                            lastStartMs = Number.NEGATIVE_INFINITY;

                            continue;
                        }

                        if (
                            !(await retryLater(
                                `http_${answer.status}`,
                                undefined,
                                'backoff',
                            ))
                        ) {
                            return 'remove';
                        }

                        continue;
                    } else {
                        const code =
                            verdict.kind === 'retry'
                                ? verdict.code
                                : `http_${answer.status}`;
                        const network =
                            code === 'network' || code === 'timeout';

                        if (network) {
                            ladder.failure('network', env.online(), {
                                ...attempt,
                                timedOut: answer.timedOut,
                            });
                        }

                        if (
                            !(await retryLater(
                                code,
                                verdict.kind === 'retry'
                                    ? verdict.waitMs
                                    : undefined,
                                network ? 'network' : 'backoff',
                            ))
                        ) {
                            return 'remove';
                        }

                        continue;
                    }

                    await whenTokenReady(entry);

                    if (gone()) {
                        return 'remove';
                    }

                    used = token.current();
                }

                const confirmUrl = targetOf(lane.track)?.confirmUrl ?? null;

                if (confirmUrl === null) {
                    part = null;

                    continue;
                }

                request = segmentConfirm(
                    confirmUrl,
                    used,
                    metaOf(record, part),
                    {
                        attempt: slot.attempt,
                        slot: slot.slot,
                        bytes: record.bytes,
                    },
                );
            } else {
                request = await requestFor(
                    rung,
                    target.url,
                    used,
                    record,
                    part,
                );
            }

            if (gone()) {
                return 'remove';
            }

            const startedAtMs = env.perfNow();
            lastStartMs = startedAtMs;
            const answer = await tracked(
                flights,
                send(sendEnv, request, SEND_TIMEOUT_MS),
            );
            const endedAtMs = env.perfNow();

            if (gone()) {
                return 'remove';
            }

            const current = await store.getSegment(entry.key);

            if (
                gone() ||
                current === undefined ||
                current.state !== 'pending'
            ) {
                return 'remove';
            }

            record = current;
            const verdict = classify(answer);
            const attempt = { startedAtMs, endedAtMs, rung };

            if (verdict.kind === 'ok') {
                ladder.success();
                sentMs += endedAtMs - startedAtMs;
                const last = part.index === part.count - 1;
                // The server holds this part but not yet the whole segment. A
                // track_sealed {stored: true} on the last part is the whole
                // segment: every earlier part was answered as held in this pass.
                const partHeld =
                    part.count > 1 &&
                    (verdict.code === 'part_stored' ||
                        (verdict.code === 'track_sealed' && !last) ||
                        (verdict.code === 'already_present' &&
                            partsMissingIn(answer.body)));

                if (!last && partHeld) {
                    part = await nextPart(
                        record.data as ArrayBuffer,
                        record.sha256,
                    );
                    // A new request, not a second attempt of the last one.
                    lastStartMs = Number.NEGATIVE_INFINITY;

                    if (part === null) {
                        return 'keep';
                    }

                    continue;
                }

                if (last && partHeld) {
                    // The server still lacks an earlier part: send them all again, and the parts it holds answer already_present.
                    part = null;

                    if (
                        !(await retryLater(
                            'parts_missing',
                            undefined,
                            'backoff',
                        ))
                    ) {
                        return 'remove';
                    }

                    continue;
                }

                const written = await update(entry.key, (pending) => ({
                    ...pending,
                    state: 'delivered',
                    data: null,
                }));

                if (gone() || written === undefined) {
                    return 'remove';
                }

                slots.release(directKey);
                bytesSent += written.bytes;
                deps.emit('upload.chunk_sent', {
                    ...report,
                    bytes: written.bytes,
                    transport: rung,
                    ms: Math.round(sentMs),
                });

                return 'remove';
            }

            if (verdict.kind === 'retry') {
                const localCorrupt =
                    (verdict.code === 'hash_mismatch' ||
                        verdict.code === 'size_mismatch') &&
                    (await corrupt(record));

                // stop() may have resolved while the copy was hashed.
                if (gone()) {
                    return 'remove';
                }

                if (localCorrupt) {
                    const written = await update(entry.key, (pending) => ({
                        ...pending,
                        state: 'rejected',
                        data: null,
                    }));

                    if (gone() || written === undefined) {
                        return 'remove';
                    }

                    deps.emit('upload.segment_rejected', {
                        ...report,
                        code: 'local_corrupt',
                    });
                    deps.warn(
                        `Fitt Video: the stored copy of ${lane.track} segment ${entry.key.seq} no longer matches its hash, so it was rejected.`,
                    );
                    deps.onAbandon(lane.track, written.take);

                    return 'remove';
                }

                if (
                    rung === 'direct' &&
                    (verdict.code === 'hash_mismatch' ||
                        verdict.code === 'size_mismatch')
                ) {
                    // The object in the bucket is not the segment: PUT it again, to a fresh slot.
                    slots.markNotUploaded(directKey);
                }

                const network =
                    verdict.code === 'network' || verdict.code === 'timeout';

                if (network) {
                    ladder.failure('network', env.online(), {
                        ...attempt,
                        timedOut: answer.timedOut,
                    });
                }

                if (
                    !(await retryLater(
                        verdict.code,
                        verdict.waitMs,
                        network ? 'network' : 'backoff',
                    ))
                ) {
                    return 'remove';
                }

                continue;
            }

            if (verdict.kind === 'step_down' || verdict.kind === 'blocked') {
                const kind: FailureKind =
                    verdict.kind === 'blocked' ? 'blocked' : verdict.reason;

                // network_blocked is not terminal (author's call 9): at once only when the ladder moved.
                if (ladder.failure(kind, true, attempt)) {
                    // Bounded: the ladder moves only once per change.
                    lastStartMs = Number.NEGATIVE_INFINITY;

                    continue;
                }

                const code =
                    verdict.kind === 'blocked'
                        ? verdict.code
                        : `http_${answer.status}`;

                if (!(await retryLater(code, undefined, 'backoff'))) {
                    return 'remove';
                }

                continue;
            }

            if (verdict.kind === 'refresh') {
                // 'retry': a newer token is held, so go again at once; 'paused': the loop waits for ready().
                token.expired(used.id);
                // Bounded: a token is retried only once a newer one is held.
                lastStartMs = Number.NEGATIVE_INFINITY;

                continue;
            }

            if (verdict.code === 'stale_take') {
                const serverTake = serverTakeIn(answer.body);

                if (
                    record.take === deps.currentTake() &&
                    serverTake !== null &&
                    serverTake > record.take
                ) {
                    // The local take is behind: keep the bytes, start no more of this take; the session adopts the server's take.
                    if (!halted.has(record.take)) {
                        halted.add(record.take);
                        deps.onTakeBehind(serverTake);
                    }

                    return 'keep';
                }

                // The server has deleted that take: nothing is left to re-post.
                await tracked(writes, store.deleteSegment(entry.key));

                if (gone()) {
                    return 'remove';
                }

                deps.emit('upload.segment_rejected', {
                    ...report,
                    code: verdict.code,
                });

                return 'remove';
            }

            const written = await update(entry.key, (pending) => ({
                ...pending,
                state: 'rejected',
                data: null,
            }));

            if (gone() || written === undefined) {
                return 'remove';
            }

            deps.emit('upload.segment_rejected', {
                ...report,
                code: verdict.code,
            });
            deps.onAbandon(lane.track, written.take);

            return 'remove';
        }
    };

    const launch = (lane: Lane, entry: Entry): void => {
        entry.active = true;
        lane.active += 1;
        deliver(lane, entry)
            .catch((error: unknown): Outcome => {
                if (!stopped) {
                    deps.warn(
                        `Fitt Video: sending ${lane.track} segment ${entry.key.seq} failed (${String(error)}); it is tried again.`,
                    );
                }

                entry.restUntil = env.perfNow() + TICK_MS;

                return 'keep';
            })
            .then((outcome) => {
                entry.active = false;
                lane.active -= 1;

                if (outcome === 'remove') {
                    removeEntry(lane, entry);
                    slots.release(directKeyOf(entry.key));
                }

                pump(lane);
                notifyIdle();
            });
    };

    /** Takes one pending drop for the lane, its own first. */
    const takeDrop = (track: TrackName): boolean => {
        for (const which of [track, '*'] as const) {
            const left = drops.get(which) ?? 0;

            if (left > 0) {
                drops.set(which, left - 1);

                return true;
            }
        }

        return false;
    };

    const drop = (lane: Lane, entry: Entry): void => {
        removeEntry(lane, entry);
        lane.chores += 1;
        update(entry.key, (pending) => ({
            ...pending,
            state: 'dropped',
            data: null,
        }))
            .catch(() => undefined)
            .then(() => {
                lane.chores -= 1;
                notifyIdle();
            });
    };

    function pump(lane: Lane): void {
        if (!started || stopped) {
            return;
        }

        const now = env.perfNow();

        while (lane.active < MAX_IN_FLIGHT && env.online()) {
            const entry = lane.entries.find(
                (candidate) =>
                    !candidate.active &&
                    candidate.restUntil <= now &&
                    !halted.has(candidate.key.take),
            );

            if (entry === undefined) {
                break;
            }

            if (takeDrop(lane.track)) {
                drop(lane, entry);

                continue;
            }

            launch(lane, entry);
        }
    }

    const pumpAll = (): void => {
        for (const lane of lanes.values()) {
            pump(lane);
        }
    };

    /** Ends the waits an online network makes pointless, then starts what can start. */
    const wake = (waits: Wait[]): void => {
        for (const lane of lanes.values()) {
            for (const entry of lane.entries) {
                if (entry.wait !== null && waits.includes(entry.wait)) {
                    entry.wake?.();
                }
            }
        }

        pumpAll();
    };

    const onOnline = (): void => {
        if (!stopped) {
            wake(['offline', 'network']);
        }
    };

    const sweep = (): void => {
        if (sweeping !== null) {
            return;
        }

        sweeping = queue
            .sweep(env.perfNow())
            .then((abandoned) => {
                if (stopped) {
                    return;
                }

                const lost = new Map<
                    string,
                    { track: TrackName; take: number }
                >();

                for (const record of abandoned) {
                    const lane = lanes.get(record.track);
                    const entry = lane?.entries.find((candidate) =>
                        sameKey(candidate.key, record),
                    );

                    if (lane !== undefined && entry !== undefined) {
                        cancel(lane, entry);
                    }

                    lost.set(`${record.track}:${record.take}`, {
                        track: record.track,
                        take: record.take,
                    });
                }

                for (const { track, take } of lost.values()) {
                    deps.onAbandon(track, take);
                }
            })
            .catch(() => undefined)
            .finally(() => {
                sweeping = null;
            });
    };

    /** upload.backlog at most once a tick per track, when its pending count changed. */
    const reportBacklog = (): void => {
        for (const lane of lanes.values()) {
            const segments = lane.entries.length;

            if (segments !== lane.reportedBacklog) {
                lane.reportedBacklog = segments;
                deps.emit('upload.backlog', {
                    track: lane.track,
                    segments,
                    bytes: lane.entries.reduce(
                        (total, entry) => total + entry.bytes,
                        0,
                    ),
                });
            }
        }
    };

    const tick = (): void => {
        tickTimer = env.timers.setTimeout(tick, TICK_MS);
        sweep();
        reportBacklog();

        // An online() override may change with no event: look every tick.
        if (env.online()) {
            wake(['offline']);
        }
    };

    return {
        enqueue(record: SegmentRecord): void {
            if (
                stopped ||
                record.state !== 'pending' ||
                record.take < floorTake
            ) {
                return;
            }

            const key = keyOf(record);
            const lane = laneOf(record.track);

            if (lane.entries.some((entry) => sameKey(entry.key, key))) {
                return;
            }

            const id = `${key.session_id}:${key.track}:${key.take}:${key.run_index}:${key.seq}`;

            if (!counted.has(id)) {
                counted.add(id);
                bytesTotal += record.bytes;
            }

            const entry: Entry = {
                key,
                bytes: record.bytes,
                active: false,
                cancelled: false,
                restUntil: Number.NEGATIVE_INFINITY,
                wait: null,
                wake: null,
            };
            const at = lane.entries.findIndex(
                (other) => order(key, other.key) < 0,
            );
            lane.entries.splice(at === -1 ? lane.entries.length : at, 0, entry);
            pump(lane);
        },
        start(): void {
            if (started || stopped) {
                return;
            }

            started = true;
            env.onlineTarget?.addEventListener('online', onOnline);
            tickTimer = env.timers.setTimeout(tick, TICK_MS);
            pumpAll();
        },
        async stop(): Promise<void> {
            if (!stopped) {
                stopped = true;

                if (tickTimer !== null) {
                    env.timers.clearTimeout(tickTimer);
                    tickTimer = null;
                }

                env.onlineTarget?.removeEventListener('online', onOnline);
                stopping.abort();

                for (const lane of lanes.values()) {
                    for (const entry of lane.entries) {
                        entry.wake?.();
                    }
                }
            }

            await Promise.allSettled([
                ...flights,
                ...writes,
                ...(sweeping === null ? [] : [sweeping]),
            ]);
        },
        dropNext(track?: TrackName): void {
            const which = track ?? '*';
            drops.set(which, (drops.get(which) ?? 0) + 1);

            if (track === undefined) {
                pumpAll();
            } else {
                pump(laneOf(track));
            }
        },
        dropTakesBelow(take: number): void {
            floorTake = Math.max(floorTake, take);

            for (const held of [...halted]) {
                if (held < take) {
                    halted.delete(held);
                }
            }

            for (const lane of lanes.values()) {
                for (const entry of [...lane.entries]) {
                    if (entry.key.take < take) {
                        cancel(lane, entry);
                    }
                }
            }

            pumpAll();
            notifyIdle();
        },
        idle(track?: TrackName): Promise<void> {
            if (isIdle(track)) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                idleWaiters.push({ track, resolve });
            });
        },
        stats(): UploadStats {
            let backlog = 0;

            for (const lane of lanes.values()) {
                backlog += lane.entries.length;
            }

            return { bytesSent, bytesTotal, backlog };
        },
    };
}
