import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MemoryQueueStore,
    openStore,
    resilientStore,
    type SegmentRecord,
} from '../../src/core/store.ts';
import { STORE_CASES } from '../shared/store-suite.ts';
import { segmentRecord, sessionRecord, SID } from '../support/records.ts';

for (const storeCase of STORE_CASES) {
    test(`memory store: ${storeCase.name}`, () =>
        storeCase.run(new MemoryQueueStore()));
}

test('an IndexedDB that cannot open, or is missing, gives the memory store, reported as open_failed', async () => {
    const refusing = {
        open() {
            throw new DOMException('denied', 'SecurityError');
        },
    } as unknown as IDBFactory;

    for (const factory of [refusing, undefined]) {
        const opened = await openStore(factory);
        assert.equal(opened.store.kind, 'memory');
        assert.equal(opened.unavailable, 'open_failed');
    }
});

class FullOnThirdPut extends MemoryQueueStore {
    puts = 0;

    override async putSegment(record: SegmentRecord): Promise<void> {
        this.puts += 1;

        if (this.puts === 3) {
            throw new DOMException('full', 'QuotaExceededError');
        }

        return super.putSegment(record);
    }
}

test('a full disk moves the queue to memory once, keeping every record', async () => {
    const reasons: string[] = [];
    const store = resilientStore(new FullOnThirdPut(), (reason) =>
        reasons.push(reason),
    );

    for (const seq of [0, 1, 2, 3]) {
        await store.putSegment(segmentRecord({ seq }));
    }

    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => s.seq),
        [0, 1, 2, 3],
    );
    assert.deepEqual(reasons, ['quota']);
    assert.equal(store.kind, 'memory');
});

test('after the quota switch, putSession still reaches the primary', async () => {
    const primary = new FullOnThirdPut();
    const store = resilientStore(primary, () => undefined);

    for (const seq of [0, 1, 2]) {
        await store.putSegment(segmentRecord({ seq }));
    }

    await store.putSession(sessionRecord({ next_batch_seq: 7 }));

    assert.equal((await primary.getSession(SID))?.next_batch_seq, 7);
});

test('after the quota switch, frees and deletes also reach the primary, and nothing was copied into memory', async () => {
    const primary = new FullOnThirdPut();
    const store = resilientStore(primary, () => undefined);
    const other = '01jbz8q4w6x0k3m5n7p9r2t4bb';
    await store.putSegment(segmentRecord({ seq: 0 }));
    await store.putSegment(segmentRecord({ session_id: other, seq: 1 }));
    await store.putSegment(segmentRecord({ seq: 2 })); // the third put throws: the switch, retried in memory
    assert.equal(await store.storedBytes(), 900); // a copy into memory would count the first two again
    await store.putSegment({
        ...segmentRecord({ seq: 0 }),
        state: 'delivered',
        data: null,
    });
    await store.deleteSession(other);

    assert.deepEqual(
        (await primary.listSegments(SID)).map((s) => [s.seq, s.data]),
        [[0, null]],
    );
    assert.deepEqual(await primary.listSegments(other), []);
    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => [s.seq, s.data === null]),
        [
            [0, true],
            [2, false],
        ],
    );
    assert.equal(await store.storedBytes(), 300);
});

class AlwaysFull extends MemoryQueueStore {
    override async putSegment(): Promise<void> {
        await Promise.resolve();

        throw new DOMException('full', 'QuotaExceededError');
    }

    override async updateSegment(): Promise<SegmentRecord | undefined> {
        throw new DOMException('full', 'QuotaExceededError');
    }
}

test('two writes that hit a full disk together share one memory store, and quota is raised once', async () => {
    const reasons: string[] = [];
    const store = resilientStore(new AlwaysFull(), (reason) =>
        reasons.push(reason),
    );

    await Promise.all([
        store.putSegment(segmentRecord({ seq: 0 })),
        store.putSegment(segmentRecord({ seq: 1 })),
    ]);

    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => s.seq),
        [0, 1],
    );
    assert.deepEqual(reasons, ['quota']);
});

test('an update the full primary refuses is made in memory from the primary row', async () => {
    const reasons: string[] = [];
    const primary = new AlwaysFull();
    await MemoryQueueStore.prototype.putSegment.call(
        primary,
        segmentRecord({ seq: 1 }),
    );
    const store = resilientStore(primary, (reason) => reasons.push(reason));

    const next = await store.updateSegment(
        { session_id: SID, track: 'camera', take: 1, run_index: 0, seq: 1 },
        (current) => ({ ...current, failures: current.failures + 1 }),
    );

    assert.equal(next?.failures, 1);
    assert.equal(
        (
            await store.getSegment({
                session_id: SID,
                track: 'camera',
                take: 1,
                run_index: 0,
                seq: 1,
            })
        )?.failures,
        1,
    );
    assert.deepEqual(reasons, ['quota']);
    assert.equal(store.kind, 'memory');
});

test('after the quota switch, updateSegment changes a row where it lives, and a free also reaches the primary', async () => {
    const primary = new FullOnThirdPut();
    const store = resilientStore(primary, () => undefined);
    const key = (seq: number) => ({
        session_id: SID,
        track: 'camera' as const,
        take: 1,
        run_index: 0,
        seq,
    });
    const deliver = (current: SegmentRecord): SegmentRecord => ({
        ...current,
        state: 'delivered',
        data: null,
    });

    for (const seq of [0, 1, 2]) {
        await store.putSegment(segmentRecord({ seq }));
    }

    await store.updateSegment(key(0), deliver);
    await store.updateSegment(key(2), deliver);

    assert.deepEqual(
        (await primary.listSegments(SID)).map((s) => [s.seq, s.data === null]),
        [
            [0, true],
            [1, false],
            [2, true],
        ],
    );
    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => [s.seq, s.state]),
        [
            [0, 'delivered'],
            [1, 'pending'],
            [2, 'delivered'],
        ],
    );
    assert.equal(await store.storedBytes(), 300);
});
