/** What the browser specs call through `window.internals`. Later tasks add the functions their specs need. */
import { createBatcher } from '../../../src/core/batcher.ts';
import { createClock, type Clock } from '../../../src/core/clock.ts';
import { sha256Hex } from '../../../src/core/crypto.ts';
import type {
    ChunkedTrack,
    Descriptor,
    TrackName,
} from '../../../src/core/descriptor.ts';
import { browserEnvironment } from '../../../src/core/env.ts';
import { FittVideoError, type ErrorCode } from '../../../src/core/errors.ts';
import { createEventBus } from '../../../src/core/events.ts';
import { send } from '../../../src/core/http.ts';
import { createLadder } from '../../../src/core/ladder.ts';
import type { SessionOptions } from '../../../src/core/options.ts';
import { createQueue } from '../../../src/core/queue.ts';
import type { FittSession } from '../../../src/core/session.ts';
import type { Phase, SessionState } from '../../../src/core/state.ts';
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
import { FittVideo } from '../../../src/index.ts';
import {
    createRecorderEngine,
    type RecorderEngine,
} from '../../../src/recorder/engine.ts';
import { createSilenceDetector } from '../../../src/recorder/silence.ts';
import {
    requestFullscreen,
    type ActionResult,
} from '../../../src/signals/fullscreen.ts';
import { startSignals } from '../../../src/signals/index.ts';
import answerDescriptor from '../../fixtures/descriptor-answer.json';
import conversationDescriptor from '../../fixtures/descriptor-conversation.json';
import monitorDescriptor from '../../fixtures/descriptor-monitor.json';
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

/** The descriptor fixtures a recording spec may name. */
const RECORDING_DESCRIPTORS: Record<string, Descriptor> = {
    answer: answerDescriptor as Descriptor,
    monitor: monitorDescriptor as Descriptor,
    conversation: conversationDescriptor as Descriptor,
};

/** Base64 of an ArrayBuffer, in slices so a large segment never overflows the argument list. */
function toBase64(data: ArrayBuffer): string {
    const bytes = new Uint8Array(data);
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 0x8000),
        );
    }

    return btoa(binary);
}

/** What a recording rig collected. */
interface RecordingRig {
    engine: RecorderEngine;
    clock: Clock;
    runs: Map<string, RunRecord>;
    segments: SegmentRecord[];
    recorderOptions: MediaRecorderOptions[];
    errors: (ErrorCode | null)[];
    events: string[];
}

/** What an audio spec adds to a recording rig. */
interface RigAudio {
    /** Builds the engine's audio graph on a new AudioContext. */
    audio?: boolean;
    onSample?(level: number, tMs: number): void;
    /** Every stream a recorder is made for, with its options. */
    onRecorder?(stream: MediaStream, options: MediaRecorderOptions): void;
}

/**
 * The real recorder engine over the browser: navigator.mediaDevices, MediaRecorder (each
 * constructor's options recorded), MediaStream and navigator.permissions, on a recipe's fixture
 * descriptor (or a descriptor built by the spec). Where MediaRecorder is missing, the factory
 * throws as the real constructor would.
 */
function recordingRig(
    recipe: string | Descriptor,
    extra: RigAudio = {},
): RecordingRig {
    const descriptor =
        typeof recipe === 'string' ? RECORDING_DESCRIPTORS[recipe] : recipe;

    if (descriptor === undefined) {
        throw new Error(
            `No recording descriptor is named "${String(recipe)}".`,
        );
    }

    const env = browserEnvironment();
    const clock = createClock(env);
    const tracks = descriptor.tracks.filter(
        (track): track is ChunkedTrack => track.kind === 'chunked',
    );
    const runs = new Map<string, RunRecord>();
    const segments: SegmentRecord[] = [];
    const recorderOptions: MediaRecorderOptions[] = [];
    const errors: (ErrorCode | null)[] = [];
    const events: string[] = [];
    const runIndexes = new Map<string, number>();
    const engine = createRecorderEngine({
        env,
        clock,
        sessionId: descriptor.session_id,
        take: () => descriptor.take,
        tracks,
        media: navigator.mediaDevices,
        recorderFactory: (stream, options) => {
            recorderOptions.push({ ...options });
            extra.onRecorder?.(stream, options);

            return new MediaRecorder(stream, options);
        },
        isTypeSupported: (type) =>
            typeof MediaRecorder !== 'undefined' &&
            MediaRecorder.isTypeSupported(type),
        bitrates: (track) => ({
            video: track.capture.video?.bitrate_bps,
            audio: track.capture.audio.bitrate_bps,
        }),
        cameraAudio: (stream) => stream.getAudioTracks(),
        createAudioContext: extra.audio ? () => new AudioContext() : null,
        onSample: extra.onSample,
        makeStream: (streamTracks) => new MediaStream(streamTracks),
        permissions: navigator.permissions,
        nextRunIndex: (track) => {
            const next = runIndexes.get(track) ?? 0;
            runIndexes.set(track, next + 1);

            return next;
        },
        add: async (record) => {
            segments.push(record);
        },
        putRun: async (record) => {
            runs.set(record.run_id, record);
        },
        emit: (type) => events.push(type),
        onError: (code) => errors.push(code),
        ua: navigator.userAgent,
        doc: document,
    });

    return { engine, clock, runs, segments, recorderOptions, errors, events };
}

/** Starts a take, and says false when the engine refused it as recorder_unsupported. */
async function startTake(rig: RecordingRig): Promise<boolean> {
    try {
        await rig.engine.startTake(rig.clock.now());

        return true;
    } catch (error) {
        if (
            error instanceof FittVideoError &&
            error.code === 'recorder_unsupported'
        ) {
            return false;
        }

        throw error;
    }
}

/**
 * Gecko delivers a script-dispatched (untrusted) event to a MediaStreamTrack listener only when
 * the listener was added with its non-standard fourth argument, `wantsUntrusted` (an `on*`
 * handler always gets it; probe in the Task 12b PR notes). A real unplug fires a trusted `ended`,
 * which every listener gets, so the SDK adds its listeners the standard way and only this test
 * shim, installed while a spec fakes an unplug, asks for untrusted events too. Other engines
 * ignore the extra argument. Returns the function that puts the original back.
 */
function hearScriptTrackEvents(): () => void {
    const prototype = MediaStreamTrack.prototype;
    const original = prototype.addEventListener;

    prototype.addEventListener = function (
        this: MediaStreamTrack,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ): void {
        (original as (...args: unknown[]) => void).call(
            this,
            type,
            listener,
            options,
            true,
        );
    };

    return () => {
        prototype.addEventListener = original;
    };
}

/**
 * Prepares, records one take for `seconds` and stops it. A take the engine refuses as
 * recorder_unsupported (Linux WebKit, owner decision 2) is stopped at once and records nothing.
 * Each `...At` is milliseconds after the take started: `switchCameraAt` picks `fake-camera-2`
 * (the synthetic stream's second camera), `endTrackAt` fires `ended` on the video track (an
 * unplug), and `deviceBackAt` fires `devicechange` on navigator.mediaDevices.
 */
export async function recordTake(options: {
    recipe: string;
    seconds: number;
    switchCameraAt?: number;
    endTrackAt?: number;
    deviceBackAt?: number;
}): Promise<{
    runs: RunRecord[];
    segments: {
        run_id: string;
        seq: number;
        kind: 'init' | 'media';
        start_ms: number;
        duration_ms: number;
        base64: string;
    }[];
    recorderOptions: MediaRecorderOptions[];
    errors: (ErrorCode | null)[];
    events: string[];
}> {
    const restore =
        options.endTrackAt === undefined ? () => {} : hearScriptTrackEvents();

    try {
        return await recordWith(options);
    } finally {
        restore();
    }
}

async function recordWith(
    options: Parameters<typeof recordTake>[0],
): ReturnType<typeof recordTake> {
    const rig = recordingRig(options.recipe);
    await rig.engine.prepare();

    if (await startTake(rig)) {
        const actions: Promise<unknown>[] = [];
        const at = (ms: number | undefined, action: () => unknown): void => {
            if (ms === undefined) {
                return;
            }

            actions.push(
                new Promise((resolve) => setTimeout(resolve, ms)).then(action),
            );
        };

        at(options.switchCameraAt, () =>
            rig.engine.devices().select('camera', 'fake-camera-2'),
        );
        at(options.endTrackAt, () =>
            rig.engine.stream
                ?.getVideoTracks()[0]
                ?.dispatchEvent(new Event('ended')),
        );
        at(options.deviceBackAt, () =>
            navigator.mediaDevices.dispatchEvent(new Event('devicechange')),
        );
        await new Promise((resolve) =>
            setTimeout(resolve, options.seconds * 1000),
        );
        await Promise.all(actions);
    }

    await rig.engine.stopTake();

    return {
        runs: [...rig.runs.values()],
        segments: rig.segments.map((segment) => ({
            run_id: segment.run_id,
            seq: segment.seq,
            kind: segment.kind,
            start_ms: segment.start_ms,
            duration_ms: segment.duration_ms,
            base64: toBase64(segment.data ?? new ArrayBuffer(0)),
        })),
        recorderOptions: rig.recorderOptions,
        errors: rig.errors,
        events: rig.events,
    };
}

/** Prepares, records a 2 s take and calls stopTake() only: the readyState of every track it acquired. */
export async function releaseCheck(): Promise<string[]> {
    const rig = recordingRig('answer');
    await rig.engine.prepare();
    const acquired = rig.engine.stream?.getTracks() ?? [];

    if (await startTake(rig)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await rig.engine.stopTake();

    return acquired.map((track) => track.readyState);
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

function mean(values: number[]): number {
    return values.length === 0
        ? 0
        : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Waits until `ready()` holds or `ms` have passed. */
async function waitUntil(ready: () => boolean, ms: number): Promise<void> {
    const until = performance.now() + ms;

    while (!ready() && performance.now() < until) {
        await sleep(50);
    }
}

/** The state of `context` once it is closed, or after `ms` if it never closes. */
async function stateAfterClose(
    context: AudioContext,
    ms: number,
): Promise<AudioContextState> {
    await waitUntil(() => context.state === 'closed', ms);

    return context.state;
}

/**
 * Resumes a host context without hanging: Firefox has no audio device in
 * Sail or CI, so its resume() never settles (owner decision 1).
 */
async function resumeBriefly(context: AudioContext): Promise<void> {
    await Promise.race([context.resume().catch(() => undefined), sleep(1000)]);
}

/** The time-domain RMS an analyser holds now. */
function analyserRms(
    analyser: AnalyserNode,
    buffer: Float32Array<ArrayBuffer>,
): number {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;

    for (const sample of buffer) {
        sum += sample * sample;
    }

    return Math.sqrt(sum / buffer.length);
}

function analyserOn(context: AudioContext): AnalyserNode {
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;

    return analyser;
}

/**
 * Acquires through the engine with its audio graph, resumes it, reads the
 * meter for 1 s, then sets the synthetic microphone's gain to 0 and waits up
 * to 8 s for the silence detector (phase ready) to raise device.no_audio.
 * `context` is the graph's state while the meter was read: a context that is
 * not running passes no level on, so the wait is skipped there (Firefox,
 * owner decision 1). `contextAfterClose` is read after release().
 */
export async function audioProbe(): Promise<{
    level: number;
    context: AudioContextState;
    noAudioAfterMs: number | null;
    contextAfterClose: AudioContextState;
}> {
    let noAudioAt: number | null = null;
    const detector = createSilenceDetector({
        emit: (type) => {
            if (type === 'device.no_audio' && noAudioAt === null) {
                noAudioAt = performance.now();
            }
        },
        onState: () => {},
    });
    const rig = recordingRig('answer', {
        audio: true,
        onSample: (level, tMs) => detector.sample(level, tMs, 'ready'),
    });
    await rig.engine.prepare();
    const graph = rig.engine.audio();

    if (graph === null) {
        throw new Error('prepare() built no audio graph.');
    }

    await graph.resume();
    const levels: number[] = [];
    const stopListening = graph.onLevel((level) => levels.push(level));
    await sleep(1000);
    stopListening();
    const context = graph.context.state;
    noAudioAt = null;
    window.__fakeMicGain?.(0);
    const changedAt = performance.now();

    if (context === 'running') {
        await waitUntil(() => noAudioAt !== null, 8000);
    }

    const heard: number | null = noAudioAt;
    rig.engine.release();

    return {
        level: mean(levels),
        context,
        noAudioAfterMs: heard === null ? null : Math.round(heard - changedAt),
        contextAfterClose: await stateAfterClose(graph.context, 2000),
    };
}

/**
 * One conversation take (a stereo camera track) plus the answer fixture's
 * `audio` track, since conversation records the camera only unless the host
 * lists both tracks. A host AudioContext plays a 440 Hz tone at gain 0.5
 * into mix() before the take, and the synthetic microphone's gain is
 * `micGain` from the start. Over the last 2 s of the take it reads, in the
 * graph's context, the RMS of the left and right channels of cameraAudio()
 * and of the audio run's own microphone stream, every 100 ms, and returns
 * the means. Both inits come back in base64 (null when none was stored),
 * `context` is the graph's state during the take and `contextState` its
 * state after stopTake(). A take refused as recorder_unsupported (Linux
 * WebKit, owner decision 2) still runs the graph for `seconds`.
 */
export async function mixedTake(options: {
    seconds: number;
    micGain: number;
}): Promise<{
    cameraInit: string | null;
    audioInit: string | null;
    events: string[];
    errors: (ErrorCode | null)[];
    context: AudioContextState;
    contextState: AudioContextState;
    leftRms: number;
    rightRms: number;
    audioTrackRms: number | null;
}> {
    const conversation = RECORDING_DESCRIPTORS.conversation;
    const audioTrack = RECORDING_DESCRIPTORS.answer.tracks.find(
        (track) => track.track === 'audio',
    );

    if (audioTrack === undefined) {
        throw new Error('The answer fixture has no audio track.');
    }

    const descriptor: Descriptor = {
        ...conversation,
        tracks: [...conversation.tracks, audioTrack],
    };
    let phase: Phase = 'ready';
    const audioStreams: MediaStream[] = [];
    window.__fakeMicGain?.(options.micGain);
    const events: string[] = [];
    const detector = createSilenceDetector({
        emit: (type) => events.push(type),
        onState: () => {},
    });
    const rig = recordingRig(descriptor, {
        audio: true,
        onSample: (level, tMs) => detector.sample(level, tMs, phase),
        onRecorder: (stream, recorderOptions) => {
            if (recorderOptions.mimeType?.startsWith('audio/') === true) {
                audioStreams.push(stream);
            }
        },
    });
    await rig.engine.prepare();
    const graph = rig.engine.audio();

    if (graph === null) {
        throw new Error('prepare() built no audio graph.');
    }

    const host = new AudioContext();
    const tone = host.createOscillator();
    const toneGain = host.createGain();
    tone.frequency.value = 440;
    toneGain.gain.value = 0.5;
    tone.connect(toneGain);
    tone.start();
    await resumeBriefly(host);
    graph.mix(toneGain);

    if (await startTake(rig)) {
        phase = 'recording';
    }

    const meters = graph.context;
    const splitter = meters.createChannelSplitter(2);
    const left = analyserOn(meters);
    const right = analyserOn(meters);
    meters
        .createMediaStreamSource(new MediaStream(graph.cameraAudio()))
        .connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    let microphone: AnalyserNode | null = null;

    if (audioStreams.length > 0) {
        microphone = analyserOn(meters);
        meters.createMediaStreamSource(audioStreams[0]).connect(microphone);
    }

    const buffer = new Float32Array(2048);
    const lefts: number[] = [];
    const rights: number[] = [];
    const microphones: number[] = [];
    const startedAt = performance.now();
    const endAt = startedAt + options.seconds * 1000;
    const readFrom = endAt - 2000;

    while (performance.now() < endAt) {
        await sleep(100);

        if (performance.now() >= readFrom) {
            lefts.push(analyserRms(left, buffer));
            rights.push(analyserRms(right, buffer));

            if (microphone !== null) {
                microphones.push(analyserRms(microphone, buffer));
            }
        }
    }

    const context = meters.state;
    phase = 'stopping';
    await rig.engine.stopTake();
    const contextState = await stateAfterClose(meters, 2000);
    tone.stop();
    void host.close().catch(() => undefined);
    const initOf = (track: TrackName): string | null => {
        const init = rig.segments.find(
            (segment) => segment.track === track && segment.kind === 'init',
        );

        return init?.data ? toBase64(init.data) : null;
    };

    return {
        cameraInit: initOf('camera'),
        audioInit: initOf('audio'),
        events: [...rig.events, ...events],
        errors: rig.errors,
        context,
        contextState,
        leftRms: mean(lefts),
        rightRms: mean(rights),
        audioTrackRms: microphone === null ? null : mean(microphones),
    };
}

/** A mono 16-bit WAV of a sine: the interviewer a media element plays. */
function toneWav(seconds: number, frequency: number, amplitude: number): Blob {
    const rate = 48000;
    const count = Math.round(seconds * rate);
    const view = new DataView(new ArrayBuffer(44 + count * 2));
    const text = (offset: number, value: string): void => {
        for (let index = 0; index < value.length; index++) {
            view.setUint8(offset + index, value.charCodeAt(index));
        }
    };

    text(0, 'RIFF');
    view.setUint32(4, 36 + count * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, count * 2, true);

    for (let index = 0; index < count; index++) {
        const sample =
            amplitude * Math.sin((2 * Math.PI * frequency * index) / rate);
        view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
    }

    return new Blob([view.buffer], { type: 'audio/wav' });
}

/**
 * The host's interviewer as an <audio> element (a 20 s 440 Hz tone at
 * 0.5), mixed into two conversation graphs in a row, as a take, a stop and
 * a second take do: prepare(), mix(element), resume(), read the right
 * channel of cameraAudio() every 100 ms for 1.5 s after a 0.5 s settle,
 * then release(), which closes the graph. Returns each graph's state while
 * it was read, the mean right channel RMS of each, every console warning
 * mix() gave, and whether the element still plays after the second
 * release. No recorder is needed, so this runs in every engine.
 */
export async function elementMixTwice(): Promise<{
    contexts: AudioContextState[];
    rightRms: number[];
    warnings: string[];
    paused: boolean;
    advancedS: number;
    elementPlaying: boolean;
}> {
    // Longer than the whole probe, so currentTime never wraps around a loop between two reads.
    const url = URL.createObjectURL(toneWav(20, 440, 0.5));
    const element = new Audio(url);
    document.body.append(element);
    await Promise.race([element.play().catch(() => undefined), sleep(1000)]);
    const contexts: AudioContextState[] = [];
    const rightRms: number[] = [];
    const warnings: string[] = [];
    const warn = console.warn;

    try {
        for (let take = 0; take < 2; take++) {
            const rig = recordingRig('conversation', { audio: true });
            await rig.engine.prepare();
            const graph = rig.engine.audio();

            if (graph === null) {
                throw new Error('prepare() built no audio graph.');
            }

            console.warn = (...args: unknown[]) => {
                warnings.push(args.map(String).join(' '));
            };
            graph.mix(element);
            console.warn = warn;
            await graph.resume();
            const splitter = graph.context.createChannelSplitter(2);
            const right = analyserOn(graph.context);
            graph.context
                .createMediaStreamSource(new MediaStream(graph.cameraAudio()))
                .connect(splitter);
            splitter.connect(right, 1);
            const buffer = new Float32Array(2048);
            const rights: number[] = [];
            await sleep(500);

            for (let read = 0; read < 15; read++) {
                await sleep(100);
                rights.push(analyserRms(right, buffer));
            }

            contexts.push(graph.context.state);
            rightRms.push(mean(rights));
            rig.engine.release();
            await stateAfterClose(graph.context, 2000);
        }

        const before = element.currentTime;
        await sleep(1000);

        return {
            contexts,
            rightRms,
            warnings,
            paused: element.paused,
            advancedS: element.currentTime - before,
            elementPlaying: !element.paused && element.currentTime !== before,
        };
    } finally {
        console.warn = warn;
        element.pause();
        element.remove();
        URL.revokeObjectURL(url);
    }
}

/** The types the signals probe has collected, in order. */
const probeEvents: string[] = [];

/** Starts the page signals on the real window, document and navigator, collecting the event types. */
export function startSignalsProbe(): void {
    probeEvents.length = 0;
    const env = browserEnvironment();
    const clock = createClock(env);
    startSignals({
        page: { win: window, doc: document, nav: navigator },
        env,
        clock,
        emit: (type) => {
            probeEvents.push(type);

            return null;
        },
    });
}

export function signalEvents(): string[] {
    return [...probeEvents];
}

/**
 * Asks for fullscreen once the transient user activation Playwright's
 * evaluate grants (5 s in Chromium) has run out, so the request has no
 * gesture behind it.
 */
export async function fullscreenOutsideGesture(): Promise<ActionResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 6000));

    return requestFullscreen(document.body, document);
}

/**
 * FittVideo.session() over the monitor fixture with the real browser seams,
 * prepare() with no attachPreview() call, then the synthetic camera freezes
 * after 1000 ms. Returns the event types onEvent saw by 4000 ms later. The
 * fixture's API (127.0.0.1:8123) is not running in test:browser, so every
 * upload fails and stays local; nothing here needs it.
 */
export async function stallProbe(): Promise<string[]> {
    const session = FittVideo.session(monitorDescriptor);
    const types: string[] = [];
    session.onEvent((event) => types.push(event.type));

    try {
        await session.prepare();
        await sleep(1000);
        window.__fakeFreezeCamera?.(true);
        await sleep(4000);

        return [...types];
    } finally {
        window.__fakeFreezeCamera?.(false);
        session.destroy();
    }
}

/**
 * FittVideo.session() over the answer fixture: prepare(), 6000 ms of the
 * synthetic tone, the meter and state.audio read, then the microphone's gain
 * set to 0 and state.audio read again 6500 ms later, with the event types.
 */
export async function silenceProbe(): Promise<{
    level: number;
    before: 'ok' | 'silent';
    after: 'ok' | 'silent';
    events: string[];
}> {
    const session = FittVideo.session(answerDescriptor);
    const types: string[] = [];
    session.onEvent((event) => types.push(event.type));

    try {
        await session.prepare();
        await sleep(6000);
        const level = session.audioLevel;
        const before = session.state.audio;
        window.__fakeMicGain?.(0);
        await sleep(6500);

        return {
            level,
            before,
            after: session.state.audio,
            events: [...types],
        };
    } finally {
        window.__fakeMicGain?.(0.08);
        session.destroy();
    }
}

/** One API call the end-to-end page made: `body` is the request body of an /events call, absent otherwise. */
export interface E2eCall {
    method: string;
    url: string;
    status: number;
    at: number;
    online: boolean;
    body?: string;
}

let e2eSession: FittSession | null = null;
const e2eCalls: E2eCall[] = [];
const e2eEvents: string[] = [];

function e2eCurrent(): FittSession {
    if (e2eSession === null) {
        throw new Error('e2e.open() was not called.');
    }

    return e2eSession;
}

/**
 * The end-to-end contract spec's hold on one real session
 * (FittVideo.session() with the browser's seams). Every API call goes
 * through options.environment.fetch, which logs it.
 */
export const e2e = {
    open(descriptor: Descriptor, options: SessionOptions = {}): void {
        e2eCalls.length = 0;
        e2eEvents.length = 0;
        const logged = (url: string, init: RequestInit): Promise<Response> => {
            const entry: E2eCall = {
                method: init.method ?? 'GET',
                url,
                status: 0,
                at: performance.now(),
                online: navigator.onLine,
            };

            if (/\/events$/.test(url) && typeof init.body === 'string') {
                entry.body = init.body;
            }

            e2eCalls.push(entry);

            return fetch(url, init).then((response) => {
                entry.status = response.status;

                return response;
            });
        };
        e2eSession = FittVideo.session(descriptor, {
            ...options,
            environment: { ...options.environment, fetch: logged },
        });
        e2eSession.onEvent((event) => e2eEvents.push(event.type));
    },
    prepare: (): Promise<void> => e2eCurrent().prepare(),
    start: (): Promise<void> => e2eCurrent().start(),
    stop: (): Promise<void> => e2eCurrent().stop(),
    reset: (): Promise<void> => e2eCurrent().reset(),
    finalise: (): Promise<void> => e2eCurrent().finalise(),
    state: (): SessionState => e2eCurrent().state,
    /** The types of every event the session raised, in order. */
    events: (): string[] => [...e2eEvents],
    calls: (): E2eCall[] => e2eCalls.map((call) => ({ ...call })),
    /** The stored runs and the stored segment count per track, with the batch_seq of the first batch this page sent. */
    async local(): Promise<{
        runs: RunRecord[];
        counts: { camera: number; audio: number };
        firstBatchSeqAfterReload: number | null;
    }> {
        const id = e2eCurrent().id;
        const store = await openIdbStore(indexedDB);

        try {
            const segments = await store.listSegments(id);
            const firstBatch = e2eCalls.find((call) => call.body !== undefined);

            return {
                runs: await store.listRuns(id),
                counts: {
                    camera: segments.filter((each) => each.track === 'camera')
                        .length,
                    audio: segments.filter((each) => each.track === 'audio')
                        .length,
                },
                firstBatchSeqAfterReload:
                    firstBatch?.body === undefined
                        ? null
                        : (JSON.parse(firstBatch.body) as { batch_seq: number })
                              .batch_seq,
            };
        } finally {
            store.close();
        }
    },
    /** A host re-render with a (re-minted) descriptor: the same session object takes it. */
    setDescriptor(descriptor: Descriptor): void {
        FittVideo.session(descriptor);
    },
};
