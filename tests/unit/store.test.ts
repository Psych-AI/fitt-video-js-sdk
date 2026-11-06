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
