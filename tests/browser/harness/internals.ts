/** What the browser specs call through `window.internals`. Later tasks add the functions their specs need. */
import {
    openIdbStore,
    transaction,
    type BatchRecord,
    type RunRecord,
    type SegmentRecord,
    type SessionRecord,
} from '../../../src/core/store.ts';
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
