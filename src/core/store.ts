import type { SegmentKind, Segmenting } from '../cut/types.ts';
import type { AnchorSource } from './clock.ts';
import type { Descriptor, TrackName } from './descriptor.ts';

/**
 * The local queue's storage (spec 6.3): one interface with an IndexedDB
 * store and a memory store. Bytes are kept as ArrayBuffer, never Blob.
 */
export type Transport = 'put' | 'post';
export type RunEndedReason =
    | 'stop'
    | 'reload'
    | 'device_switch'
    | 'clock_jump'
    | 'recorder_error'
    | 'backgrounded'
    | 'unknown';
export type SegmentState =
    'pending' | 'delivered' | 'abandoned' | 'rejected' | 'dropped';

export interface SessionRecord {
    session_id: string;
    descriptor: Descriptor;
    epoch_ms: number;
    take: number;
    take_start_ms: number | null;
    take_open: boolean;
    /** The end_ms the take's manifests were built with at stop() (or the deferred seal's end); null until a take stops. finalise() sends it. */
    take_end_ms: number | null;
    next_batch_seq: number;
    ladder_rung: Transport;
    ever_succeeded: boolean;
    stop_completed: boolean;
    /** The take whose checks verdict was reject; null otherwise. resume() never finalises it. */
    rejected_take: number | null;
    /** Set before the first /discard request; the session is never uploaded or finalised again. */
    pending_discard: boolean;
    /** Date.now() of the last local write, for the purge rule. */
    last_activity_ms: number;
    /** Date.now() at which the held token expires. */
    token_expires_at_ms: number;
    /** The take a /reset was sent for and not yet acknowledged; finished before anything else after a reload. */
    pending_reset_take: number | null;
    /** Track to take: a manifest that is owed and not yet answered 200 or a final 409. */
    manifest_owed: Partial<Record<TrackName, number>>;
    /** The highest session time handed out, the clock's floor after a reload. */
    max_session_ms: number;
    /** True on the tombstone a finalised session leaves (Task 15 item 10); everything but session_id, epoch_ms and next_batch_seq is then stale. */
    finalised: boolean;
    /** The tombstone's end: token_expires_at_ms + 60,000. The purge sweep deletes the tombstone after it. null until finalised. */
    expires_at_ms: number | null;
}

export interface RunRecord {
    session_id: string;
    track: TrackName;
    take: number;
    run_index: number;
    run_id: string;
    anchor_ms: number;
    anchor_source: AnchorSource;
    mime_type: string;
    started_ms: number;
    ended_ms: number | null;
    ended_reason: RunEndedReason | null;
    segmenting: Segmenting;
    keyframe_option_honoured: boolean | null;
    ua: string;
}

export interface InitFields {
    anchor_ms: number;
    anchor_source: AnchorSource;
    mime: string;
    started_ms: number;
}

export interface SegmentRecord {
    session_id: string;
    track: TrackName;
    take: number;
    run_index: number;
    run_id: string;
    seq: number;
    kind: SegmentKind;
    start_ms: number;
    duration_ms: number;
    recorded_at: number;
    bytes: number;
    sha256: string;
    part_count: number;
    /** Session time the segment was cut, for the age rule. */
    created_ms: number;
    state: SegmentState;
    failures: number;
    /** Seq 0 of a chunked run only. */
    init: InitFields | null;
    /** Freed (null) once delivered, abandoned, rejected or dropped; the record stays for the manifest. */
    data: ArrayBuffer | null;
}

export interface BatchRecord {
    session_id: string;
    batch_seq: number;
    take: number;
    body: string;
    payload_bytes: number;
}

export type SegmentKey = Pick<
    SegmentRecord,
    'session_id' | 'track' | 'take' | 'run_index' | 'seq'
>;

export type SegmentChange = (
    current: SegmentRecord,
) => SegmentRecord | undefined;

export interface QueueStore {
    readonly kind: 'indexeddb' | 'memory';
    putSession(record: SessionRecord): Promise<void>;
    getSession(sessionId: string): Promise<SessionRecord | undefined>;
    listSessions(): Promise<SessionRecord[]>;
    /** With its runs, segments and batches, by the session_id key range, even when no session record exists. */
    deleteSession(sessionId: string): Promise<void>;
    putRun(record: RunRecord): Promise<void>;
    /** In track, take, run_index order. */
    listRuns(sessionId: string): Promise<RunRecord[]>;
    putSegment(record: SegmentRecord): Promise<void>;
    /** One segment by its key, so a caller never lists a session's bytes to read one record. */
    getSegment(key: SegmentKey): Promise<SegmentRecord | undefined>;
    /**
     * Reads one segment and writes `change(current)` in one atomic step, so no
     * other write lands in between. Nothing is written when the segment is
     * missing or `change` returns undefined. `change` must be synchronous and
     * keep the key. Resolves with what was written.
     */
    updateSegment(
        key: SegmentKey,
        change: SegmentChange,
    ): Promise<SegmentRecord | undefined>;
    /** In track, take, run_index, seq order. */
    listSegments(sessionId: string): Promise<SegmentRecord[]>;
    deleteSegment(key: SegmentKey): Promise<void>;
    putBatch(record: BatchRecord): Promise<void>;
    /** In batch_seq order. */
    listBatches(sessionId: string): Promise<BatchRecord[]>;
    deleteBatch(sessionId: string, batchSeq: number): Promise<void>;
    /** The bytes of every segment whose data is still held. */
    storedBytes(): Promise<number>;
}

/** An IndexedDB store that can also close its connection. */
export interface IdbQueueStore extends QueueStore {
    close(): void;
}

type KeyPart = string | number;

const RUN_KEY = ['session_id', 'track', 'take', 'run_index'] as const;
const SEGMENT_KEY = [
    'session_id',
    'track',
    'take',
    'run_index',
    'seq',
] as const;
const BATCH_KEY = ['session_id', 'batch_seq'] as const;

function keyOf(record: object, fields: readonly string[]): KeyPart[] {
    const values = record as Record<string, KeyPart>;

    return fields.map((field) => values[field]);
}

/** Strings compared as strings, numbers as numbers, field by field, as IndexedDB orders array keys. */
function compareKeys(a: KeyPart[], b: KeyPart[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] < b[i]) {
            return -1;
        }

        if (a[i] > b[i]) {
            return 1;
        }
    }

    return a.length - b.length;
}

function sortedBy<T extends object>(
    records: Iterable<T>,
    fields: readonly string[],
): T[] {
    return [...records].sort((a, b) =>
        compareKeys(keyOf(a, fields), keyOf(b, fields)),
    );
}

/** Joined with a separator no ULID, track name or number contains. */
function joined(record: object, fields: readonly string[]): string {
    return keyOf(record, fields).join('\u0000');
}

function heldBytesOf(record: SegmentRecord): number {
    return record.data === null ? 0 : record.data.byteLength;
}

/**
 * Spec 6.3's queue when IndexedDB cannot open, and the overflow store when
 * it is full. Records are copied on the way in and out; bytes never are.
 */
export class MemoryQueueStore implements QueueStore {
    readonly kind = 'memory' as const;
    #sessions = new Map<string, SessionRecord>();
    #runs = new Map<string, RunRecord>();
    #segments = new Map<string, SegmentRecord>();
    #batches = new Map<string, BatchRecord>();

    async putSession(record: SessionRecord): Promise<void> {
        this.#sessions.set(record.session_id, { ...record });
    }

    async getSession(sessionId: string): Promise<SessionRecord | undefined> {
        const record = this.#sessions.get(sessionId);

        return record === undefined ? undefined : { ...record };
    }

    async listSessions(): Promise<SessionRecord[]> {
        return sortedBy(this.#sessions.values(), ['session_id']).map(
            (record) => ({ ...record }),
        );
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.#sessions.delete(sessionId);

        for (const rows of [this.#runs, this.#segments, this.#batches]) {
            for (const [key, row] of rows) {
                if (row.session_id === sessionId) {
                    rows.delete(key);
                }
            }
        }
    }

    async putRun(record: RunRecord): Promise<void> {
        this.#runs.set(joined(record, RUN_KEY), { ...record });
    }

    async listRuns(sessionId: string): Promise<RunRecord[]> {
        return this.#list(this.#runs, sessionId, RUN_KEY);
    }

    async putSegment(record: SegmentRecord): Promise<void> {
        this.#segments.set(joined(record, SEGMENT_KEY), { ...record });
    }

    async getSegment(key: SegmentKey): Promise<SegmentRecord | undefined> {
        const record = this.#segments.get(joined(key, SEGMENT_KEY));

        return record === undefined ? undefined : { ...record };
    }

    /** No await inside, so the read and the write are one step. */
    async updateSegment(
        key: SegmentKey,
        change: SegmentChange,
    ): Promise<SegmentRecord | undefined> {
        const current = this.#segments.get(joined(key, SEGMENT_KEY));
        const next = current === undefined ? undefined : change({ ...current });

        if (next === undefined) {
            return undefined;
        }

        this.#segments.set(joined(next, SEGMENT_KEY), { ...next });

        return { ...next };
    }

    /** Synchronous, for resilientStore() to know where a row lives. */
    hasSegment(key: SegmentKey): boolean {
        return this.#segments.has(joined(key, SEGMENT_KEY));
    }

    async listSegments(sessionId: string): Promise<SegmentRecord[]> {
        return this.#list(this.#segments, sessionId, SEGMENT_KEY);
    }

    async deleteSegment(key: SegmentKey): Promise<void> {
        this.#segments.delete(joined(key, SEGMENT_KEY));
    }

    async putBatch(record: BatchRecord): Promise<void> {
        this.#batches.set(joined(record, BATCH_KEY), { ...record });
    }

    async listBatches(sessionId: string): Promise<BatchRecord[]> {
        return this.#list(this.#batches, sessionId, BATCH_KEY);
    }

    async deleteBatch(sessionId: string, batchSeq: number): Promise<void> {
        this.#batches.delete(
            joined({ session_id: sessionId, batch_seq: batchSeq }, BATCH_KEY),
        );
    }

    async storedBytes(): Promise<number> {
        let total = 0;

        for (const record of this.#segments.values()) {
            total += heldBytesOf(record);
        }

        return total;
    }

    #list<T extends { session_id: string }>(
        rows: Map<string, T>,
        sessionId: string,
        fields: readonly string[],
    ): T[] {
        return sortedBy(
            [...rows.values()].filter((row) => row.session_id === sessionId),
            fields,
        ).map((row) => ({ ...row }));
    }
}

const DB_NAME = 'fitt-video';
const DB_VERSION = 1;
const STORES = {
    sessions: 'session_id',
    runs: [...RUN_KEY],
    segments: [...SEGMENT_KEY],
    batches: [...BATCH_KEY],
    /** {session_id, track, take, run_index, seq, bytes} per segment that holds data, so the total never reads bytes back. */
    segment_bytes: [...SEGMENT_KEY],
} as const;
type StoreName = keyof typeof STORES;
const ALL_STORES = Object.keys(STORES) as StoreName[];

interface HeldRow {
    bytes: number;
}

function sumHeld(rows: HeldRow[]): number {
    return rows.reduce((total, row) => total + row.bytes, 0);
}

/**
 * Runs `body` in one transaction and resolves with its value once the
 * transaction completes. A failed request rejects with the request's own
 * error: its error event reaches the transaction before the abort sets
 * `tx.error`, so `tx.error` is still null then.
 */
export function transaction<T>(
    db: IDBDatabase,
    names: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => () => T,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(names, mode);
        const read = body(tx);
        tx.oncomplete = () => resolve(read());
        tx.onerror = (event) =>
            reject(
                (event.target as IDBRequest | null)?.error ??
                    tx.error ??
                    new Error('A request failed.'),
            );
        tx.onabort = () =>
            reject(tx.error ?? new Error('The transaction aborted.'));
    });
}

/**
 * The IndexedDB store: database `fitt-video`, version 1. Every call is one
 * transaction. A running total of the bytes held is built at open from
 * `segment_bytes` and kept in step with every segment write.
 */
export function openIdbStore(factory: IDBFactory): Promise<IdbQueueStore> {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;

            for (const name of ALL_STORES) {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, {
                        keyPath: STORES[name] as string | string[],
                    });
                }
            }
        };
        let refused = false;
        request.onsuccess = () => {
            if (refused) {
                request.result.close();
            } else {
                resolve(request.result);
            }
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            refused = true;
            reject(new Error('The fitt-video database is blocked.'));
        };
    }).then(async (db) => {
        db.onversionchange = () => db.close();
        const store = idbStore(db);
        await store.load();

        return store;
    });
}

function idbStore(db: IDBDatabase): IdbQueueStore & { load(): Promise<void> } {
    let heldBytes = 0;

    const range = (sessionId: string): IDBKeyRange =>
        IDBKeyRange.bound([sessionId], [sessionId, []]);

    const run = <T>(
        names: StoreName[],
        mode: IDBTransactionMode,
        body: (tx: IDBTransaction) => () => T,
    ): Promise<T> => transaction(db, names, mode, body);

    /** Puts a segment and its segment_bytes row in `tx`; resolves to the change in bytes held once `before` (the old segment_bytes row) is read. */
    const writeSegment = (
        tx: IDBTransaction,
        record: SegmentRecord,
        before: IDBRequest,
    ): (() => number) => {
        const held = heldBytesOf(record);
        const sizes = tx.objectStore('segment_bytes');

        if (held > 0) {
            sizes.put({ ...segmentKeyOf(record), bytes: held });
        } else {
            sizes.delete(keyOf(record, SEGMENT_KEY));
        }

        tx.objectStore('segments').put(record);

        return () =>
            held - ((before.result as HeldRow | undefined)?.bytes ?? 0);
    };

    const getAll = <T>(name: StoreName, query?: IDBKeyRange): Promise<T[]> =>
        run([name], 'readonly', (tx) => {
            const request = tx.objectStore(name).getAll(query);

            return () => request.result as T[];
        });

    const put = (name: StoreName, record: object): Promise<void> =>
        run([name], 'readwrite', (tx) => {
            tx.objectStore(name).put(record);

            return () => undefined;
        });

    return {
        kind: 'indexeddb',
        close: () => db.close(),
        async load(): Promise<void> {
            heldBytes = sumHeld(await getAll<HeldRow>('segment_bytes'));
        },
        putSession: (record) => put('sessions', record),
        getSession: (sessionId) =>
            run(['sessions'], 'readonly', (tx) => {
                const request = tx.objectStore('sessions').get(sessionId);

                return () => request.result as SessionRecord | undefined;
            }),
        listSessions: () => getAll<SessionRecord>('sessions'),
        async deleteSession(sessionId: string): Promise<void> {
            const freed = await run(ALL_STORES, 'readwrite', (tx) => {
                const held = tx
                    .objectStore('segment_bytes')
                    .getAll(range(sessionId));
                tx.objectStore('sessions').delete(sessionId);

                for (const name of ALL_STORES) {
                    if (name !== 'sessions') {
                        tx.objectStore(name).delete(range(sessionId));
                    }
                }

                return () => sumHeld(held.result as HeldRow[]);
            });
            heldBytes -= freed;
        },
        putRun: (record) => put('runs', record),
        listRuns: (sessionId) => getAll<RunRecord>('runs', range(sessionId)),
        async putSegment(record: SegmentRecord): Promise<void> {
            const delta = await run(
                ['segments', 'segment_bytes'],
                'readwrite',
                (tx) =>
                    writeSegment(
                        tx,
                        record,
                        tx
                            .objectStore('segment_bytes')
                            .get(keyOf(record, SEGMENT_KEY)),
                    ),
            );
            heldBytes += delta;
        },
        /** One readwrite transaction: the write is placed from the read's success handler, so nothing lands in between. */
        async updateSegment(
            key: SegmentKey,
            change: SegmentChange,
        ): Promise<SegmentRecord | undefined> {
            let thrown: { error: unknown } | null = null;

            try {
                const { next, delta } = await run(
                    ['segments', 'segment_bytes'],
                    'readwrite',
                    (tx) => {
                        const id = keyOf(key, SEGMENT_KEY);
                        const before = tx.objectStore('segment_bytes').get(id);
                        const current = tx.objectStore('segments').get(id);
                        let written: SegmentRecord | undefined;
                        let deltaOf = (): number => 0;

                        current.onsuccess = () => {
                            const found = current.result as
                                SegmentRecord | undefined;

                            try {
                                written =
                                    found === undefined
                                        ? undefined
                                        : change(found);
                            } catch (error) {
                                thrown = { error };
                                tx.abort();

                                return;
                            }

                            if (written !== undefined) {
                                deltaOf = writeSegment(tx, written, before);
                            }
                        };

                        return () => ({ next: written, delta: deltaOf() });
                    },
                );
                heldBytes += delta;

                return next;
            } catch (error) {
                throw thrown === null
                    ? error
                    : (thrown as { error: unknown }).error;
            }
        },
        getSegment: (key) =>
            run(['segments'], 'readonly', (tx) => {
                const request = tx
                    .objectStore('segments')
                    .get(keyOf(key, SEGMENT_KEY));

                return () => request.result as SegmentRecord | undefined;
            }),
        listSegments: (sessionId) =>
            getAll<SegmentRecord>('segments', range(sessionId)),
        async deleteSegment(key: SegmentKey): Promise<void> {
            const freed = await run(
                ['segments', 'segment_bytes'],
                'readwrite',
                (tx) => {
                    const id = keyOf(key, SEGMENT_KEY);
                    const sizes = tx.objectStore('segment_bytes');
                    const before = sizes.get(id);
                    sizes.delete(id);
                    tx.objectStore('segments').delete(id);

                    return () =>
                        (before.result as HeldRow | undefined)?.bytes ?? 0;
                },
            );
            heldBytes -= freed;
        },
        putBatch: (record) => put('batches', record),
        listBatches: (sessionId) =>
            getAll<BatchRecord>('batches', range(sessionId)),
        deleteBatch: (sessionId, batchSeq) =>
            run(['batches'], 'readwrite', (tx) => {
                tx.objectStore('batches').delete([sessionId, batchSeq]);

                return () => undefined;
            }),
        storedBytes: async () => heldBytes,
    };
}

function segmentKeyOf(record: SegmentKey): SegmentKey {
    return {
        session_id: record.session_id,
        track: record.track,
        take: record.take,
        run_index: record.run_index,
        seq: record.seq,
    };
}

function isQuotaError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'QuotaExceededError'
    );
}

function isFree(record: SegmentRecord): boolean {
    return record.data === null && record.state !== 'pending';
}

/** Both lists merged in key order, the memory row winning on the same key. */
function merged<T extends object>(
    primary: T[],
    memory: T[],
    fields: readonly string[],
): T[] {
    const rows = new Map<string, T>();

    for (const row of [...primary, ...memory]) {
        rows.set(joined(row, fields), row);
    }

    return sortedBy(rows.values(), fields);
}

async function quietly(write: () => Promise<void>): Promise<void> {
    try {
        await write();
    } catch {
        // The primary is full or gone: the memory store holds the truth now.
    }
}

/**
 * A store that moves to memory, once, when the primary throws
 * QuotaExceededError. Nothing is copied: rows already in the primary stay
 * there. After the switch new runs, segments and batches go to memory, the
 * session record still goes to both, and every free and delete reaches both,
 * so a reload never brings back finished work.
 */
export function resilientStore(
    primary: QueueStore,
    onUnavailable: (reason: 'quota') => void,
): QueueStore {
    let memory: MemoryQueueStore | null = null;

    /**
     * The one memory store, made and reported on the first quota error.
     * Writes that were in flight together and all hit the full disk land in
     * this same store, so none of them is lost.
     */
    const split = (): MemoryQueueStore => {
        if (memory === null) {
            memory = new MemoryQueueStore();
            onUnavailable('quota');
        }

        return memory;
    };

    const write = async (
        toPrimary: () => Promise<void>,
        toMemory: (store: MemoryQueueStore) => Promise<void>,
    ): Promise<void> => {
        if (memory === null) {
            try {
                await toPrimary();

                return;
            } catch (error) {
                if (!isQuotaError(error)) {
                    throw error;
                }
            }
        }

        await toMemory(split());
    };

    /** A write that must also reach the primary after the switch: frees, deletes and the session record. */
    const both = (
        toPrimary: () => Promise<void>,
        toMemory: (store: MemoryQueueStore) => Promise<void>,
    ): Promise<void> => {
        if (memory === null) {
            return write(toPrimary, toMemory);
        }

        const split = memory;

        return quietly(toPrimary).then(() => toMemory(split));
    };

    return {
        get kind(): 'indexeddb' | 'memory' {
            return memory === null ? primary.kind : 'memory';
        },
        putSession: (record) =>
            both(
                () => primary.putSession(record),
                (store) => store.putSession(record),
            ),
        async getSession(sessionId: string) {
            return (
                (await memory?.getSession(sessionId)) ??
                primary.getSession(sessionId)
            );
        },
        async listSessions() {
            return merged(
                await primary.listSessions(),
                (await memory?.listSessions()) ?? [],
                ['session_id'],
            );
        },
        deleteSession: (sessionId) =>
            both(
                () => primary.deleteSession(sessionId),
                (store) => store.deleteSession(sessionId),
            ),
        putRun: (record) =>
            write(
                () => primary.putRun(record),
                (store) => store.putRun(record),
            ),
        async listRuns(sessionId: string) {
            return merged(
                await primary.listRuns(sessionId),
                (await memory?.listRuns(sessionId)) ?? [],
                RUN_KEY,
            );
        },
        putSegment(record: SegmentRecord) {
            const toPrimary = () => primary.putSegment(record);
            const toMemory = (store: MemoryQueueStore) =>
                store.putSegment(record);

            return isFree(record)
                ? both(toPrimary, toMemory)
                : write(toPrimary, toMemory);
        },
        async getSegment(key: SegmentKey) {
            return (await memory?.getSegment(key)) ?? primary.getSegment(key);
        },
        /**
         * Changes the row where it lives: in the primary while that takes
         * writes or the row is not in memory, else in memory. A free also
         * reaches the primary, as every free does after the switch.
         */
        async updateSegment(key: SegmentKey, change: SegmentChange) {
            if (memory === null || !memory.hasSegment(key)) {
                try {
                    return await primary.updateSegment(key, change);
                } catch (error) {
                    if (!isQuotaError(error)) {
                        throw error;
                    }
                }
            }

            const overflow = split();
            const base = overflow.hasSegment(key)
                ? undefined
                : await primary.getSegment(key);
            let next: SegmentRecord | undefined;

            if (overflow.hasSegment(key)) {
                next = await overflow.updateSegment(key, change);
            } else {
                next = base === undefined ? undefined : change(base);

                if (next !== undefined) {
                    await overflow.putSegment(next);
                }
            }

            if (next !== undefined && isFree(next)) {
                const freed = next;
                await quietly(() => primary.putSegment(freed));
            }

            return next;
        },
        async listSegments(sessionId: string) {
            return merged(
                await primary.listSegments(sessionId),
                (await memory?.listSegments(sessionId)) ?? [],
                SEGMENT_KEY,
            );
        },
        deleteSegment: (key) =>
            both(
                () => primary.deleteSegment(key),
                (store) => store.deleteSegment(key),
            ),
        putBatch: (record) =>
            write(
                () => primary.putBatch(record),
                (store) => store.putBatch(record),
            ),
        async listBatches(sessionId: string) {
            return merged(
                await primary.listBatches(sessionId),
                (await memory?.listBatches(sessionId)) ?? [],
                BATCH_KEY,
            );
        },
        deleteBatch: (sessionId, batchSeq) =>
            both(
                () => primary.deleteBatch(sessionId, batchSeq),
                (store) => store.deleteBatch(sessionId, batchSeq),
            ),
        async storedBytes() {
            return (
                (await primary.storedBytes()) +
                ((await memory?.storedBytes()) ?? 0)
            );
        },
    };
}

/**
 * The IndexedDB store behind resilientStore(), or the memory store when
 * IndexedDB is missing or cannot open. The caller raises
 * `upload.storage_unavailable {reason}` once for either reason: for
 * `open_failed` from the answer, for `quota` from `onUnavailable`.
 */
export async function openStore(
    factory: IDBFactory | undefined,
    onUnavailable: (reason: 'quota') => void = () => undefined,
): Promise<{ store: QueueStore; unavailable?: 'open_failed' | 'quota' }> {
    if (factory === undefined) {
        return { store: new MemoryQueueStore(), unavailable: 'open_failed' };
    }

    try {
        const idb = await openIdbStore(factory);

        return { store: resilientStore(idb, onUnavailable) };
    } catch {
        return { store: new MemoryQueueStore(), unavailable: 'open_failed' };
    }
}
