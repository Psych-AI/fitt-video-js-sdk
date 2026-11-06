import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSettings } from '../../src/core/options.ts';
import { resumeWith } from '../../src/core/resume.ts';
import { createSession, sessionWith } from '../../src/core/session.ts';
import { MemoryQueueStore, type SessionRecord } from '../../src/core/store.ts';
import { FittVideo } from '../../src/index.ts';
import { fakeEnvironment, json, settle, until } from '../support/fake-env.ts';
import { fakeMedia } from '../support/fake-media.ts';
import {
    descriptorFixture,
    segmentRecord,
    sessionRecord,
} from '../support/records.ts';
import {
    recordTake,
    rigSeams,
    router,
    sessionRig,
    statusBody,
    type Answer,
    type SessionRig,
} from '../support/session-rig.ts';

test('options narrow what the descriptor allows and never widen it', () => {
    const warnings: string[] = [];
    const wide = resolveSettings(
        descriptorFixture('answer'),
        {
            signals: { groups: ['net', 'clipboard'] },
            capture: { camera: { video_bitrate_bps: 900_000 } },
        },
        (m) => warnings.push(m),
    );
    const narrow = resolveSettings(
        descriptorFixture('answer'),
        {
            capture: { camera: { video_bitrate_bps: 200_000 } },
            upload: { transport: 'post' },
        },
        () => {},
    );

    assert.deepEqual(wide.groups, ['net']);
    assert.equal(wide.bitrates.camera?.video, 300_000);
    assert.equal(narrow.bitrates.camera?.video, 200_000);
    assert.equal(narrow.forcePost, true);
    assert.deepEqual(
        [wide.silenceLevel, wide.noAudioMs, wide.idleMs, wide.checksTimeoutMs],
        [0.01, 5000, 30_000, 60_000],
    );
    assert.ok(warnings.some((m) => m.includes('clipboard')));
});

test('options.ui is ignored with one warning', () => {
    const warnings: string[] = [];
    const withUi = resolveSettings(
        descriptorFixture('answer'),
        { ui: { controls: 'minimal' } },
        (m) => warnings.push(m),
    );

    assert.equal(warnings.filter((m) => m.includes('options.ui')).length, 1);
    assert.deepEqual(
        withUi,
        resolveSettings(descriptorFixture('answer'), {}, () => {}),
    );
});

test('an invalid descriptor gives a session in phase error with config_invalid, without throwing', () => {
    const descriptor: Record<string, unknown> = {
        ...descriptorFixture('answer'),
    };
    delete descriptor.token;
    const created = FittVideo.session(descriptor);

    assert.equal(created.state.phase, 'error');
    assert.equal(created.state.error?.code, 'config_invalid');
});

test('the same session_id returns the same object, with the new token swapped in', () => {
    const env = fakeEnvironment();
    env.respond(() => json(204));
    const seams = rigSeams(env, new MemoryQueueStore(), fakeMedia(env));
    const first = sessionWith(descriptorFixture('monitor'), {}, seams);
    const renewed = descriptorFixture('monitor');
    renewed.token = { ...renewed.token, id: '01jbz8q4w6x0k3m5n7p9r2t4bc' };

    assert.equal(sessionWith(renewed, {}, seams), first);
    first.destroy();
});

test('a permission denial before any take is sent as an event within batch_ms', async () => {
    const r = sessionRig({ refuse: 'NotAllowedError' });
    await assert.rejects(
        r.session.prepare(),
        (error: unknown) =>
            (error as { code?: string }).code === 'permission_denied',
    );
    await r.env.advance(5000);
    const [body] = r.bodies();

    assert.ok(
        body.events.some(
            (event) =>
                event.type === 'session.error' &&
                JSON.stringify(event.payload) ===
                    '{"code":"permission_denied"}',
        ),
    );
    assert.equal(typeof body.clock_epoch_ms, 'number');
});

test('one session.environment event is queued after prepare, with the device labels', async () => {
    const r = sessionRig();
    const seen: { type: string; payload?: unknown }[] = [];
    r.session.onEvent((event) => seen.push(event));
    await r.session.prepare();
    await r.session.prepare();
    const environment = seen.filter(
        (event) => event.type === 'session.environment',
    );

    assert.equal(environment.length, 1);
    assert.ok(
        'time_zone' in (environment[0].payload as object) &&
            'cameras' in (environment[0].payload as object),
    );
});

test('a stored record with no epoch copy gives the stored epoch, and events from before ready move onto it', async () => {
    const descriptor = descriptorFixture('monitor');
    const store = new MemoryQueueStore();
    const stored = 1_762_399_000_000;
    await store.putSession(
        sessionRecord({
            session_id: descriptor.session_id,
            descriptor,
            epoch_ms: stored,
            next_batch_seq: 4,
        }),
    );
    const r = sessionRig({ descriptor, store });
    r.session.event('marker');
    await r.session.prepare();
    await r.env.advance(5000);
    const [body] = r.bodies();

    assert.ok(r.session.now() >= 1_000_000);
    assert.deepEqual([body.clock_epoch_ms, body.batch_seq], [stored, 4]);
    assert.ok(
        body.events.find((event) => event.type === 'host.marker')!.t_ms >=
            1_000_000,
    );
    assert.equal(
        (await store.getSession(descriptor.session_id))?.epoch_ms,
        stored,
    );
});

test('session() purges a stored session idle past abandon_after_ms', async () => {
    const store = new MemoryQueueStore();
    const old = {
        ...descriptorFixture('answer'),
        session_id: '01jbz8q4w6x0k3m5n7p9r2t4zz',
    };
    await store.putSession(
        sessionRecord({
            session_id: old.session_id,
            descriptor: old,
            last_activity_ms: 1_762_400_000_000 - 600_001,
        }),
    );
    const r = sessionRig({ store });
    await r.session.prepare();

    assert.equal(await store.getSession(old.session_id), undefined);
});

test('a manifest owed while offline is posted once the browser is online', async () => {
    const r = sessionRig({ chunks: true });
    await r.session.prepare();
    await r.session.start();
    await r.env.advance(1000);
    r.env.setOnline(false);
    const stopping = r.session.stop();
    await r.env.advance(30_000);
    assert.equal(r.manifestCalls().length, 0);
    assert.equal(r.session.state.phase, 'stopping');

    r.env.setOnline(true);
    await stopping;
    assert.equal(r.session.state.phase, 'stopped');

    assert.ok(r.manifestCalls().length >= 1);
    assert.deepEqual(
        (await r.store.getSession(r.descriptor.session_id))?.manifest_owed,
        {},
    );
});

test('a resolved waitForReady calls every onReady listener once with the track and url', async () => {
    const r = sessionRig();
    r.respond({
        '/status': () =>
            json(
                200,
                statusBody(
                    { status: 'pending', verdict: null, take: 1, reasons: [] },
                    {
                        playback: {
                            camera: {
                                url: 'https://media.example/camera.webm',
                            },
                        },
                    },
                ),
            ),
    });
    const seen: unknown[] = [];
    r.session.onReady((ready) => seen.push(ready));
    await r.session.waitForReady({ track: 'camera' });

    assert.deepEqual(seen, [
        { track: 'camera', url: 'https://media.example/camera.webm' },
    ]);
});

test('finalise() sends the end of the take, never the time of the call', async () => {
    const r = sessionRig({ chunks: true });
    await recordTake(r, 12_000);
    await r.env.advance(63_000); // the host waited for the verdict
    const finalising = r.session.finalise();
    await r.env.advance(10);
    await finalising;

    assert.deepEqual(
        r.calls(/\/finalise$/).map((call) => call.body),
        ['{"end_ms":12000}'],
    );
});

test('attachPreview shows the capture stream muted, inline and mirrored, and follows a re-acquire', async () => {
    const r = sessionRig();
    await r.session.prepare();
    const video = {
        srcObject: null as unknown,
        muted: false,
        playsInline: false,
        autoplay: false,
        style: { transform: '' },
        play: async () => {},
        requestVideoFrameCallback: () => 1,
        cancelVideoFrameCallback: () => {},
    };
    r.session.attachPreview(video as unknown as HTMLVideoElement);
    const first = video.srcObject;

    assert.deepEqual(
        [
            first === r.session.stream,
            video.muted,
            video.playsInline,
            video.autoplay,
            video.style.transform,
        ],
        [true, true, true, true, 'scaleX(-1)'],
    );
    await r.session.devices.select('camera', 'cam-2');
    assert.ok(
        video.srcObject !== first && video.srcObject === r.session.stream,
    );
});

test('an event batch that lands clears network_blocked: the origin is plainly allowed', async () => {
    const r = sessionRig({ chunks: true });
    r.respond({
        '/segments/': () => {
            throw new TypeError('Failed to fetch');
        },
    });
    await recordTake(r, 1000);

    for (let i = 0; i < 20; i++) {
        await r.env.advance(1000);
    }

    assert.ok(r.calls(/\/events$/).length >= 1);
    assert.notEqual(r.session.state.error?.code, 'network_blocked');
});

test('a stale_take that shows the local take is behind deletes the old take locally', async () => {
    const r = sessionRig({ chunks: true });
    r.respond({
        '/segments/': () =>
            json(409, {
                error: { code: 'stale_take', message: 'x', current_take: 2 },
            }),
    });
    await recordTake(r, 1000);
    await until(() => r.session.state.error?.code === 'stale_take');

    for (let i = 0; i < 20; i++) {
        await settle();
    }

    assert.deepEqual(
        (await r.store.listSegments(r.descriptor.session_id)).filter(
            (segment) => segment.take === 1,
        ),
        [],
    );
    assert.equal(await r.store.storedBytes(), 0);
});

test('a finished session stops its token keeper: no refresh after finalise', async () => {
    const r = sessionRig({ chunks: true });
    await recordTake(r, 1000);
    const finalising = r.session.finalise();
    await r.env.advance(10);
    await finalising;
    await r.env.advance(2 * 675_000);

    assert.deepEqual(r.calls(/\/refresh-upload$/), []);
});

test('a finalised session leaves a tombstone: the same descriptor cannot record again', async () => {
    const r = sessionRig({ chunks: true });
    await recordTake(r, 1000);
    const finalising = r.session.finalise();
    await r.env.advance(10);
    await finalising;
    await until(() => r.session.state.upload.sessionFinalised);
    for (let i = 0; i < 20; i++) {
        await settle();
    }
    const before = r.env.calls.length;
    const again = createSession(
        r.descriptor,
        {},
        rigSeams(r.env, r.store, fakeMedia(r.env), r.storage),
    );
    await r.env.advance(10);

    assert.equal(
        (await r.store.getSession(r.descriptor.session_id))?.finalised,
        true,
    );
    assert.deepEqual(
        [again.state.phase, again.state.upload.sessionFinalised],
        ['stopped', true],
    );
    await assert.rejects(
        again.start(),
        (error: unknown) =>
            (error as { code?: string }).code === 'invalid_state',
    );
    await r.env.advance(10_000);
    assert.deepEqual(
        r.env.calls
            .slice(before)
            .filter((call) => /\/events$|\/segments\//.test(call.url)),
        [],
    );
});

test('a manifest a preflight-blocking network cannot carry lets stop() resolve with manifests_blocked', async () => {
    const r = sessionRig({
        chunks: true,
        options: { upload: { transport: 'post' } },
    });
    r.respond({
        '/manifest': () => {
            throw new TypeError('Failed to fetch');
        },
    });
    await r.session.prepare();
    await r.session.start();
    await r.env.advance(1000);
    let stopped = false;
    void r.session.stop().then(() => {
        stopped = true;
    });
    await r.env.advance(10_000);

    assert.equal(stopped, true);
    assert.equal(r.session.state.error?.code, 'manifests_blocked');
    assert.ok(
        'camera' in
            ((await r.store.getSession(r.descriptor.session_id))
                ?.manifest_owed ?? {}),
    );
});

test('a detached preview no longer follows a re-acquire', async () => {
    const r = sessionRig();
    await r.session.prepare();
    const video = {
        isConnected: true,
        srcObject: null as unknown,
        muted: false,
        playsInline: false,
        autoplay: false,
        style: { transform: '' },
        play: async () => {},
        requestVideoFrameCallback: () => 1,
        cancelVideoFrameCallback: () => {},
    };
    r.session.attachPreview(video as unknown as HTMLVideoElement);
    const first = video.srcObject;
    r.session.detachPreview(video as unknown as HTMLVideoElement);
    await r.session.devices.select('camera', 'cam-2');

    assert.equal(video.srcObject, first);
    assert.notEqual(r.session.stream, first);
});

test('a preview attached before prepare() gets the stream, and the stall watch watches it', async () => {
    const r = sessionRig();
    let frameRequests = 0;
    const video = {
        srcObject: null as unknown,
        muted: false,
        playsInline: false,
        autoplay: false,
        style: { transform: '' },
        play: async () => {},
        requestVideoFrameCallback: () => ++frameRequests,
        cancelVideoFrameCallback: () => {},
    };
    r.session.attachPreview(video as unknown as HTMLVideoElement);
    await r.session.prepare();

    assert.ok(
        r.session.stream !== null && video.srcObject === r.session.stream,
    );
    assert.ok(frameRequests >= 1);
});

/** finalise() after the recorded take, then until the tombstone is written. */
async function finaliseToTombstone(r: SessionRig): Promise<void> {
    const finalising = r.session.finalise();
    await r.env.advance(10);
    await finalising;
    await until(() => r.session.state.upload.sessionFinalised);

    for (let i = 0; i < 20; i++) {
        await settle();
    }

    assert.equal(
        (await r.store.getSession(r.descriptor.session_id))?.finalised,
        true,
    );
}

test('a finalised session still polls checks and playback, in this page and as a tombstone in a later one', async () => {
    const r = sessionRig({ chunks: true });
    r.respond({
        '/status': () =>
            json(
                200,
                statusBody(
                    { status: 'done', verdict: 'accept', take: 1, reasons: [] },
                    {
                        playback: {
                            camera: {
                                url: 'https://media.example/camera.webm',
                            },
                        },
                    },
                ),
            ),
    });
    await recordTake(r, 1000);
    await finaliseToTombstone(r);
    const again = createSession(
        r.descriptor,
        {},
        rigSeams(r.env, r.store, fakeMedia(r.env), r.storage),
    );

    assert.equal(
        await r.session.waitForReady({ track: 'camera' }),
        'https://media.example/camera.webm',
    );
    assert.equal((await again.waitForChecks()).verdict, 'accept');
    assert.equal(
        await again.waitForReady({ track: 'camera' }),
        'https://media.example/camera.webm',
    );
});

test('finalise() from ready leaves a tombstone: no new take, and no refresh after it', async () => {
    const r = sessionRig({ chunks: true });
    await r.session.prepare();
    await finaliseToTombstone(r);

    assert.equal(r.session.state.phase, 'stopped');
    await assert.rejects(
        r.session.start(),
        (error: unknown) =>
            (error as { code?: string }).code === 'invalid_state' &&
            (error as { detail?: { reason?: string } }).detail?.reason ===
                'finalised',
    );
    await r.env.advance(2 * 675_000);
    assert.deepEqual(r.calls(/\/refresh-upload$/), []);
    assert.deepEqual(r.segmentCalls(), []);
});

test('a tombstone freezes and sends no batch when the page hides: the signals and pagehide are detached', async () => {
    const r = sessionRig({ chunks: true });
    await recordTake(r, 1000);
    await finaliseToTombstone(r);
    const before = r.env.calls.length;
    const doc = r.page.doc as unknown as EventTarget & {
        visibilityState: string;
    };
    r.page.win.dispatchEvent(new Event('blur'));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    r.page.win.dispatchEvent(new Event('pagehide'));
    await r.env.advance(10_000);

    assert.deepEqual(
        r.env.calls.slice(before).filter((call) => /\/events$/.test(call.url)),
        [],
    );
    assert.deepEqual(await r.store.listBatches(r.descriptor.session_id), []);
});

test('the purge keeps the numbering of the session being opened: idle past abandon_after_ms, its first batch_seq is still the stored one', async () => {
    const descriptor = descriptorFixture('monitor');
    const store = new MemoryQueueStore();
    await store.putSession(
        sessionRecord({
            session_id: descriptor.session_id,
            descriptor,
            next_batch_seq: 7,
            last_activity_ms: 1_762_400_000_000 - 600_001,
        }),
    );
    await store.putSegment(
        segmentRecord({ session_id: descriptor.session_id }),
    );
    const r = sessionRig({ descriptor, store });
    r.session.event('marker');
    await r.session.prepare();
    await r.env.advance(5000);
    const [body] = r.bodies();

    assert.equal(body.batch_seq, 7);
    assert.deepEqual(await store.listSegments(descriptor.session_id), []);
});

test('a reject verdict after stop moves the phase to rejected with no host call', async () => {
    const r = sessionRig({ recipe: 'answer' });
    const verdict = {
        status: 'done',
        verdict: 'reject',
        take: 1,
        reasons: ['no_speech'],
    };
    const seen: unknown[] = [];
    r.session.onChecks((checks) => seen.push(checks));
    r.respond({ '/status': () => json(200, statusBody(verdict)) });
    await recordTake(r, 6000);
    await r.env.advance(1000);
    await until(() => r.session.state.phase === 'rejected');

    assert.deepEqual(seen, [verdict]);
    assert.equal(
        (await r.store.getSession(r.descriptor.session_id))?.rejected_take,
        1,
    );
});

test('reset from stopped ends in ready with capture again, and start then succeeds', async () => {
    const r = sessionRig();
    await recordTake(r, 1000);
    assert.equal(r.session.state.phase, 'stopped');
    assert.ok(r.media.acquired.flat().every((track) => track.stopped));

    await r.session.reset();

    assert.equal(r.session.state.phase, 'ready');
    assert.equal(r.media.calls(), 2);
    await r.session.start();
    assert.equal(r.session.state.phase, 'recording');
});

test('after a reset, the old take never re-posts a manifest while the new take records', async () => {
    const r = sessionRig({ chunks: true });
    let oldTake: 'retry' | 'stale' = 'retry';
    r.respond({
        '/segments/': (call) => {
            if (call.headers['X-Fitt-Take'] !== '1') {
                return json(201, { code: 'stored', segment: {} });
            }

            return oldTake === 'retry'
                ? json(500, { error: { code: 'server_error', message: 'x' } })
                : json(409, {
                      error: {
                          code: 'stale_take',
                          message: 'x',
                          current_take: 2,
                      },
                  });
        },
    });
    await recordTake(r, 1000);
    const manifestsAtStop = r.manifestCalls().length;
    oldTake = 'stale';
    await r.session.reset();
    await r.session.start();
    await r.env.advance(30_000);

    assert.equal(r.manifestCalls().length, manifestsAtStop);
    assert.deepEqual(
        (await r.store.listSegments(r.descriptor.session_id)).filter(
            (segment) => segment.take === 1,
        ),
        [],
    );
});

test('a reset whose answer was lost is finished first, and the next take uploads as take 2', async () => {
    const descriptor = descriptorFixture('monitor');
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store, chunks: true });
    first.respond({
        '/reset': () => {
            throw new TypeError('Failed to fetch');
        },
    });
    await recordTake(first, 1000);
    void first.session.reset().catch(() => null);
    await settle();
    first.session.destroy();

    const second = sessionRig({
        descriptor: { ...descriptor, take: 2 },
        store,
        chunks: true,
    });
    await recordTake(second, 1000);
    await until(() => second.segmentCalls().length > 0);

    assert.equal(
        second.env.calls.find((call) => call.url.endsWith('/reset'))?.body,
        '{"take":1}',
    );
    assert.equal(second.segmentCalls()[0].headers['X-Fitt-Take'], '2');
});

test('discard() deletes the local session and its copies', async () => {
    const r = sessionRig();
    await r.session.prepare();
    await r.session.discard();

    assert.deepEqual(await r.store.listSessions(), []);
    assert.equal(r.storage.size, 0);
});

test('a 409 session_closed on a segment deletes the local session', async () => {
    const r = sessionRig({ chunks: true });
    r.respond({
        '/segments/': () =>
            json(409, { error: { code: 'session_closed', message: 'x' } }),
    });
    await recordTake(r, 1000);

    for (let i = 0; i < 50 && (await r.store.listSessions()).length > 0; i++) {
        await settle();
    }

    assert.deepEqual(await r.store.listSessions(), []);
});

test('a 409 session_closed from reset keeps the local session and keeps uploading', async () => {
    const r = sessionRig({ chunks: true });
    r.respond({
        '/segments/': () =>
            json(503, { error: { code: 'http_error', message: 'x' } }),
    });
    await recordTake(r, 1000);
    const id = r.descriptor.session_id;
    const pending = (await r.store.listSegments(id))
        .filter((segment) => segment.state === 'pending')
        .map((segment) => segment.seq);
    r.respond({
        '/reset': () =>
            json(409, { error: { code: 'session_closed', message: 'x' } }),
    });

    await assert.rejects(r.session.reset(), (error: unknown) => {
        const failure = error as {
            code?: string;
            detail?: { reason?: string };
        };

        return (
            failure.code === 'invalid_state' &&
            failure.detail?.reason === 'session_closed'
        );
    });
    assert.equal(r.session.state.phase, 'stopped');
    assert.equal((await r.store.listSessions()).length, 1);
    assert.equal((await r.store.getSession(id))?.pending_reset_take, null);
    await r.env.advance(60_000);

    assert.ok(pending.length > 0);
    assert.deepEqual(
        (await r.store.listSegments(id))
            .filter((segment) => pending.includes(segment.seq))
            .map((segment) => segment.state),
        pending.map(() => 'delivered'),
    );
});

test('finalise() without checks.wait resolves on the close answer while checks are still pending', async () => {
    const r = sessionRig({ recipe: 'answer', chunks: true });
    await recordTake(r, 6000);
    const finalising = r.session.finalise();
    await r.env.advance(10);
    await finalising;

    assert.ok(
        r.session.state.checks === null ||
            r.session.state.checks.status === 'pending',
    );
    assert.equal(r.calls(/\/finalise$/).length, 1);
});

test('finalise() with checks.wait resolves at timeoutMs with a local unknown, or after a done verdict', async () => {
    const waiting = sessionRig({
        recipe: 'answer',
        chunks: true,
        options: { checks: { wait: true, timeoutMs: 5000 } },
    });
    await recordTake(waiting, 6000);
    let resolved = false;
    void waiting.session.finalise().then(() => {
        resolved = true;
    });
    await waiting.env.advance(4000);
    assert.equal(resolved, false);
    await waiting.env.advance(1500);
    await until(() => resolved);
    assert.equal(waiting.session.state.checks?.verdict, 'unknown');

    const answered = sessionRig({
        recipe: 'answer',
        chunks: true,
        options: { checks: { wait: true, timeoutMs: 5000 } },
    });
    let done = false;
    answered.respond({
        '/status': () =>
            json(
                200,
                statusBody(
                    done
                        ? {
                              status: 'done',
                              verdict: 'accept',
                              take: 1,
                              reasons: [],
                          }
                        : {
                              status: 'pending',
                              verdict: null,
                              take: 1,
                              reasons: [],
                          },
                ),
            ),
    });
    await recordTake(answered, 6000);
    let accepted = false;
    void answered.session.finalise().then(() => {
        accepted = true;
    });
    await answered.env.advance(1000);
    done = true;
    await answered.env.advance(1500);
    await until(() => accepted);
    assert.equal(answered.session.state.checks?.verdict, 'accept');
});

test('a discard that never landed is finished by the next session over the same store, and nothing is finalised or uploaded', async () => {
    const descriptor = descriptorFixture('monitor');
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store, chunks: true });
    await recordTake(first, 1000);
    first.env.setOnline(false);
    void first.session.discard().catch(() => null);
    await settle();
    first.session.destroy();
    assert.equal(
        (await store.getSession(descriptor.session_id))?.pending_discard,
        true,
    );

    const second = sessionRig({ descriptor, store, chunks: true });
    await until(() => second.calls(/\/discard$/).length === 1);

    for (let i = 0; i < 50 && (await store.listSessions()).length > 0; i++) {
        await settle();
    }

    assert.deepEqual(
        [second.calls(/\/finalise$/).length, second.segmentCalls().length],
        [0, 0],
    );
    assert.deepEqual(await store.listSessions(), []);
});

test('discard while two segment PUTs are in flight leaves nothing behind, whatever they answer later', async () => {
    const r = sessionRig({ chunks: true });
    const held: ((response: Response) => void)[] = [];
    r.respond({
        '/segments/': () =>
            new Promise<Response>((resolve) => held.push(resolve)),
    });
    await recordTake(r, 1000);
    await until(() => held.length >= 2);
    const discarding = r.session.discard();
    await r.env.advance(10);
    await discarding;
    held.forEach((resolve) =>
        resolve(json(409, { error: { code: 'discarded', message: 'x' } })),
    );

    for (let i = 0; i < 20; i++) {
        await settle();
    }

    const id = r.descriptor.session_id;
    assert.deepEqual(
        [
            (await r.store.listSegments(id)).length,
            (await r.store.listRuns(id)).length,
            (await r.store.listBatches(id)).length,
        ],
        [0, 0, 0],
    );
});

test('a take stopped before min_duration_ms is reset on the server before the phase is ready again', async () => {
    const r = sessionRig({ recipe: 'answer', chunks: true });
    await r.session.prepare();
    const starting = r.session.start();
    await r.env.advance(3000);
    await starting;
    await r.env.advance(1000);
    const stopping = r.session.stop().catch((error: unknown) => error);
    await r.env.advance(10);

    assert.equal(((await stopping) as { code?: string }).code, 'too_short');
    assert.equal(r.session.state.phase, 'ready');
    assert.deepEqual(
        r.calls(/\/reset$/).map((call) => call.body),
        ['{"take":1}'],
    );
    assert.equal(r.manifestCalls().length, 0);
    assert.equal(r.media.calls(), 2);
    const stored = await r.store.getSession(r.descriptor.session_id);
    assert.deepEqual([stored?.take, stored?.pending_reset_take], [2, null]);
});

test('a reset answered 401 token_expired that cannot be re-minted is no longer owed', async () => {
    const r = sessionRig();
    await recordTake(r, 1000);
    r.respond({
        '/reset': () =>
            json(401, {
                error: {
                    code: 'token_expired',
                    message: 'x',
                    recoverable: false,
                },
            }),
    });

    await assert.rejects(r.session.reset(), (error: unknown) => {
        const failure = error as {
            code?: string;
            detail?: { reason?: string };
        };

        return (
            failure.code === 'invalid_state' &&
            failure.detail?.reason === 'token_expired'
        );
    });
    assert.equal(
        (await r.store.getSession(r.descriptor.session_id))?.pending_reset_take,
        null,
    );
    assert.equal(r.session.state.phase, 'stopped');
});

test('a discard while the reset re-acquires capture holds no camera, and reset() never ends in ready', async () => {
    const r = sessionRig();
    await recordTake(r, 1000);
    const open = r.media.hold();
    let answerDiscard!: () => void;
    r.respond({
        '/discard': () =>
            new Promise<Response>((resolve) => {
                answerDiscard = () =>
                    resolve(
                        json(200, {
                            session: { id: 'x', status: 'discarded' },
                        }),
                    );
            }),
    });
    const resetting = r.session.reset().catch((error: unknown) => error);
    await until(() => r.media.calls() === 2);
    const discarding = r.session.discard();
    await until(() => r.calls(/\/discard$/).length === 1);
    open();
    const refusal = (await resetting) as {
        code?: string;
        detail?: { reason?: string };
    };

    assert.deepEqual(
        [refusal.code, refusal.detail?.reason],
        ['invalid_state', 'discarding'],
    );
    assert.notEqual(r.session.state.phase, 'ready');
    assert.ok(r.media.acquired.flat().every((track) => track.stopped));
    answerDiscard();
    await discarding;
    assert.deepEqual(await r.store.listSessions(), []);
});

test('a session closed while the reset re-acquires capture rejects reset() as closed', async () => {
    const r = sessionRig();
    await recordTake(r, 1000);
    const open = r.media.hold();
    const resetting = r.session.reset().catch((error: unknown) => error);
    await until(() => r.media.calls() === 2);
    await r.session.discard();
    open();
    const refusal = (await resetting) as {
        code?: string;
        detail?: { reason?: string };
    };

    assert.deepEqual(
        [refusal.code, refusal.detail?.reason],
        ['invalid_state', 'discarded'],
    );
    assert.equal(r.session.state.phase, 'stopped');
    assert.ok(r.media.acquired.flat().every((track) => track.stopped));
});

test('a session closed while its tombstone is written stays deleted, with no unhandled rejection', async () => {
    const r = sessionRig();
    await recordTake(r, 1000);
    let discardedElsewhere = false;
    r.respond({
        '/finalise': () => {
            // The last flush carries this event, and is answered as discarded by another client.
            r.session.event('marker');
            discardedElsewhere = true;

            return json(200, { session: { id: 'x', status: 'finalising' } });
        },
        '/events': () =>
            discardedElsewhere
                ? json(409, { error: { code: 'discarded', message: 'x' } })
                : json(204),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
        await r.session.finalise();

        for (let i = 0; i < 50; i++) {
            await settle();
        }
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(unhandled, []);
    assert.deepEqual(await r.store.listSessions(), []);
});

test('finalise() is refused while a host reset() is in flight', async () => {
    const r = sessionRig();
    await recordTake(r, 1000);
    let answerReset!: () => void;
    r.respond({
        '/reset': () =>
            new Promise<Response>((resolve) => {
                answerReset = () => resolve(json(200, { take: 2 }));
            }),
    });
    const resetting = r.session.reset();
    await until(() => r.calls(/\/reset$/).length === 1);

    await assert.rejects(r.session.finalise(), (error: unknown) => {
        const failure = error as {
            code?: string;
            detail?: { reason?: string };
        };

        return (
            failure.code === 'invalid_state' &&
            failure.detail?.reason === 'resetting'
        );
    });
    answerReset();
    await resetting;
    assert.equal(r.calls(/\/finalise$/).length, 0);
    assert.equal(r.session.state.phase, 'ready');
});

test('reset() is refused while finalise() is in flight', async () => {
    const r = sessionRig();
    await recordTake(r, 1000);
    let answerFinalise!: () => void;
    r.respond({
        '/finalise': () =>
            new Promise<Response>((resolve) => {
                answerFinalise = () =>
                    resolve(
                        json(200, {
                            session: { id: 'x', status: 'finalising' },
                        }),
                    );
            }),
    });
    const finalising = r.session.finalise();
    await until(() => r.calls(/\/finalise$/).length === 1);

    await assert.rejects(r.session.reset(), (error: unknown) => {
        const failure = error as {
            code?: string;
            detail?: { reason?: string };
        };

        return (
            failure.code === 'invalid_state' &&
            failure.detail?.reason === 'finalising'
        );
    });
    answerFinalise();
    await finalising;
    assert.equal(r.calls(/\/reset$/).length, 0);
    assert.equal(r.media.calls(), 1);
});

test('an owed manifest is posted after a reload by the passive session', async () => {
    const descriptor = descriptorFixture('monitor');
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store });
    first.env.setOnline(false);
    await first.session.prepare();
    await first.session.start();
    await first.env.advance(1000);
    void first.session.stop();
    await first.env.advance(10);
    first.session.destroy();

    const second = sessionRig({ descriptor, store, chunks: true });
    await second.session.prepare();
    await until(() => second.manifestCalls().length >= 1);

    assert.deepEqual(
        (await store.getSession(descriptor.session_id))?.manifest_owed,
        {},
    );
});

/** Each resume test has its own session id, because resumeWith() and sessionWith() share the module's same-id map. */
const resumable = (n: number) => ({
    ...descriptorFixture('monitor'),
    session_id: `01jbz8q4w6x0k3m5n7p9r2t4r${n}`,
});

test('a completed stop is finalised by resume() with no host call', async () => {
    const descriptor = resumable(1);
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store, chunks: true });
    await recordTake(first, 2000);
    first.session.destroy();
    const env = fakeEnvironment();
    env.respond(router());
    const entries = await resumeWith({}, rigSeams(env, store, fakeMedia(env)));
    await until(() => env.calls.some((call) => call.url.endsWith('/finalise')));
    await env.advance(5000);

    assert.deepEqual(
        entries.map(({ session_id, state }) => ({ session_id, state })),
        [{ session_id: descriptor.session_id, state: 'finalising' }],
    );
    assert.equal(
        env.calls.filter((call) => call.url.endsWith('/finalise')).length,
        1,
    );
});

test('a lapsed token is resume_expired, sends nothing, and recovers on a fresh descriptor', async () => {
    const descriptor = resumable(2);
    const store = new MemoryQueueStore();
    const env = fakeEnvironment();
    env.respond(router());
    await store.putSession(
        sessionRecord({
            session_id: descriptor.session_id,
            descriptor,
            stop_completed: false,
            last_activity_ms: env.dateNow() - 1000,
            token_expires_at_ms: env.dateNow() - 1,
        }),
    );
    const seams = rigSeams(env, store, fakeMedia(env));
    const entries = await resumeWith({}, seams);
    await env.advance(5000);

    assert.deepEqual(
        entries.map(({ state }) => state),
        ['resume_expired'],
    );
    assert.equal(env.calls.length, 0);

    const renewed = {
        ...descriptor,
        token: { ...descriptor.token, id: '01jbz8q4w6x0k3m5n7p9r2t4bc' },
    };
    assert.equal(sessionWith(renewed, {}, seams), entries[0].session);
    await env.advance(descriptor.events.batch_ms);
    await until(() => env.calls.some((call) => call.url.endsWith('/events')));
    const events = env.calls
        .filter((call) => call.url.endsWith('/events'))
        .flatMap(
            (call) =>
                JSON.parse(call.body as string).events as {
                    type: string;
                    payload?: { session_id?: string };
                }[],
        );

    assert.ok(
        events.some(
            (event) =>
                event.type === 'session.resume_expired' &&
                event.payload?.session_id === descriptor.session_id,
        ),
    );
});

test('a stop, a reset and a second take that a reload interrupts is never finalised by resume()', async () => {
    const descriptor = resumable(3);
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store, chunks: true });
    await recordTake(first, 1000);
    await first.session.reset();
    await first.session.start();
    await first.env.advance(30_000);
    first.session.destroy();
    const env = fakeEnvironment();
    env.respond(router());
    const entries = await resumeWith({}, rigSeams(env, store, fakeMedia(env)));
    await env.advance(10_000);

    assert.deepEqual(
        entries.map(({ state }) => state),
        ['interrupted'],
    );
    assert.equal(
        env.calls.filter((call) => call.url.endsWith('/finalise')).length,
        0,
    );
});

test('a discard that never landed is sent by resume(), returned as discarding, and nothing else is sent', async () => {
    const descriptor = resumable(4);
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store, chunks: true });
    await recordTake(first, 1000);
    first.env.setOnline(false);
    void first.session.discard().catch(() => null);
    await settle();
    first.session.destroy();
    const env = fakeEnvironment();
    env.respond(router());
    const entries = await resumeWith({}, rigSeams(env, store, fakeMedia(env)));
    await until(() => env.calls.some((call) => call.url.endsWith('/discard')));

    for (let i = 0; i < 50 && (await store.listSessions()).length > 0; i++) {
        await settle();
    }

    assert.deepEqual(
        entries.map(({ state }) => state),
        ['discarding'],
    );
    assert.deepEqual(
        env.calls.map((call) => new URL(call.url).pathname.split('/').at(-1)),
        ['discard'],
    );
    assert.deepEqual(await store.listSessions(), []);
});

test('resume_expired freezes a new batch and never edits a stored one', async () => {
    const descriptor = resumable(5);
    const store = new MemoryQueueStore();
    const env = fakeEnvironment();
    env.respond(router());
    const body = JSON.stringify({
        take: 1,
        batch_seq: 0,
        sent_at_ms: env.dateNow(),
        clock_epoch_ms: 1_762_400_000_000,
        events: [],
    });
    await store.putSession(
        sessionRecord({
            session_id: descriptor.session_id,
            descriptor,
            next_batch_seq: 1,
            last_activity_ms: env.dateNow() - 1000,
            token_expires_at_ms: env.dateNow() - 1,
        }),
    );
    await store.putBatch({
        session_id: descriptor.session_id,
        batch_seq: 0,
        take: 1,
        body,
        payload_bytes: 0,
    });
    await resumeWith({}, rigSeams(env, store, fakeMedia(env)));
    const batches = await store.listBatches(descriptor.session_id);

    assert.equal(batches[0].body, body);
    assert.deepEqual(
        batches
            .slice(1)
            .map((batch) => [
                batch.batch_seq,
                JSON.parse(batch.body).events.map(
                    (event: { type: string }) => event.type,
                ),
            ]),
        [[1, ['session.resume_expired']]],
    );
    assert.equal(
        (await store.getSession(descriptor.session_id))?.next_batch_seq,
        2,
    );
});

test('an owed reset is sent by resume() first, and the session is returned as interrupted', async () => {
    const descriptor = resumable(6);
    const store = new MemoryQueueStore();
    const env = fakeEnvironment();
    env.respond(router());
    await store.putSession(
        sessionRecord({
            session_id: descriptor.session_id,
            descriptor,
            pending_reset_take: 1,
            stop_completed: true,
            last_activity_ms: env.dateNow() - 1000,
            token_expires_at_ms: env.dateNow() + 600_000,
        }),
    );
    const entries = await resumeWith({}, rigSeams(env, store, fakeMedia(env)));
    await until(() => env.calls.some((call) => call.url.endsWith('/reset')));
    await env.advance(1000);

    assert.deepEqual(
        entries.map(({ state }) => state),
        ['interrupted'],
    );
    assert.equal(
        env.calls.filter((call) => call.url.endsWith('/finalise')).length,
        0,
    );
    assert.equal(
        (await store.getSession(descriptor.session_id))?.pending_reset_take,
        null,
    );
});

/**
 * A take recorded for `recordMs` in a page that then goes away without a
 * stop (its timers never run again). The fake recorder cuts only when it
 * stops, so each open run is given the segments a live page would have cut:
 * an init and seq 1 delivered, seq 2 still pending.
 */
async function interruptedTake(
    sessionId: string,
    recordMs: number,
    answers: Record<string, Answer> = {},
) {
    const descriptor = {
        ...descriptorFixture('answer'),
        session_id: sessionId,
    };
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store, chunks: true });
    await first.session.prepare();
    const starting = first.session.start();
    await first.env.advance(descriptor.recording?.countdown_ms ?? 0);
    await starting;
    await first.env.advance(recordMs);

    for (const run of await store.listRuns(sessionId)) {
        for (const seq of [0, 1, 2]) {
            await store.putSegment(
                segmentRecord({
                    session_id: sessionId,
                    track: run.track,
                    take: run.take,
                    run_index: run.run_index,
                    run_id: run.run_id,
                    seq,
                    start_ms:
                        seq === 0
                            ? run.anchor_ms
                            : run.anchor_ms + (seq - 1) * 5000,
                    state: seq === 2 ? 'pending' : 'delivered',
                    ...(seq === 2 ? {} : { data: null }),
                }),
            );
        }
    }

    const env = fakeEnvironment({ date: first.env.dateNow() + 5000 });
    const second = sessionRig({ descriptor, store, env, chunks: true });
    second.respond(answers);

    return { descriptor, store, first, second };
}

test('a reload into an open take ends its runs as reload, and start() continues it with no countdown on the wall clock', async () => {
    const { store, second, descriptor } = await interruptedTake(
        '01jbz8q4w6x0k3m5n7p9r2t4s1',
        12_000,
    );
    await second.session.prepare();
    const before = await store.listRuns(descriptor.session_id);
    const segments = await store.listSegments(descriptor.session_id);

    assert.ok(before.length > 0);
    for (const run of before) {
        const ends = segments
            .filter(
                (segment) =>
                    segment.track === run.track &&
                    segment.run_index === run.run_index,
            )
            .map((segment) => segment.start_ms + segment.duration_ms);
        assert.deepEqual(
            [run.ended_reason, run.ended_ms],
            ['reload', Math.max(run.anchor_ms, ...ends)],
        );
    }

    const milestones: string[] = [];
    second.session.onMilestone((milestone) => milestones.push(milestone.name));
    const starting = second.session.start();
    await second.env.advance(10);
    await starting;
    const after = await store.listRuns(descriptor.session_id);

    assert.equal(second.session.state.phase, 'recording');
    assert.deepEqual(milestones, []);
    assert.equal(after.length, before.length * 2);
    assert.ok(
        after
            .filter((run) => run.ended_reason === null)
            .every(
                (run) => run.anchor_source === 'wall_clock' && run.take === 1,
            ),
    );
    // The pending seq 2 of each interrupted run went back into the queue.
    assert.deepEqual(
        second
            .segmentCalls()
            .map((call) => call.url.split('/').slice(-3).join('/'))
            .sort(),
        ['audio/segments/2', 'camera/segments/2'],
    );
});

test('finalise() of an interrupted take seals it where its last stored segment ends', async () => {
    const { store, second, descriptor } = await interruptedTake(
        '01jbz8q4w6x0k3m5n7p9r2t4s2',
        12_000,
    );
    const segments = await store.listSegments(descriptor.session_id);
    const end = Math.max(
        ...segments.map((segment) => segment.start_ms + segment.duration_ms),
    );
    assert.ok(segments.length > 0);
    const finalising = second.session.finalise();
    await second.env.advance(10);
    await finalising;

    assert.deepEqual(
        second
            .manifestCalls()
            .map((call) => JSON.parse(String(call.body)).end_ms),
        [end, end],
    );
    assert.deepEqual(
        second
            .calls(/\/finalise$/)
            .map((call) => JSON.parse(String(call.body)).end_ms),
        [end],
    );
    assert.ok(end < second.session.now() - 5000);
});

test('reset() of an interrupted take resets it without continuing it', async () => {
    const { second } = await interruptedTake(
        '01jbz8q4w6x0k3m5n7p9r2t4s3',
        12_000,
    );
    const resetting = second.session.reset();
    await second.env.advance(10);
    await resetting;
    const starting = second.session.start();
    const milestones: string[] = [];
    second.session.onMilestone((milestone) => milestones.push(milestone.name));
    await second.env.advance(3000);
    await starting;

    assert.equal(second.calls(/\/reset$/).length, 1);
    assert.ok(milestones.includes('countdown_last'));
    assert.equal(second.session.state.phase, 'recording');
});

const staleTake: Record<string, Answer> = {
    '/segments/': () =>
        json(409, {
            error: { code: 'stale_take', message: 'x', current_take: 2 },
        }),
};

test('a stale_take after a reload forgets the interrupted take: finalise() never sends its end', async () => {
    const { store, second, descriptor } = await interruptedTake(
        '01jbz8q4w6x0k3m5n7p9r2t4s5',
        12_000,
        staleTake,
    );
    const segments = await store.listSegments(descriptor.session_id);
    const end = Math.max(
        ...segments.map((segment) => segment.start_ms + segment.duration_ms),
    );
    await until(() => second.session.state.error?.code === 'stale_take');

    for (let i = 0; i < 20; i++) {
        await settle();
    }

    const finalising = second.session.finalise();
    await second.env.advance(10);
    await finalising;
    const ends = second
        .calls(/\/finalise$/)
        .map((call) => JSON.parse(String(call.body)).end_ms as number);

    assert.deepEqual(second.manifestCalls(), []);
    assert.equal(ends.length, 1);
    assert.notEqual(ends[0], end);
    assert.equal(
        (await store.getSession(descriptor.session_id))?.take_end_ms ?? null,
        null,
    );
});

test('a stale_take after a reload forgets the interrupted take: start() begins the new take with its countdown', async () => {
    const { second } = await interruptedTake(
        '01jbz8q4w6x0k3m5n7p9r2t4s6',
        12_000,
        staleTake,
    );
    await until(() => second.session.state.error?.code === 'stale_take');

    for (let i = 0; i < 20; i++) {
        await settle();
    }

    await second.session.prepare();
    const milestones: string[] = [];
    second.session.onMilestone((milestone) => milestones.push(milestone.name));
    const starting = second.session.start();
    await second.env.advance(3000);
    await starting;

    assert.ok(milestones.includes('started'));
    assert.equal(second.session.state.phase, 'recording');
});

test('stop() stores take_end_ms in the same write as the manifests it owes', async () => {
    const store = new MemoryQueueStore();
    const writes: SessionRecord[] = [];
    const put = store.putSession.bind(store);
    store.putSession = (record: SessionRecord) => {
        writes.push(structuredClone(record));

        return put(record);
    };
    const r = sessionRig({ store, chunks: true });
    await recordTake(r, 2000);
    const sealing = writes.find((write) => write.take_end_ms !== null);
    const runTracks = [
        ...new Set(
            (await store.listRuns(r.descriptor.session_id)).map(
                (run) => run.track,
            ),
        ),
    ].sort();

    assert.ok(runTracks.length > 0);
    assert.deepEqual(
        Object.entries(sealing?.manifest_owed ?? {}).sort(),
        runTracks.map((track) => [track, 1]),
    );
});

test('a session resume() purges keeps its numbering: session() for it later continues on the stored epoch and batch_seq', async () => {
    const descriptor = resumable(7);
    const store = new MemoryQueueStore();
    const env = fakeEnvironment();
    env.respond(router());
    const storage = new Map<string, string>();
    const epoch = env.dateNow() - 700_000;
    await store.putSession(
        sessionRecord({
            session_id: descriptor.session_id,
            descriptor,
            epoch_ms: epoch,
            next_batch_seq: 7,
            last_activity_ms: env.dateNow() - 600_001,
        }),
    );
    await store.putSegment(
        segmentRecord({ session_id: descriptor.session_id }),
    );
    const seams = rigSeams(env, store, fakeMedia(env), storage);

    assert.deepEqual(await resumeWith({}, seams), []);
    assert.deepEqual(await store.listSessions(), []);
    assert.deepEqual(await store.listSegments(descriptor.session_id), []);

    const session = sessionWith(descriptor, {}, seams);
    session.event('marker');
    await session.prepare();
    await env.advance(5000);
    const [body] = env.calls
        .filter((call) => call.url.endsWith('/events'))
        .map(
            (call) =>
                JSON.parse(String(call.body)) as {
                    batch_seq: number;
                    clock_epoch_ms: number;
                },
        );

    assert.deepEqual([body?.batch_seq, body?.clock_epoch_ms], [7, epoch]);
});

test('a reload after a completed stop is stopped: start() needs reset() first', async () => {
    const descriptor = {
        ...descriptorFixture('monitor'),
        session_id: '01jbz8q4w6x0k3m5n7p9r2t4s4',
    };
    const store = new MemoryQueueStore();
    const first = sessionRig({ descriptor, store, chunks: true });
    await recordTake(first, 2000);
    first.session.destroy();
    const second = sessionRig({ descriptor, store, chunks: true });
    await second.session.prepare();

    assert.equal(second.session.state.phase, 'stopped');
    await assert.rejects(
        second.session.start(),
        (error: unknown) =>
            (error as { code?: string }).code === 'invalid_state',
    );
});
