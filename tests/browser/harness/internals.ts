/** What the browser specs call through `window.internals`. Later tasks add the functions their specs need. */
import { createBatcher } from '../../../src/core/batcher.ts';
import { createClock } from '../../../src/core/clock.ts';
import { sha256Hex } from '../../../src/core/crypto.ts';
import type { Descriptor, TrackName } from '../../../src/core/descriptor.ts';
import { browserEnvironment } from '../../../src/core/env.ts';
import { createEventBus } from '../../../src/core/events.ts';
import { send } from '../../../src/core/http.ts';
import { createLadder } from '../../../src/core/ladder.ts';
import { createQueue } from '../../../src/core/queue.ts';
import {
    MemoryQueueStore,
    openIdbStore,
    transaction,
    type BatchRecord,
    type RunRecord,
    type SegmentRecord,
    type SegmentState,
    type SessionRecord,
} from '../../../src/core/store.ts';
import { createTokenKeeper } from '../../../src/core/token.ts';
import { ulid } from '../../../src/core/ulid.ts';
import { createUploader } from '../../../src/core/uploader.ts';
import {
    eventsRequest,
    jsonRequest,
    segmentPut,
} from '../../../src/core/wire.ts';
import { STORE_CASES } from '../../shared/store-suite.ts';

export const ready = true;

const SID = '01jbz8q4w6x0k3m5n7p9r2t4aa';
const OTHER = '01jbz8q4w6x0k3m5n7p9r2t4bb';
const RUN = '01jbz8q4w6x0k3m5n7p9r2t4v6';

/** Deletes the `fitt-video` database, so each probe starts on a fresh one. */
function freshDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('fitt-video');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
            reject(new Error('Deleting fitt-video is blocked.'));
    });
}

/** tests/support/records.ts reads a file with node:fs, so a page builds its own records. */
function segment(overrides: Partial<SegmentRecord>): SegmentRecord {
    const bytes = overrides.bytes ?? 3;

    return {
        session_id: SID,
        track: 'camera',
        take: 1,
        run_index: 0,
        run_id: RUN,
        seq: 1,
        kind: 'media',
        start_ms: 12,
        duration_ms: 5000,
        recorded_at: 1_762_400_005_000,
        bytes,
        sha256: 'ab'.repeat(32),
        part_count: 1,
        created_ms: 0,
        state: 'pending',
        failures: 0,
        init: null,
        data: new Uint8Array(bytes).fill(7).buffer,
        ...overrides,
    };
}

/** Runs one case of the shared store suite on a fresh IndexedDB store: null, or the error message. */
export async function runStoreCase(name: string): Promise<string | null> {
    const storeCase = STORE_CASES.find((candidate) => candidate.name === name);

    if (storeCase === undefined) {
        return `No store case is named "${name}".`;
    }

    await freshDatabase();
    const store = await openIdbStore(indexedDB);

    try {
        await storeCase.run(store);

        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    } finally {
        store.close();
    }
}

/** One record of each kind, on a fresh database. */
export async function writeReloadProbe(): Promise<void> {
    await freshDatabase();
    const store = await openIdbStore(indexedDB);
    const run: RunRecord = {
        session_id: SID,
        track: 'camera',
        take: 1,
        run_index: 0,
        run_id: RUN,
        anchor_ms: 12,
        anchor_source: 'performance',
        mime_type: 'video/webm;codecs=vp8,opus',
        started_ms: 10,
        ended_ms: null,
        ended_reason: null,
        segmenting: 'cluster',
        keyframe_option_honoured: null,
        ua: navigator.userAgent,
    };
    const batch: BatchRecord = {
        session_id: SID,
        batch_seq: 0,
        take: 1,
        body: '{}',
        payload_bytes: 0,
    };

    await store.putSession({ session_id: SID } as unknown as SessionRecord);
    await store.putRun(run);
    await store.putSegment(segment({ seq: 0, kind: 'init' }));
    await store.putBatch(batch);
    store.close();
}

/** The counts of what writeReloadProbe() stored, read on a new connection. */
export async function readReloadProbe(): Promise<{
    sessions: number;
    runs: number;
    segments: number;
    batches: number;
}> {
    const store = await openIdbStore(indexedDB);

    try {
        return {
            sessions: (await store.listSessions()).length,
            runs: (await store.listRuns(SID)).length,
            segments: (await store.listSegments(SID)).length,
            batches: (await store.listBatches(SID)).length,
        };
    } finally {
        store.close();
    }
}

/** storedBytes() after a reopen, which rebuilds the total from segment_bytes. */
export async function reopenBytesProbe(): Promise<number> {
    await freshDatabase();
    const first = await openIdbStore(indexedDB);
    await first.putSegment(segment({ seq: 1, bytes: 3 }));
    await first.putSegment(segment({ seq: 2, bytes: 3 }));
    await first.putSegment({
        ...segment({ seq: 1, bytes: 3 }),
        state: 'delivered',
        data: null,
    });
    await first.putSegment(segment({ session_id: OTHER, seq: 1, bytes: 5 }));
    await first.deleteSession(SID);
    first.close();

    const second = await openIdbStore(indexedDB);

    try {
        return await second.storedBytes();
    } finally {
        second.close();
    }
}

/**
 * The name a transaction rejects with when one of its requests fails: a
 * second add() of the same key fails on the request, before the
 * transaction aborts and sets its own error.
 */
export async function requestErrorProbe(): Promise<string> {
    const name = 'fitt-video-probe';
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () =>
            request.result.createObjectStore('rows', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    try {
        await transaction(db, ['rows'], 'readwrite', (tx) => {
            tx.objectStore('rows').add({ id: 1 });
            tx.objectStore('rows').add({ id: 1 });

            return () => undefined;
        });

        return 'resolved';
    } catch (error) {
        return error === null
            ? 'null'
            : String((error as { name?: unknown }).name);
    } finally {
        db.close();
    }
}

export { createSessionApi } from '../../../src/core/api.ts';
export { buildManifest } from '../../../src/core/manifest.ts';
export { segmentPost } from '../../../src/core/wire.ts';
export { browserEnvironment, jsonRequest, segmentPut, send, sha256Hex };

/** The bytes of a base64 string: a spec hands fixture bytes to the page as base64. */
export function fromBase64(text: string): ArrayBuffer {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes.buffer;
}

/** One segment a contract spec hands the page: its bytes as base64. */
export interface UploaderSegment {
    track: TrackName;
    take: number;
    run: string;
    seq: number;
    kind: 'init' | 'media';
    base64: string;
}

/**
 * Runs the real uploader against the server for up to `seconds`: a memory
 * store, the queue, a token keeper and a ladder over the browser's own
 * environment. Each segment becomes a full SegmentRecord with the timing
 * rule of tests/support/records.ts segmentRecord(), which a page cannot
 * import. Returns what the uploader emitted and the stored states.
 */
export async function runUploader(options: {
    descriptor: Descriptor;
    segments: UploaderSegment[];
    seconds: number;
    currentTake?: number;
}): Promise<{
    events: [string, Record<string, unknown>][];
    states: [TrackName, number, SegmentState][];
    behind: number[];
}> {
    const { descriptor } = options;
    const env = browserEnvironment();
    const store = new MemoryQueueStore();
    const queue = createQueue(store, {
        abandonAfterMs: descriptor.queue.abandon_after_ms,
        budgetBytes: descriptor.queue.buffer_budget_bytes,
        perfNow: () => performance.now(),
    });
    const events: [string, Record<string, unknown>][] = [];
    const behind: number[] = [];
    const emit = (type: string, payload: Record<string, unknown>): void => {
        events.push([type, payload]);
    };
    const token = createTokenKeeper({
        env,
        descriptor,
        refresh: (used) =>
            send(
                env,
                jsonRequest(
                    `${descriptor.endpoints.api}/sessions/${descriptor.session_id}/refresh-upload`,
                    used,
                    'POST',
                ),
            ),
        onDescriptor: () => {},
        emit,
        setError: () => {},
    });
    const ladder = createLadder({
        rung: 'put',
        everSucceeded: false,
        persist: async () => {},
        emit,
    });
    const uploader = createUploader({
        env,
        store,
        queue,
        now: () => Math.floor(performance.now()),
        tracks: () => descriptor.tracks,
        token,
        ladder,
        emit,
        onAbandon: () => {},
        currentTake: () => options.currentTake ?? descriptor.take,
        onTakeBehind: (take) => behind.push(take),
        warn: (message) => console.warn(message),
    });

    for (const segment of options.segments) {
        const data = fromBase64(segment.base64);
        const record: SegmentRecord = {
            session_id: descriptor.session_id,
            track: segment.track,
            take: segment.take,
            run_index: 0,
            run_id: segment.run,
            seq: segment.seq,
            kind: segment.kind,
            start_ms: segment.seq === 0 ? 12 : 12 + (segment.seq - 1) * 5000,
            duration_ms: segment.seq === 0 ? 0 : 5000,
            recorded_at: Date.now(),
            bytes: data.byteLength,
            sha256: await sha256Hex(data),
            part_count: 1,
            created_ms: 0,
            state: 'pending',
            failures: 0,
            init:
                segment.seq === 0
                    ? {
                          anchor_ms: 12,
                          anchor_source: 'performance',
                          mime: 'video/webm;codecs=vp8,opus',
                          started_ms: 10,
                      }
                    : null,
            data,
        };
        await queue.add(record);
        uploader.enqueue(record);
    }

    uploader.start();
    await Promise.race([
        uploader.idle(),
        new Promise<void>((resolve) =>
            setTimeout(resolve, options.seconds * 1000),
        ),
    ]);
    await uploader.stop();
    await token.stop();

    return {
        events,
        states: (await store.listSegments(descriptor.session_id)).map(
            (record) => [record.track, record.seq, record.state],
        ),
        behind,
    };
}

/** Where runBatches() keeps its synchronous next_batch_seq copy. */
function seqKey(sessionId: string): string {
    return `fitt-video:${sessionId}:next_batch_seq`;
}

/** A session record for runBatches(), with the fields a later task fills left at their start values. */
function batchSession(descriptor: Descriptor): SessionRecord {
    const now = Date.now();

    return {
        session_id: descriptor.session_id,
        descriptor,
        epoch_ms: Math.floor(performance.timeOrigin + performance.now()),
        take: descriptor.take,
        take_start_ms: null,
        take_open: false,
        take_end_ms: null,
        next_batch_seq: 0,
        ladder_rung: 'put',
        ever_succeeded: false,
        stop_completed: false,
        rejected_take: null,
        pending_discard: false,
        last_activity_ms: now,
        token_expires_at_ms: now + descriptor.token.expires_in_s * 1000,
        pending_reset_take: null,
        manifest_owed: {},
        max_session_ms: 0,
        finalised: false,
        expires_at_ms: null,
    };
}

/**
 * Sends one event batch per inner list through the real batcher, over
 * IndexedDB and a token keeper, with the sync seq copy in localStorage.
 * The session record (created at next_batch_seq 0) survives a reload, so a
 * second call carries on the numbering. With `replayFirstWith`, batch 0 is
 * then posted again by hand with other events, which the server must
 * ignore. Ends with GET /status.
 */
export async function runBatches(options: {
    descriptor: Descriptor;
    batches: string[][];
    replayFirstWith?: string[];
}): Promise<{
    statuses: number[];
    batchSeqs: number[];
    status: number;
    rejected: { batch_seq: number; code: string; status: number }[];
}> {
    const { descriptor } = options;
    const sid = descriptor.session_id;
    const api = descriptor.endpoints.api;
    const eventsUrl = `${api}/sessions/${sid}/events`;
    const env = browserEnvironment();
    const store = await openIdbStore(indexedDB);
    let session = await store.getSession(sid);

    if (session === undefined) {
        session = batchSession(descriptor);
        await store.putSession(session);
    }

    const clock = createClock(env, session.epoch_ms);
    const statuses: number[] = [];
    const batchSeqs: number[] = [];
    const rejected: { batch_seq: number; code: string; status: number }[] = [];
    const post = async (
        body: string,
        keepalive: boolean,
        token: { id: string; secret: string },
    ) => {
        const answer = await send(
            env,
            eventsRequest(eventsUrl, token, body, keepalive),
        );
        statuses.push(answer.status);
        batchSeqs.push((JSON.parse(body) as { batch_seq: number }).batch_seq);

        return answer;
    };
    const token = createTokenKeeper({
        env,
        descriptor,
        refresh: (used) =>
            send(
                env,
                jsonRequest(
                    `${api}/sessions/${sid}/refresh-upload`,
                    used,
                    'POST',
                ),
            ),
        onDescriptor: () => {},
        emit: () => {},
        setError: () => {},
    });
    const stored = session;
    const batcher = createBatcher({
        env,
        clock,
        store,
        sessionId: sid,
        take: () => descriptor.take,
        nextBatchSeq: stored.next_batch_seq,
        batchMs: descriptor.events.batch_ms,
        token,
        send: post,
        persistNextBatchSeq: async (next) => {
            stored.next_batch_seq = next;
            await store.putSession({ ...stored });
        },
        persistNextBatchSeqSync: (next) => {
            localStorage.setItem(seqKey(sid), String(next));
        },
        readNextBatchSeqSync: () => {
            const value = localStorage.getItem(seqKey(sid));

            return value === null ? null : Number(value);
        },
        onClosed: () => {},
        onRejected: (rejection) => rejected.push(rejection),
    });
    const bus = createEventBus({
        env,
        clock,
        groups: descriptor.signals.groups,
        onQueued: (event) => batcher.add(event),
    });

    try {
        for (const types of options.batches) {
            for (const type of types) {
                bus.emit(type);
            }

            await batcher.flush();
        }

        if (options.replayFirstWith !== undefined) {
            const body = JSON.stringify({
                take: descriptor.take,
                batch_seq: 0,
                sent_at_ms: Date.now(),
                clock_epoch_ms: clock.epochMs,
                events: options.replayFirstWith.map((type) => ({
                    id: ulid(env),
                    t_ms: clock.now(),
                    type,
                    source: 'browser',
                })),
            });
            await post(body, false, token.current());
        }

        const status = await send(
            env,
            jsonRequest(
                `${api}/sessions/${sid}/status`,
                token.current(),
                'GET',
            ),
        );

        return { statuses, batchSeqs, status: status.status, rejected };
    } finally {
        batcher.stop();
        await token.stop();
        store.close();
    }
}

/**
 * PUTs small byte arrays as seq 0 (init) and media seqs on one new run of
 * the descriptor's take, with the timing rule of runUploader(): seq 0 at
 * start_ms 12 with duration 0 and the init headers, seq n at
 * 12 + (n - 1) * 5000 for 5000 ms. Seqs in `skip` get a pending record but
 * are never sent. Returns the records (sent ones delivered) with the run
 * record they share as `run`; throws when a PUT is not answered 2xx.
 */
export async function putFixtureSegments(options: {
    descriptor: Descriptor;
    track: TrackName;
    seqs: number[];
    skip?: number[];
}): Promise<SegmentRecord[] & { run: RunRecord }> {
    const { descriptor, track } = options;
    const env = browserEnvironment();
    const target = descriptor.tracks.find(
        (candidate) => candidate.track === track,
    );

    if (target === undefined) {
        throw new Error(`The descriptor has no ${track} track.`);
    }

    const mime =
        track === 'audio'
            ? 'audio/webm;codecs=opus'
            : 'video/webm;codecs=vp8,opus';
    const run: RunRecord = {
        session_id: descriptor.session_id,
        track,
        take: descriptor.take,
        run_index: 0,
        run_id: ulid(env),
        anchor_ms: 12,
        anchor_source: 'performance',
        mime_type: mime,
        started_ms: 10,
        ended_ms: 12 + Math.max(0, ...options.seqs) * 5000,
        ended_reason: 'stop',
        segmenting: 'cluster',
        keyframe_option_honoured: null,
        ua: navigator.userAgent,
    };
    const token = { id: descriptor.token.id, secret: descriptor.token.secret };
    const records: SegmentRecord[] = [];

    for (const seq of options.seqs) {
        const data = new Uint8Array(16).fill(seq + 1).buffer;
        const sha256 = await sha256Hex(data);
        const init =
            seq === 0
                ? {
                      anchor_ms: 12,
                      anchor_source: 'performance' as const,
                      mime,
                      started_ms: 10,
                  }
                : null;
        const record: SegmentRecord = {
            session_id: descriptor.session_id,
            track,
            take: descriptor.take,
            run_index: 0,
            run_id: run.run_id,
            seq,
            kind: seq === 0 ? 'init' : 'media',
            start_ms: seq === 0 ? 12 : 12 + (seq - 1) * 5000,
            duration_ms: seq === 0 ? 0 : 5000,
            recorded_at: Date.now(),
            bytes: data.byteLength,
            sha256,
            part_count: 1,
            created_ms: 0,
            state: 'pending',
            failures: 0,
            init,
            data,
        };

        if (!(options.skip ?? []).includes(seq)) {
            const answer = await send(
                env,
                segmentPut(
                    target.upload.url,
                    token,
                    {
                        take: record.take,
                        run: record.run_id,
                        seq,
                        kind: record.kind,
                        startMs: record.start_ms,
                        durationMs: record.duration_ms,
                        recordedAt: record.recorded_at,
                        sha256,
                        init:
                            init === null
                                ? undefined
                                : {
                                      anchorMs: init.anchor_ms,
                                      anchorSource: init.anchor_source,
                                      mime: init.mime,
                                      startedMs: init.started_ms,
                                  },
                    },
                    data,
                ),
            );

            if (answer.status < 200 || answer.status >= 300) {
                throw new Error(
                    `PUT seq ${seq} answered ${answer.status}: ${JSON.stringify(answer.body)}`,
                );
            }

            record.state = 'delivered';
            record.data = null;
        }

        records.push(record);
    }

    return Object.assign(records, { run });
}
