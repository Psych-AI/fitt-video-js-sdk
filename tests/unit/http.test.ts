import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send } from '../../src/core/http.ts';
import { fakeEnvironment, json } from '../support/fake-env.ts';

const REQUEST = {
    method: 'PUT' as const,
    url: 'http://127.0.0.1:8123/api/v1/sessions/01jbz8q4w6x0k3m5n7p9r2t4aa/tracks/camera/segments/3',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new ArrayBuffer(3),
};

test('send() omits cookies, keeps the referrer to the origin and parses a JSON answer', async () => {
    const env = fakeEnvironment();
    const seen: RequestInit[] = [];
    const inner = env.fetch.bind(env);
    env.respond(() => json(201, { code: 'stored' }));
    const answer = await send(
        { ...env, fetch: (url, init) => (seen.push(init), inner(url, init)) },
        REQUEST,
    );

    assert.deepEqual(answer, {
        status: 201,
        body: { code: 'stored' },
        networkError: false,
        timedOut: false,
    });
    assert.deepEqual(
        [seen[0].credentials, seen[0].referrerPolicy, seen[0].keepalive],
        ['omit', 'strict-origin-when-cross-origin', false],
    );
    assert.equal(env.calls[0].body, REQUEST.body);
});

test('a body that is not JSON comes back as its text, and an empty one as null', async () => {
    const env = fakeEnvironment();
    env.respond(
        () =>
            new Response('<html>Forbidden</html>', {
                status: 403,
                headers: { 'Content-Type': 'text/html' },
            }),
    );
    const html = await send(env, REQUEST);
    env.respond(
        () =>
            new Response('{broken', {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            }),
    );
    const broken = await send(env, REQUEST);
    env.respond(() => json(502));
    const empty = await send(env, REQUEST);

    assert.deepEqual([html.status, html.body], [403, '<html>Forbidden</html>']);
    assert.deepEqual([broken.status, broken.body], [502, '{broken']);
    assert.deepEqual([empty.status, empty.body], [502, null]);
});

test('a rejected fetch is a network error and never throws', async () => {
    const env = fakeEnvironment();
    env.respond(() => {
        throw new TypeError('Failed to fetch');
    });

    assert.deepEqual(await send(env, REQUEST), {
        status: 0,
        body: null,
        networkError: true,
        timedOut: false,
    });
});

test('a request with no answer is aborted at the limit and reported as timed out', async () => {
    const env = fakeEnvironment();
    env.respond(() => new Promise<Response>(() => undefined));
    const pending = send(env, REQUEST, 5000);
    await env.advance(4999);
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    await env.advance(0);
    assert.equal(settled, false);
    await env.advance(1);

    assert.deepEqual(await pending, {
        status: 0,
        body: null,
        networkError: true,
        timedOut: true,
    });
});
