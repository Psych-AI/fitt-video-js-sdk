import type { QueueStore, SegmentKey, SegmentRecord } from './store.ts';

/**
 * The abandon rules (author's call 8). A media segment is given up only by
 * age or by the budget, never by its failure count, and a seq 0 never.
 */
export interface Queue {
    add(record: SegmentRecord): Promise<'stored' | 'abandoned'>;
    /** Pending records read back after a reload. */
    adopt(records: SegmentRecord[]): void;
    /** perfNowMs: env.perfNow(), so a wall-clock change ages nothing (author's call 7). */
    sweep(perfNowMs: number): Promise<SegmentRecord[]>;
}

export interface QueuePolicy {
    abandonAfterMs: number;
    budgetBytes: number;
    perfNow(): number;
}

interface Watched {
    key: SegmentKey;
    created_perf_ms: number;
}

/** The init (seq 0) of a run is never abandoned: the server needs it to start the run. */
function exempt(record: SegmentRecord): boolean {
    return record.seq === 0 || record.kind === 'init';
}

function keyOf(record: SegmentRecord): SegmentKey {
    return {
        session_id: record.session_id,
        track: record.track,
        take: record.take,
        run_index: record.run_index,
        seq: record.seq,
    };
}

export function createQueue(store: QueueStore, policy: QueuePolicy): Queue {
    /** Pending media records with the performance.now() at which this page first saw them. */
    let watched: Watched[] = [];
    /** add() runs one at a time, so two cuts never both fit a budget only one fits. */
    let tail: Promise<unknown> = Promise.resolve();

    const watch = (record: SegmentRecord): void => {
        if (record.state === 'pending' && !exempt(record)) {
            watched.push({
                key: keyOf(record),
                created_perf_ms: policy.perfNow(),
            });
        }
    };

    const storeOne = async (
        record: SegmentRecord,
    ): Promise<'stored' | 'abandoned'> => {
        if (
            !exempt(record) &&
            (await store.storedBytes()) + record.bytes > policy.budgetBytes
        ) {
            await store.putSegment({
                ...record,
                state: 'abandoned',
                data: null,
            });

            return 'abandoned';
        }

        await store.putSegment(record);
        watch(record);

        return 'stored';
    };

    return {
        add(record: SegmentRecord): Promise<'stored' | 'abandoned'> {
            const added = tail.then(() => storeOne(record));
            tail = added.catch(() => undefined);

            return added;
        },
        adopt(records: SegmentRecord[]): void {
            for (const record of records) {
                watch(record);
            }
        },
        async sweep(perfNowMs: number): Promise<SegmentRecord[]> {
            const due = watched.filter(
                (entry) =>
                    perfNowMs - entry.created_perf_ms > policy.abandonAfterMs,
            );
            watched = watched.filter((entry) => !due.includes(entry));
            const abandoned: SegmentRecord[] = [];

            for (const entry of due) {
                const record = await store.getSegment(entry.key);

                if (record === undefined || record.state !== 'pending') {
                    continue;
                }

                const given: SegmentRecord = {
                    ...record,
                    state: 'abandoned',
                    data: null,
                };
                await store.putSegment(given);
                abandoned.push(given);
            }

            return abandoned;
        },
    };
}
