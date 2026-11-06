import type {
    QueueStore,
    SegmentRecord,
    SessionRecord,
} from '../../src/core/store.ts';

export interface StoreCase {
    name: string;
    run(store: QueueStore): Promise<void>;
}

const SID = '01jbz8q4w6x0k3m5n7p9r2t4aa';

function same(actual: unknown, expected: unknown, what: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);

    if (a !== e) {
        throw new Error(`${what}: got ${a}, expected ${e}`);
    }
}

function segment(overrides: Partial<SegmentRecord>): SegmentRecord {
    const seq = overrides.seq ?? 1;

    return {
        session_id: SID,
        track: 'camera',
        take: 1,
        run_index: 0,
        run_id: '01jbz8q4w6x0k3m5n7p9r2t4v6',
        seq,
        kind: seq === 0 ? 'init' : 'media',
        start_ms: 0,
        duration_ms: 0,
        recorded_at: 1_762_400_000_000,
        bytes: 3,
        sha256: 'ab'.repeat(32),
        part_count: 1,
        created_ms: 0,
        state: 'pending',
        failures: 0,
        init: null,
        data: new Uint8Array([1, 2, 3]).buffer,
        ...overrides,
    };
}

export const STORE_CASES: StoreCase[] = [
    {
        name: 'a 1,048,576 byte segment reads back equal',
        async run(store) {
            const data = new Uint8Array(1_048_576).map(
                (_, i) => (i * 31) & 0xff,
            );
            await store.putSegment(
                segment({ data: data.buffer, bytes: data.length }),
            );
            const [read] = await store.listSegments(SID);
            const bytes = new Uint8Array(read.data ?? new ArrayBuffer(0));

            same(bytes.length, 1_048_576, 'length');
            same(
                bytes.every((value, i) => value === ((i * 31) & 0xff)),
                true,
                'every byte',
            );
            same(await store.storedBytes(), 1_048_576, 'stored bytes');
        },
    },
    {
        name: 'segments list in track, take, run, seq order whatever the put order',
        async run(store) {
            const keys = [
                ['camera', 1, 1, 0],
                ['audio', 1, 0, 1],
                ['camera', 1, 0, 2],
                ['camera', 2, 0, 0],
                ['audio', 1, 0, 0],
                ['camera', 1, 0, 0],
            ] as const;

            for (const [track, take, run_index, seq] of keys) {
                await store.putSegment(
                    segment({ track, take, run_index, seq }),
                );
            }

            same(
                (await store.listSegments(SID)).map((s) => [
                    s.track,
                    s.take,
                    s.run_index,
                    s.seq,
                ]),
                [
                    ['audio', 1, 0, 0],
                    ['audio', 1, 0, 1],
                    ['camera', 1, 0, 0],
                    ['camera', 1, 0, 2],
                    ['camera', 1, 1, 0],
                    ['camera', 2, 0, 0],
                ],
                'order',
            );
        },
    },
    {
        name: 'delivering frees the bytes and keeps the manifest record',
        async run(store) {
            const record = segment({
                seq: 4,
                bytes: 3,
                sha256: 'cd'.repeat(32),
            });
            await store.putSegment(record);
            await store.putSegment({
                ...record,
                state: 'delivered',
                data: null,
            });
            const [read] = await store.listSegments(SID);

            same(
                [read.state, read.data, read.bytes, read.sha256],
                ['delivered', null, 3, 'cd'.repeat(32)],
                'record',
            );
            same(await store.storedBytes(), 0, 'stored bytes');
        },
    },
    {
        name: 'a deleted session takes its session record, runs, segments and batches with it',
        async run(store) {
            await store.putSession({
                session_id: SID,
            } as unknown as SessionRecord);
            await store.putSegment(segment({ seq: 0 }));
            await store.putBatch({
                session_id: SID,
                batch_seq: 0,
                take: 1,
                body: '{}',
                payload_bytes: 0,
            });
            await store.deleteSession(SID);

            same(
                [
                    (await store.listSegments(SID)).length,
                    (await store.listBatches(SID)).length,
                    (await store.listRuns(SID)).length,
                ],
                [0, 0, 0],
                'left',
            );
            same(
                [
                    await store.getSession(SID),
                    (await store.listSessions()).length,
                ],
                [undefined, 0],
                'session left',
            );
        },
    },
    {
        name: 'storedBytes() follows puts, frees and deletes, and a deleted session no longer counts',
        async run(store) {
            await store.putSegment(segment({ seq: 1, bytes: 3 }));
            await store.putSegment(segment({ seq: 2, bytes: 3 }));
            same(await store.storedBytes(), 6, 'after two puts');
            await store.putSegment({
                ...segment({ seq: 1, bytes: 3 }),
                state: 'delivered',
                data: null,
            });
            same(await store.storedBytes(), 3, 'after a free');
            await store.deleteSegment({
                session_id: SID,
                track: 'camera',
                take: 1,
                run_index: 0,
                seq: 2,
            });
            same(await store.storedBytes(), 0, 'after a delete');
            await store.putSegment(segment({ seq: 3, bytes: 3 }));
            await store.deleteSession(SID);
            same(await store.storedBytes(), 0, 'after deleteSession');
        },
    },
];
