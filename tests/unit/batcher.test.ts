import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBatcher } from '../../src/core/batcher.ts';
import { createClock } from '../../src/core/clock.ts';
import type { SdkEvent } from '../../src/core/events.ts';
import type { WireAnswer } from '../../src/core/http.ts';
import { MemoryQueueStore } from '../../src/core/store.ts';
import type { TokenRef } from '../../src/core/wire.ts';
import {
    fakeEnvironment,
    settle,
    until,
    type FakeEnvironment,
} from '../support/fake-env.ts';
import { SID } from '../support/records.ts';

const NO_CONTENT: WireAnswer = {
    status: 204,
    body: null,
    networkError: false,
    timedOut: false,
};
const reply = (status: number, body: unknown): WireAnswer => ({
    status,
    body,
    networkError: false,
    timedOut: false,
});

/** A token keeper stand-in: token `a` until renew(), which also releases ready(). */
function stubToken() {
    let id = 'a';
    let paused = false;
    let release: () => void = () => {};

    return {
        current: (): TokenRef => ({ id, secret: 's' }),
        expired: (usedId: string): 'retry' | 'paused' => {
            if (usedId !== id) {
                return 'retry';
            }

            paused = true;

            return 'paused';
        },
        ready: (): Promise<void> =>
            paused
                ? new Promise<void>((resolve) => {
                      release = resolve;
                  })
                : Promise.resolve(),
        renew: (): void => {
            id = 'b';
            paused = false;
            release();
        },
    };
}
const event = (t_ms: number, payload?: Record<string, unknown>): SdkEvent => ({
    id: `01jbz8q4w6x0k3m5n7p9r2t${String(t_ms).padStart(3, '0')}`,
    t_ms,
    type: 'net.offline',
    source: 'browser',
    ...(payload ? { payload } : {}),
});

function rig(
    options: {
        env?: FakeEnvironment;
        store?: MemoryQueueStore;
        next?: number;
        sync?: number | null;
        take?: () => number;
        answer?: (token: TokenRef) => WireAnswer;
        token?: ReturnType<typeof stubToken>;
    } = {},
) {
    const env = options.env ?? fakeEnvironment({ date: 1_762_400_000_000 });
    const clock = createClock(env);
    const store = options.store ?? new MemoryQueueStore();
    const sends: { body: string; keepalive: boolean; tokenId: string }[] = [];
    const persisted: number[] = [];
    const closed: string[] = [];
    const rejected: { batch_seq: number; code: string; status: number }[] = [];
    const sync = { value: options.sync ?? null };
    const batcher = createBatcher({
        env,
        clock,
        store,
        sessionId: SID,
        take: options.take ?? (() => 1),
        nextBatchSeq: options.next ?? 0,
        batchMs: 5000,
        token: options.token ?? stubToken(),
        send: async (body, keepalive, token) => {
            sends.push({ body, keepalive, tokenId: token.id });

            return options.answer?.(token) ?? NO_CONTENT;
        },
        persistNextBatchSeq: async (next) => {
            persisted.push(next);
        },
        persistNextBatchSeqSync: (next) => {
            sync.value = next;
        },
        readNextBatchSeqSync: () => sync.value,
        onClosed: (code) => closed.push(code),
        onRejected: (rejection) => rejected.push(rejection),
    });

    return {
        env,
        clock,
        store,
        batcher,
        sends,
        persisted,
        closed,
        rejected,
        sync,
    };
}

test('every 5000 ms the exact batch body is posted, and heartbeats go out empty', async () => {
    const r = rig();
    r.batcher.startTimer({ emptyHeartbeats: true });
    r.batcher.add(event(1200));
    await r.env.advance(5000);
    await r.env.advance(5000);

    assert.deepEqual(
        r.sends.map((send) => JSON.parse(send.body)),
        [
            {
                take: 1,
                batch_seq: 0,
                sent_at_ms: 1_762_400_005_000,
                clock_epoch_ms: r.clock.epochMs,
                events: [event(1200)],
            },
            {
                take: 1,
                batch_seq: 1,
                sent_at_ms: 1_762_400_010_000,
                clock_epoch_ms: r.clock.epochMs,
                events: [],
            },
        ],
    );
    assert.ok(
        r.sends.every(
            (send) => !send.keepalive && /"sent_at_ms":\d{13},/.test(send.body),
        ),
    );
    r.batcher.stop();
});

test('freeze() stores what is waiting as one batch and sends nothing', async () => {
    const r = rig();
    r.batcher.add(event(100));
    r.batcher.add(event(200));
    await r.batcher.freeze();
    const batches = await r.store.listBatches(SID);

    assert.deepEqual(
        batches.map((batch) => [
            batch.batch_seq,
            JSON.parse(batch.body).events,
        ]),
        [[0, [event(100), event(200)]]],
    );
    assert.deepEqual([r.sends, r.persisted, r.sync.value], [[], [1], 1]);
});

test('before the first start only non-empty batches go, every 5000 ms', async () => {
    const r = rig();
    r.batcher.startTimer({ emptyHeartbeats: false });
    await r.env.advance(10_000);
    assert.equal(r.sends.length, 0);

    r.batcher.add(event(10_500));
    await r.env.advance(5000);

    assert.deepEqual(
        r.sends.map((send) => JSON.parse(send.body).events.length),
        [1],
    );
    r.batcher.stop();
});

test('a batch is frozen before its first send, so a retry is byte identical, and next_batch_seq is stored first', async () => {
    let fail = true;
    const r = rig({
        answer: () =>
            fail
                ? {
                      status: 500,
                      body: null,
                      networkError: false,
                      timedOut: false,
                  }
                : NO_CONTENT,
    });
    r.batcher.add(event(10));
    await r.batcher.flush();
    assert.deepEqual(r.persisted, [1]);
    assert.equal((await r.store.listBatches(SID)).length, 1);

    fail = false;
    await r.env.advance(30_000);
    await until(() => r.sends.length === 2);

    assert.equal(r.sends[1].body, r.sends[0].body);
    assert.equal((await r.store.listBatches(SID)).length, 0);
});

test('a new batcher over the same store starts at 3, and after a reset the take changes but the numbering goes on', async () => {
    const store = new MemoryQueueStore();
    const first = rig({ store });

    for (let i = 0; i < 3; i++) {
        first.batcher.add(event(i));
        await first.batcher.flush();
    }

    assert.deepEqual(first.persisted, [1, 2, 3]);

    let take = 1;
    const second = rig({
        store,
        next: first.persisted.at(-1),
        take: () => take,
    });
    take = 2;
    second.batcher.add(event(99));
    await second.batcher.flush();

    assert.deepEqual(
        [
            JSON.parse(second.sends[0].body).take,
            JSON.parse(second.sends[0].body).batch_seq,
        ],
        [2, 3],
    );
});

test('501 events go as 500 and 1, and more than 1 MiB of payloads is split', async () => {
    const r = rig();

    for (let i = 0; i < 501; i++) {
        r.batcher.add(event(i));
    }

    await r.batcher.flush();
    assert.deepEqual(
        r.sends.map((send) => JSON.parse(send.body).events.length),
        [500, 1],
    );

    const big = rig();

    for (let i = 0; i < 70; i++) {
        big.batcher.add(event(i, { text: 'x'.repeat(15_980) }));
    }

    await big.batcher.flush();
    assert.deepEqual(
        big.sends.map((send) => JSON.parse(send.body).events.length),
        [65, 5],
    );
});

test('the batch cut counts payloads as PHP does, so line terminators cannot push a batch past the server limit', async () => {
    const r = rig();

    for (let i = 0; i < 70; i++) {
        r.batcher.add(event(i, { text: '\u2028'.repeat(2600) }));
    }

    await r.batcher.flush();
    assert.deepEqual(
        r.sends.map((send) => JSON.parse(send.body).events.length),
        [66, 4],
    );
});

test('pagehide sends stored batches with keepalive up to 61,440 body bytes in total, and keeps the rest', async () => {
    const r = rig();

    for (let batch_seq = 0; batch_seq < 3; batch_seq++) {
        await r.store.putBatch({
            session_id: SID,
            batch_seq,
            take: 1,
            body: 'x'.repeat(30_000),
            payload_bytes: 29_000,
        });
    }

    r.batcher.pagehide();
    await settle();

    assert.deepEqual(
        r.sends.map((send) => [send.body.length, send.keepalive]),
        [
            [30_000, true],
            [30_000, true],
        ],
    );
    assert.equal((await r.store.listBatches(SID)).length, 1);
});

test('pagehide freezes waiting events and sends them with keepalive', async () => {
    const r = rig();
    r.batcher.add(event(1));
    r.batcher.pagehide();
    await settle();

    assert.equal(r.sends.length, 1);
    assert.equal(r.sends[0].keepalive, true);
    assert.deepEqual(
        [
            JSON.parse(r.sends[0].body).events.length,
            JSON.parse(r.sends[0].body).batch_seq,
        ],
        [1, 0],
    );
    assert.equal(r.sync.value, 1);
});

test('a new batcher whose IndexedDB seq write never committed starts from the sync copy', async () => {
    const r = rig({ next: 0, sync: 1 });
    r.batcher.add(event(1));
    await r.batcher.flush();

    assert.equal(JSON.parse(r.sends[0].body).batch_seq, 1);
});

test('a 401 token_expired waits for a new token, then sends the same body with it', async () => {
    const token = stubToken();
    const r = rig({
        token,
        answer: (used) =>
            used.id === 'a'
                ? reply(401, {
                      error: {
                          code: 'token_expired',
                          message: 'x',
                          recoverable: true,
                      },
                  })
                : NO_CONTENT,
    });
    r.batcher.add(event(1));
    await r.batcher.flush();
    await r.env.advance(60_000);
    assert.equal(r.sends.length, 1);

    token.renew();
    await until(() => r.sends.length === 2);

    assert.equal(r.sends[1].body, r.sends[0].body);
    assert.equal(r.sends[1].tokenId, 'b');
});

test('a 429 waits retry_after from the body', async () => {
    const answers = [
        reply(429, {
            error: { code: 'rate_limited', message: 'x', retry_after: 9 },
        }),
        NO_CONTENT,
    ];
    const r = rig({ answer: () => answers.shift() ?? NO_CONTENT });
    r.batcher.add(event(1));
    await r.batcher.flush();
    await r.env.advance(8_999);
    assert.equal(r.sends.length, 1);

    await r.env.advance(1);
    await until(() => r.sends.length === 2);
});

test('a refused batch is deleted, reported once through onRejected, and the next batch is sent', async () => {
    const answers = [
        reply(422, { error: { code: 'validation_failed', message: 'x' } }),
    ];
    const r = rig({ answer: () => answers.shift() ?? NO_CONTENT });
    r.batcher.add(event(1));
    await r.batcher.flush();
    r.batcher.add(event(2));
    await r.batcher.flush();

    assert.deepEqual(r.rejected, [
        { batch_seq: 0, code: 'validation_failed', status: 422 },
    ]);
    assert.deepEqual(
        r.sends.map((send) => JSON.parse(send.body).batch_seq),
        [0, 1],
    );
    assert.equal((await r.store.listBatches(SID)).length, 0);
});

test('a 413 payload_too_large is the session budget: the batcher stops and drops what is stored', async () => {
    const r = rig({
        answer: () =>
            reply(413, { error: { code: 'payload_too_large', message: 'x' } }),
    });
    r.batcher.add(event(1));
    await r.batcher.flush();
    r.batcher.add(event(2));
    await r.batcher.flush();
    await r.env.advance(60_000);

    assert.equal(r.sends.length, 1);
    assert.deepEqual(r.rejected, [
        { batch_seq: 0, code: 'payload_too_large', status: 413 },
    ]);
    assert.equal((await r.store.listBatches(SID)).length, 0);
});

test('409 session_closed or discarded stops batching', async () => {
    const r = rig({
        answer: () => ({
            status: 409,
            body: { error: { code: 'discarded', message: 'x' } },
            networkError: false,
            timedOut: false,
        }),
    });
    r.batcher.startTimer({ emptyHeartbeats: true });
    await r.env.advance(5000);
    await r.env.advance(20_000);

    assert.equal(r.sends.length, 1);
    assert.deepEqual(r.closed, ['discarded']);
});
