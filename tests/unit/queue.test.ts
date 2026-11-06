import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueue } from '../../src/core/queue.ts';
import {
    MemoryQueueStore,
    type SegmentKey,
    type SegmentRecord,
} from '../../src/core/store.ts';
import { fakeEnvironment } from '../support/fake-env.ts';
import { segmentRecord, SID } from '../support/records.ts';

const POLICY = {
    abandonAfterMs: 600_000,
    budgetBytes: 209_715_200,
    perfNow: () => 0,
};

test('a media segment is abandoned by age only, strictly after abandon_after_ms, whatever its failures', async () => {
    const store = new MemoryQueueStore();
    const queue = createQueue(store, POLICY);
    await queue.add(segmentRecord({ seq: 0, created_ms: 0 }));
    await queue.add(segmentRecord({ seq: 1, created_ms: 0, failures: 10_000 }));

    assert.deepEqual(await queue.sweep(600_000), []);
    assert.deepEqual(
        (await queue.sweep(600_001)).map((s) => s.seq),
        [1],
    );
    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => [
            s.seq,
            s.state,
            s.data === null,
        ]),
        [
            [0, 'pending', false],
            [1, 'abandoned', true],
        ],
    );
});

test('a forward wall-clock correction ages nothing: the sweep runs on performance.now()', async () => {
    const env = fakeEnvironment();
    const store = new MemoryQueueStore();
    const queue = createQueue(store, {
        ...POLICY,
        perfNow: () => env.perfNow(),
    });
    await queue.add(segmentRecord({ seq: 1, created_ms: 0 }));
    env.shiftWall(900_000);

    assert.deepEqual(await queue.sweep(env.perfNow()), []);
});

test('an incoming media segment that would pass the budget is abandoned and never stored, and a seq 0 always is', async () => {
    const store = new MemoryQueueStore();
    const queue = createQueue(store, POLICY);
    const sized = (seq: number, bytes: number, run_index = 0) =>
        segmentRecord({ seq, bytes, run_index, data: new ArrayBuffer(bytes) });

    assert.equal(await queue.add(sized(1, 209_715_200)), 'stored');
    assert.equal(await queue.add(sized(2, 1)), 'abandoned');
    assert.equal(await queue.add(sized(0, 1000, 1)), 'stored');
    assert.equal(await store.storedBytes(), 209_715_200 + 1000);
    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => [
            s.run_index,
            s.seq,
            s.state,
        ]),
        [
            [0, 1, 'pending'],
            [0, 2, 'abandoned'],
            [1, 0, 'pending'],
        ],
    );
});

test("the budget counts every session on the device against the current session's budget", async () => {
    const store = new MemoryQueueStore();
    const budget = 1000;
    const a = createQueue(store, { ...POLICY, budgetBytes: budget });
    const b = createQueue(store, { ...POLICY, budgetBytes: budget });
    const sized = (session_id: string, seq: number, bytes: number) =>
        segmentRecord({ session_id, seq, bytes, data: new ArrayBuffer(bytes) });
    const other = '01jbz8q4w6x0k3m5n7p9r2t4bb';

    assert.equal(await a.add(sized(SID, 1, budget - 10)), 'stored');
    assert.equal(await b.add(sized(other, 0, 300)), 'stored');
    assert.equal(await b.add(sized(other, 1, 20)), 'abandoned');
    assert.deepEqual(
        (await store.listSegments(other)).map((s) => [
            s.seq,
            s.state,
            s.data === null,
        ]),
        [
            [0, 'pending', false],
            [1, 'abandoned', true],
        ],
    );
});

test('the sweep never touches a record that was delivered before it came due', async () => {
    const store = new MemoryQueueStore();
    const queue = createQueue(store, POLICY);
    const record = segmentRecord({ seq: 1 });
    await queue.add(record);
    await store.putSegment({ ...record, state: 'delivered', data: null });

    assert.deepEqual(await queue.sweep(600_001), []);
    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => s.state),
        ['delivered'],
    );
});

test('after a reload a pending record ages from adopt(), not from when it was cut', async () => {
    const store = new MemoryQueueStore();
    let perf = 5_000_000;
    const queue = createQueue(store, { ...POLICY, perfNow: () => perf });
    const record = segmentRecord({ seq: 2, created_ms: 0 });
    await store.putSegment(record);
    queue.adopt([
        record,
        segmentRecord({ seq: 0 }),
        { ...segmentRecord({ seq: 3 }), state: 'delivered', data: null },
    ]);
    perf += 600_000;

    assert.deepEqual(await queue.sweep(perf), []);
    assert.deepEqual(
        (await queue.sweep(perf + 1)).map((s) => s.seq),
        [2],
    );
});

/** An uploader answer that is stored just as the sweep reaches the record. */
class AnswerLandsFirst extends MemoryQueueStore {
    override async updateSegment(
        key: SegmentKey,
        change: (current: SegmentRecord) => SegmentRecord | undefined,
    ): Promise<SegmentRecord | undefined> {
        const current = await super.getSegment(key);

        if (current !== undefined) {
            await super.putSegment({
                ...current,
                state: 'delivered',
                data: null,
            });
        }

        return super.updateSegment(key, change);
    }

    override async getSegment(
        key: SegmentKey,
    ): Promise<SegmentRecord | undefined> {
        const read = await super.getSegment(key);

        if (read !== undefined) {
            await super.putSegment({ ...read, state: 'delivered', data: null });
        }

        return read;
    }
}

test('an answer that lands while the sweep reaches its record is never overwritten', async () => {
    const store = new AnswerLandsFirst();
    const queue = createQueue(store, POLICY);
    await queue.add(segmentRecord({ seq: 1 }));

    assert.deepEqual(await queue.sweep(600_001), []);
    assert.deepEqual(
        (await store.listSegments(SID)).map((s) => s.state),
        ['delivered'],
    );
});
