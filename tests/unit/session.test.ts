import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSettings } from '../../src/core/options.ts';
import { createSession, sessionWith } from '../../src/core/session.ts';
import { MemoryQueueStore } from '../../src/core/store.ts';
import { FittVideo } from '../../src/index.ts';
import { fakeEnvironment, json, settle, until } from '../support/fake-env.ts';
import { fakeMedia } from '../support/fake-media.ts';
import { descriptorFixture, sessionRecord } from '../support/records.ts';
import {
    recordTake,
    rigSeams,
    sessionRig,
    statusBody,
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
