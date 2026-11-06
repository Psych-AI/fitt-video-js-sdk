import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    callWithRetry,
    createSessionApi,
    transcriptBody,
} from '../../src/core/api.ts';
import { FittVideoError } from '../../src/core/errors.ts';
import type { WireAnswer } from '../../src/core/http.ts';
import { fakeEnvironment, json } from '../support/fake-env.ts';
import { descriptorFixture, SID } from '../support/records.ts';

const API = 'http://127.0.0.1:8123/api/v1';
const TOKEN = {
    id: '01jbz8q4w6x0k3m5n7p9r2t4bb',
    secret: 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f',
};

test('session calls go to endpoints.api with the bearer, JSON and no credentials', async () => {
    const env = fakeEnvironment();
    env.respond(() => json(200, {}));
    const descriptor = descriptorFixture();
    const api = createSessionApi(
        env,
        () => descriptor,
        () => TOKEN,
    );

    await api.finalise(15_000);
    await api.reset(1);
    await api.discard();
    await api.status();
    await api.postManifest('camera', {
        take: 1,
        end_ms: 1,
        runs: [],
        segments: [],
    });
    await api.refresh(TOKEN);
    await api.events('{"take":1}', true);

    assert.deepEqual(
        env.calls.map((call) => [
            call.method,
            call.url.replace(`${API}/sessions/${SID}`, ''),
            call.body ?? null,
            call.keepalive,
        ]),
        [
            ['POST', '/finalise', '{"end_ms":15000}', false],
            ['POST', '/reset', '{"take":1}', false],
            ['POST', '/discard', null, false],
            ['GET', '/status', null, false],
            [
                'POST',
                '/tracks/camera/manifest',
                '{"take":1,"end_ms":1,"runs":[],"segments":[]}',
                false,
            ],
            ['POST', '/refresh-upload', null, false],
            ['POST', '/events', '{"take":1}', true],
        ],
    );
    assert.ok(
        env.calls.every(
            (call) =>
                call.headers.Authorization ===
                    `Bearer fvt_${TOKEN.id}.${TOKEN.secret}` &&
                call.headers.Accept === 'application/json',
        ),
    );
    assert.ok(
        env.calls
            .filter((call) => call.body !== undefined)
            .every(
                (call) => call.headers['Content-Type'] === 'application/json',
            ),
    );
});

test('callWithRetry retries until a final answer, waiting retry_after on a 429', async () => {
    const env = fakeEnvironment({ random: 0 });
    const answers: WireAnswer[] = [
        { status: 0, body: null, networkError: true, timedOut: false },
        {
            status: 429,
            body: {
                error: { code: 'rate_limited', message: 'x', retry_after: 3 },
            },
            networkError: false,
            timedOut: false,
        },
        {
            status: 409,
            body: { error: { code: 'track_sealed', message: 'x' } },
            networkError: false,
            timedOut: false,
        },
    ];
    let calls = 0;
    const token = {
        current: () => TOKEN,
        expired: () => 'paused' as const,
        ready: async () => {},
    };
    const result = callWithRetry({ env, token }, async () => {
        calls += 1;

        return answers.shift()!;
    });
    await env.advance(2_999);
    assert.equal(calls, 2);
    await env.advance(1);

    assert.deepEqual([(await result).status, calls], [409, 3]);
});

test('a timed transcript needs offset_ms and is refused before any request', () => {
    for (const timing of ['exact', 'approximate'] as const) {
        assert.throws(
            () => transcriptBody({ timing, segments: [{ text: 'hello' }] }),
            (error) =>
                error instanceof FittVideoError &&
                error.code === 'config_invalid',
        );
    }

    assert.deepEqual(
        transcriptBody({
            timing: 'none',
            offset_ms: 5,
            segments: [{ text: 'hello', role: 'candidate' }],
        }),
        { timing: 'none', segments: [{ text: 'hello', role: 'candidate' }] },
    );
    assert.deepEqual(
        transcriptBody({
            timing: 'exact',
            offset_ms: 12_000,
            language: 'en',
            segments: [
                {
                    start_ms: 0,
                    end_ms: 900,
                    text: 'hi',
                    speaker: 'user',
                    role: 'candidate',
                },
            ],
        }).offset_ms,
        12_000,
    );
});

test('callWithRetry waits for the network and for a new token, and runs onSuccess on the 2xx', async () => {
    const env = fakeEnvironment();
    env.setOnline(false);
    const expired = {
        status: 401,
        body: { error: { code: 'token_expired', message: 'x' } },
        networkError: false,
        timedOut: false,
    };
    const answers: WireAnswer[] = [
        expired,
        {
            status: 200,
            body: { take: 2 },
            networkError: false,
            timedOut: false,
        },
    ];
    let release = (): void => {};
    const usedIds: string[] = [];
    let successes = 0;
    const token = {
        current: () => TOKEN,
        expired: (id: string) => {
            usedIds.push(id);

            return 'paused' as const;
        },
        ready: () => new Promise<void>((resolve) => (release = resolve)),
    };
    let calls = 0;
    const result = callWithRetry(
        { env, token, onSuccess: () => (successes += 1) },
        async () => {
            calls += 1;

            return answers.shift()!;
        },
    );
    await env.advance(5_000);
    assert.equal(calls, 0);
    env.setOnline(true);
    await env.advance(0);
    assert.deepEqual([calls, usedIds], [1, [TOKEN.id]]);
    release();

    assert.deepEqual([(await result).status, calls, successes], [200, 2, 1]);
});
