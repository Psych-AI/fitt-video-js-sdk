import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { waitForChecks, waitForReady } from '../../src/core/checks.ts';
import { FittVideoError } from '../../src/core/errors.ts';
import type { WireAnswer } from '../../src/core/http.ts';
import { fakeEnvironment } from '../support/fake-env.ts';

const offline: WireAnswer = {
    status: 0,
    body: null,
    networkError: true,
    timedOut: false,
};
const statusWith = (
    checks: Record<string, unknown>,
    extra: Record<string, unknown> = {},
): WireAnswer => ({
    status: 200,
    body: {
        session: { id: 'x', status: 'finalising', take: 1, end_ms: null },
        tracks: [],
        checks,
        upload: { bytes_received: 0 },
        ...extra,
    },
    networkError: false,
    timedOut: false,
});

test('status is polled at 0, every 1 s for 10 s, then every 2 s, and gives a local unknown at 60 s without ever rejecting', async () => {
    const env = fakeEnvironment();
    const at: number[] = [];
    const result = waitForChecks({
        env,
        status: async () => {
            at.push(env.perfNow());
            return offline;
        },
        take: () => 1,
        onChecks: () => {},
    });
    await env.advance(60_000);

    assert.deepEqual(await result, {
        status: 'pending',
        verdict: 'unknown',
        take: 1,
        reasons: [],
    });
    assert.deepEqual(at, [
        ...Array.from({ length: 11 }, (_, i) => i * 1000),
        ...Array.from({ length: 24 }, (_, i) => 12_000 + i * 2000),
    ]);
});

test('a done verdict for the current take resolves at once and fires onChecks once', async () => {
    const env = fakeEnvironment();
    const seen: unknown[] = [];
    const done = {
        status: 'done',
        verdict: 'reject',
        take: 1,
        reasons: ['no_speech'],
    };
    const result = await waitForChecks({
        env,
        status: async () => statusWith(done),
        take: () => 1,
        onChecks: (checks) => seen.push(checks),
    });

    assert.deepEqual(result, done);
    assert.deepEqual(seen, [done]);
});

test('a string checks.reason is kept, for a session created with checks.expose_reason', async () => {
    const env = fakeEnvironment();
    const done = {
        status: 'done',
        verdict: 'reject',
        take: 1,
        reasons: ['off_topic'],
        reason: 'The answer is about the weather.',
    };

    assert.deepEqual(
        await waitForChecks({
            env,
            status: async () => statusWith(done),
            take: () => 1,
            onChecks: () => {},
        }),
        done,
    );
});

test('a verdict for an earlier take keeps polling', async () => {
    const env = fakeEnvironment();
    let polls = 0;
    const result = waitForChecks({
        env,
        status: async () =>
            ++polls < 3
                ? statusWith({
                      status: 'done',
                      verdict: 'reject',
                      take: 1,
                      reasons: [],
                  })
                : statusWith({
                      status: 'done',
                      verdict: 'accept',
                      take: 2,
                      reasons: [],
                  }),
        take: () => 2,
        onChecks: () => {},
    });
    await env.advance(3000);

    assert.equal((await result).verdict, 'accept');
});

test('waitForReady rejects playback_not_enabled when the status has no playback', async () => {
    await assert.rejects(
        waitForReady(
            {
                env: fakeEnvironment(),
                status: async () =>
                    statusWith({
                        status: 'pending',
                        verdict: null,
                        take: 1,
                        reasons: [],
                    }),
            },
            'camera',
            5000,
        ),
        (error) =>
            error instanceof FittVideoError &&
            error.code === 'playback_not_enabled',
    );
});

test('waitForReady resolves the track url once the playback carries it, and rejects at the timeout', async () => {
    const env = fakeEnvironment();
    let polls = 0;
    const pending = statusWith(
        { status: 'pending', verdict: null, take: 1, reasons: [] },
        { playback: {} },
    );
    const ready = statusWith(
        { status: 'pending', verdict: null, take: 1, reasons: [] },
        { playback: { camera: { url: 'https://media.test/camera.mp4' } } },
    );
    const url = waitForReady(
        { env, status: async () => (++polls < 3 ? pending : ready) },
        'camera',
    );
    await env.advance(2000);

    assert.equal(await url, 'https://media.test/camera.mp4');

    const late = fakeEnvironment();
    const never = waitForReady(
        { env: late, status: async () => pending },
        'camera',
        5000,
    );
    const settled = assert.rejects(
        never,
        (error) =>
            error instanceof FittVideoError &&
            error.code === 'playback_not_enabled' &&
            error.detail.reason === 'timeout',
    );
    await late.advance(5000);
    await settled;
});

const tracksStatus = (
    tracks: Record<string, unknown>[],
    playback: Record<string, unknown> = {},
): WireAnswer =>
    statusWith(
        { status: 'pending', verdict: null, take: 1, reasons: [] },
        { tracks, playback },
    );

test('waitForReady rejects track_failed with the reason as soon as the awaited track has failed', async () => {
    const env = fakeEnvironment();
    let polls = 0;
    const processing = tracksStatus([
        { track: 'camera', status: 'processing', failure_reason: null },
    ]);
    const failed = tracksStatus([
        {
            track: 'camera',
            status: 'failed',
            failure_reason: 'no_decodable_run',
        },
    ]);
    const result = waitForReady(
        { env, status: async () => (++polls < 2 ? processing : failed) },
        'camera',
        60_000,
    );
    const settled = assert.rejects(
        result,
        (error) =>
            error instanceof FittVideoError &&
            error.code === 'track_failed' &&
            isDeepStrictEqual(error.detail, { reason: 'no_decodable_run' }),
    );
    await env.advance(1000);
    await settled;

    assert.equal(polls, 2);
});

test('a failed audio track never rejects waitForReady for the camera', async () => {
    const env = fakeEnvironment();
    const url = waitForReady(
        {
            env,
            status: async () =>
                tracksStatus(
                    [
                        {
                            track: 'camera',
                            status: 'ready',
                            failure_reason: null,
                        },
                        {
                            track: 'audio',
                            status: 'failed',
                            failure_reason: 'no_media',
                        },
                    ],
                    { camera: { url: 'https://media.test/camera.webm' } },
                ),
        },
        'camera',
    );
    await env.advance(0);

    assert.equal(await url, 'https://media.test/camera.webm');
});

test('a failed track with no failure_reason rejects track_failed with a null reason', async () => {
    const env = fakeEnvironment();
    const result = waitForReady(
        {
            env,
            status: async () =>
                tracksStatus([{ track: 'audio', status: 'failed' }]),
        },
        'audio',
    );
    const settled = assert.rejects(
        result,
        (error) =>
            error instanceof FittVideoError &&
            error.code === 'track_failed' &&
            isDeepStrictEqual(error.detail, { reason: null }),
    );
    await env.advance(0);
    await settled;
});

test('a cancelled waitForReady polls no more and never settles', async () => {
    const env = fakeEnvironment();
    let polls = 0;
    let cancelled = false;
    let settled = false;
    void waitForReady(
        {
            env,
            status: async () => {
                polls++;

                return statusWith(
                    { status: 'pending', verdict: null, take: 1, reasons: [] },
                    { playback: {} },
                );
            },
        },
        'camera',
        60_000,
        () => cancelled,
    ).then(
        () => (settled = true),
        () => (settled = true),
    );
    await env.advance(2500);
    cancelled = true;
    const before = polls;
    await env.advance(60_000);

    assert.equal(before, 3);
    assert.equal(polls, before);
    assert.equal(settled, false);
});
