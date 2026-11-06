import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Descriptor } from '../../src/core/descriptor.ts';
import type { WireAnswer } from '../../src/core/http.ts';
import { createTokenKeeper } from '../../src/core/token.ts';
import type { TokenRef } from '../../src/core/wire.ts';
import { fakeEnvironment, settle, until } from '../support/fake-env.ts';
import { descriptorFixture } from '../support/records.ts';

const OLD = {
    id: '01jbz8q4w6x0k3m5n7p9r2t4bb',
    secret: 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f',
};
const NEW = {
    id: '01jbz8q4w6x0k3m5n7p9r2t4bc',
    secret: 'Zz3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f',
};
const answer = (status: number, body: unknown): WireAnswer => ({
    status,
    body,
    networkError: false,
    timedOut: false,
});

function renewed(): Descriptor {
    const descriptor = descriptorFixture();
    descriptor.token = { ...descriptor.token, ...NEW };

    return descriptor;
}

test('the refresh fires at receipt plus refresh_after_s on the monotonic clock, and the new token is used after', async () => {
    const env = fakeEnvironment();
    const used: TokenRef[] = [];
    const stored: Descriptor[] = [];
    const keeper = createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        refresh: async (token) => {
            used.push(token);

            return answer(201, { descriptor: renewed() });
        },
        onDescriptor: (descriptor) => stored.push(descriptor),
        emit: () => {},
        setError: () => {},
    });

    await env.advance(674_999);
    assert.equal(used.length, 0);
    await env.advance(1);
    await until(() => keeper.current().id === NEW.id);

    assert.deepEqual(used, [OLD]);
    assert.equal(stored.length, 1);
    keeper.stop();
});

test('stop() waits for a refresh in flight and passes its descriptor on before it resolves', async () => {
    const env = fakeEnvironment();
    const stored: Descriptor[] = [];
    let answerRefresh: (value: WireAnswer) => void = () => {};
    let refreshes = 0;
    const keeper = createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        refresh: () => {
            refreshes += 1;

            return new Promise<WireAnswer>((resolve) => {
                answerRefresh = resolve;
            });
        },
        onDescriptor: (descriptor) => stored.push(descriptor),
        emit: () => {},
        setError: () => {},
    });

    await env.advance(675_000);
    await until(() => refreshes === 1);
    let stopped = false;
    const stopping = keeper.stop().then(() => {
        stopped = true;
    });
    await settle();
    assert.equal(stopped, false);
    answerRefresh(answer(201, { descriptor: renewed() }));
    await stopping;

    assert.deepEqual([stored.length, keeper.current().id], [1, NEW.id]);
    await env.advance(2 * 675_000);
    assert.equal(refreshes, 1);
});

test('check() refreshes at once when Date.now() passed the deadline while timers were stopped (sleep, a frozen tab)', async () => {
    const env = fakeEnvironment();
    const received = env.dateNow();
    const descriptor = descriptorFixture();
    descriptor.token = {
        ...descriptor.token,
        expires_in_s: 900,
        refresh_after_s: 840,
    };
    const sent: number[] = [];
    const keeper = createTokenKeeper({
        env,
        descriptor,
        refresh: async () => {
            sent.push(env.dateNow() - received);

            return answer(201, { descriptor: renewed() });
        },
        onDescriptor: () => {},
        emit: () => {},
        setError: () => {},
    });

    await env.advance(600_000);
    env.shiftWall(240_000); // the laptop slept for 4 minutes: Date.now() moved, the timers did not
    keeper.check();
    await env.advance(1);
    await until(() => sent.length === 1);

    // Without check() the timer would fire at a wall offset of 1,080,000 ms, after the token expired.
    assert.ok(sent[0] < 900_000, String(sent[0]));
    keeper.stop();
});

test('two refresh network errors in a row are token_refresh_blocked, raised once, and a later 201 clears it', async () => {
    const env = fakeEnvironment();
    const errors: (string | null)[] = [];
    const events: [string, Record<string, unknown>][] = [];
    const network: WireAnswer = {
        status: 0,
        body: null,
        networkError: true,
        timedOut: false,
    };
    let calls = 0;
    const keeper = createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        refresh: async () => {
            calls += 1;

            return calls <= 3
                ? network
                : answer(201, { descriptor: renewed() });
        },
        onDescriptor: () => {},
        emit: (type, payload) => events.push([type, payload]),
        setError: (code) => errors.push(code),
    });

    await env.advance(675_000);
    await until(() => calls === 1);
    await env.advance(500);
    await until(() => calls === 2);
    assert.deepEqual(errors, ['token_refresh_blocked']);
    assert.deepEqual(events, [['upload.refresh_failed', { code: 'network' }]]);

    await env.advance(30_000);
    await until(() => keeper.current().id === NEW.id);
    assert.deepEqual(errors, ['token_refresh_blocked', null]);
    assert.equal(events.length, 1);
    keeper.stop();
});

test('a 409 session_closed or discarded stops the refresh for good', async () => {
    for (const code of ['session_closed', 'discarded']) {
        const env = fakeEnvironment();
        let calls = 0;
        const keeper = createTokenKeeper({
            env,
            descriptor: descriptorFixture(),
            refresh: async () => {
                calls += 1;

                return answer(409, { error: { code, message: 'x' } });
            },
            onDescriptor: () => {},
            emit: () => {},
            setError: () => {},
        });

        await env.advance(675_000 * 3);
        assert.equal(calls, 1, code);
        keeper.stop();
    }
});

test('a token received 300 s ago refreshes at 375 s, not 675 s', async () => {
    const env = fakeEnvironment();
    let calls = 0;
    const keeper = createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        receivedAtMs: env.dateNow() - 300_000,
        refresh: async () => {
            calls += 1;

            return answer(201, { descriptor: renewed() });
        },
        onDescriptor: () => {},
        emit: () => {},
        setError: () => {},
    });

    await env.advance(374_999);
    assert.equal(calls, 0);
    await env.advance(1);
    await until(() => calls === 1);
    keeper.stop();
});

test('a 429 from the refresh waits retry_after, then tries again', async () => {
    const env = fakeEnvironment();
    const answers = [
        answer(429, {
            error: { code: 'rate_limited', message: 'x', retry_after: 20 },
        }),
        answer(201, { descriptor: renewed() }),
    ];
    let calls = 0;
    const keeper = createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        refresh: async () => {
            calls += 1;

            return answers.shift()!;
        },
        onDescriptor: () => {},
        emit: () => {},
        setError: () => {},
    });

    await env.advance(675_000);
    await until(() => calls === 1);
    await env.advance(19_999);
    assert.equal(calls, 1);
    await env.advance(1);
    await until(() => keeper.current().id === NEW.id);
    keeper.stop();
});

test('an older token never replaces a newer one', () => {
    const stored: Descriptor[] = [];
    const keeper = createTokenKeeper({
        env: fakeEnvironment(),
        descriptor: descriptorFixture(),
        refresh: async () => answer(500, null),
        onDescriptor: (descriptor) => stored.push(descriptor),
        emit: () => {},
        setError: () => {},
    });

    assert.equal(keeper.set(renewed()), true);
    assert.equal(keeper.set(descriptorFixture()), false);
    assert.equal(keeper.set(renewed()), false);
    assert.equal(keeper.current().id, NEW.id);
    assert.equal(stored.length, 1);
    keeper.stop();
});

test('a 401 token_expired while a newer token is held is retried with the newer one', () => {
    const keeper = createTokenKeeper({
        env: fakeEnvironment(),
        descriptor: descriptorFixture(),
        refresh: async () => answer(500, null),
        onDescriptor: () => {},
        emit: () => {},
        setError: () => {},
    });
    keeper.set(renewed());

    assert.equal(keeper.expired(OLD.id), 'retry');
    assert.equal(keeper.current().id, NEW.id);
    keeper.stop();
});

test('with no newer token: paused, token_expired and upload.refresh_failed once, and set() resumes', async () => {
    const errors: (string | null)[] = [];
    const events: [string, Record<string, unknown>][] = [];
    const keeper = createTokenKeeper({
        env: fakeEnvironment(),
        descriptor: descriptorFixture(),
        refresh: async () => answer(500, null),
        onDescriptor: () => {},
        emit: (type, payload) => events.push([type, payload]),
        setError: (code) => errors.push(code),
    });

    assert.equal(keeper.expired(OLD.id), 'paused');
    assert.equal(keeper.expired(OLD.id), 'paused');
    assert.deepEqual(errors, ['token_expired']);
    assert.deepEqual(events, [
        ['upload.refresh_failed', { code: 'token_expired' }],
    ]);

    let ready = false;
    void keeper.ready().then(() => {
        ready = true;
    });
    await settle();
    assert.equal(ready, false);

    keeper.set(renewed());
    await until(() => ready);
    assert.deepEqual(errors, ['token_expired', null]);
    keeper.stop();
});

test('a keeper created with a token that already expired starts paused and sends no refresh', async () => {
    const env = fakeEnvironment();
    const errors: (string | null)[] = [];
    const events: [string, Record<string, unknown>][] = [];
    let calls = 0;
    const keeper = createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        receivedAtMs: env.dateNow() - 900_000,
        refresh: async () => {
            calls += 1;

            return answer(201, { descriptor: renewed() });
        },
        onDescriptor: () => {},
        emit: (type, payload) => events.push([type, payload]),
        setError: (code) => errors.push(code),
    });

    await env.advance(675_000 * 2);
    keeper.check();
    await settle();
    assert.equal(calls, 0);
    assert.deepEqual(errors, ['token_expired']);
    assert.deepEqual(events, [
        ['upload.refresh_failed', { code: 'token_expired' }],
    ]);

    assert.equal(keeper.set(renewed()), true);
    await keeper.ready();
    assert.deepEqual(errors, ['token_expired', null]);
    keeper.stop();
});

test('a 401 token_expired from the refresh itself pauses like expired()', async () => {
    const env = fakeEnvironment();
    const errors: (string | null)[] = [];
    let calls = 0;
    const keeper = createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        refresh: async () => {
            calls += 1;

            return answer(401, {
                error: {
                    code: 'token_expired',
                    message: 'x',
                    recoverable: true,
                },
            });
        },
        onDescriptor: () => {},
        emit: () => {},
        setError: (code) => errors.push(code),
    });

    await env.advance(675_000);
    await until(() => calls === 1);
    await env.advance(675_000);
    assert.equal(calls, 1);
    assert.deepEqual(errors, ['token_expired']);
    keeper.stop();
});
