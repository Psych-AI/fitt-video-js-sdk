import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FittVideoError } from '../../src/core/errors.ts';
import { json } from '../support/fake-env.ts';
import { FakeVideo, fakeObjectUrls } from '../support/fake-video.ts';
import { descriptorFixture } from '../support/records.ts';
import { recordTake, sessionRig, statusBody } from '../support/session-rig.ts';

const PENDING = { status: 'pending', verdict: null, take: 1, reasons: [] };
const SERVER = 'https://media.test/camera-1.webm';
const HELD = 959_046;

/** An answer session whose status carries the camera URL once the test sets it. */
function reviewRig(
    options: {
        local?: boolean;
        inStatus?: boolean;
        routes?: Parameters<ReturnType<typeof sessionRig>['respond']>[0];
    } = {},
) {
    const descriptor = descriptorFixture('answer');
    descriptor.playback = {
        local: options.local ?? true,
        local_max_bytes: 100_000_000,
        in_status: options.inStatus ?? true,
    };
    const urls = fakeObjectUrls();
    const r = sessionRig({ descriptor, chunks: true, objectUrls: urls });
    const server = { url: null as string | null };
    r.respond({
        '/status': () =>
            json(
                200,
                statusBody(
                    PENDING,
                    server.url === null
                        ? { playback: {} }
                        : {
                              playback: {
                                  camera: {
                                      url: server.url,
                                      expires_at: '2026-11-12T10:02:00Z',
                                      mime_type: 'video/webm',
                                  },
                              },
                          },
                ),
            ),
        ...options.routes,
    });

    return { ...r, urls, server };
}

/** The playback.source payloads the session raised. */
function sources(r: ReturnType<typeof reviewRig>): unknown[] {
    const seen: unknown[] = [];
    r.session.onEvent((event) => {
        if (event.type === 'playback.source') {
            seen.push(event.payload);
        }
    });

    return seen;
}

/** The session ms from the take start to the camera run's anchor. */
async function leadIn(r: ReturnType<typeof reviewRig>): Promise<number> {
    const run = (await r.store.listRuns(r.descriptor.session_id)).find(
        (x) => x.track === 'camera',
    )!;
    const record = (await r.store.getSession(r.descriptor.session_id))!;

    return run.anchor_ms - record.take_start_ms!;
}

async function playLocal(
    r: ReturnType<typeof reviewRig>,
    video: FakeVideo,
): Promise<void> {
    const playing = r.session.playback(video as unknown as HTMLVideoElement);
    await r.env.advance(1500);
    assert.equal(await playing, 'local');
}

test('the server file plays first when it is ready at the first look', async () => {
    const r = reviewRig();
    const seen = sources(r);
    await recordTake(r, 6000);
    r.server.url = SERVER;
    const video = new FakeVideo();
    const playing = r.session.playback(video as unknown as HTMLVideoElement);
    await r.env.advance(100);

    assert.equal(await playing, 'server');
    assert.equal(video.src, SERVER);
    assert.deepEqual(seen, [{ source: 'server', at: 'start' }]);
    assert.deepEqual(
        [
            r.session.state.playback.source,
            r.session.state.playback.local,
            r.session.state.playback.localReason,
        ],
        ['server', 'cleared', 'server'],
    );
    assert.deepEqual(r.urls.made, []);
});

test('the local copy plays while the server file is not ready', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);

    assert.equal(video.src, 'blob:fake/1');
    assert.deepEqual(r.session.state.playback, {
        source: 'local',
        local: 'held',
        localBytes: HELD,
        localReason: null,
        objectUrls: 1,
        revoked: 0,
    });

    // Past the descriptor's events.batch_ms (5000): playback.source reached onEvent, never a batch (author's call 9).
    await r.env.advance(6000);
    assert.deepEqual(
        r
            .bodies()
            .flatMap((body) => body.events)
            .filter((event) => event.type.startsWith('playback.')),
        [],
    );
});

test('the local copy is loaded whole: preload is auto before its src is set (Safari 18.6 fails a metadata-only blob on play)', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    const video = new FakeVideo();
    assert.equal(video.preload, 'metadata');
    await playLocal(r, video);

    assert.equal(video.preload, 'auto');
    assert.equal(video.src, 'blob:fake/1');
});

test('a media error on the local copy clears it as unplayable and falls back to the server file at the same place', async () => {
    const r = reviewRig();
    const seen = sources(r);
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    video.play();
    video.currentTime = 2;
    video.fail();

    assert.deepEqual(
        [
            r.session.state.playback.source,
            r.session.state.playback.local,
            r.session.state.playback.localReason,
        ],
        ['preparing', 'cleared', 'unplayable'],
    );
    assert.deepEqual(r.urls.revoked, ['blob:fake/1']);
    assert.deepEqual(seen.at(-1), {
        source: 'preparing',
        from: 'local',
        at: 'error',
    });

    r.server.url = SERVER;
    await r.env.advance(4000);

    assert.equal(video.src, SERVER);
    video.loaded(9);
    const lead = await leadIn(r);
    assert.equal(video.currentTime, 2 + lead / 1000);
    assert.deepEqual(seen.at(-1), {
        source: 'server',
        from: 'local',
        at: 'error',
        offset_ms: lead,
    });
    assert.equal(r.session.state.playback.source, 'server');
});

test('a media error on the local copy with no server playback leaves no source and keeps the reason', async () => {
    const r = reviewRig({ inStatus: false });
    const seen = sources(r);
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    video.fail();

    assert.deepEqual(
        [r.session.state.playback.source, r.session.state.playback.localReason],
        ['none', 'unplayable'],
    );
    assert.deepEqual(seen.at(-1), {
        source: 'none',
        from: 'local',
        at: 'error',
    });
});

test('the switch waits for a pause, keeps the place plus the lead-in, and never cuts in mid play', async () => {
    const r = reviewRig();
    const seen = sources(r);
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    video.play();
    video.currentTime = 3;
    r.server.url = SERVER;
    await r.env.advance(4000);

    assert.equal(video.src, 'blob:fake/1');

    video.pause();
    assert.equal(video.src, SERVER);
    video.loaded(9);
    const lead = await leadIn(r);

    assert.equal(video.currentTime, 3 + lead / 1000);
    assert.deepEqual(seen, [
        { source: 'local', at: 'start' },
        { source: 'server', from: 'local', at: 'paused', offset_ms: lead },
    ]);
    assert.deepEqual(r.urls.revoked, ['blob:fake/1']);
    assert.deepEqual(
        [r.session.state.playback.source, r.session.state.playback.localReason],
        ['server', 'server'],
    );
});

test('an ended local copy switches to the end of the server file', async () => {
    const r = reviewRig();
    const seen = sources(r);
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    video.play();
    video.end();
    r.server.url = SERVER;
    await r.env.advance(4000);

    assert.equal(video.src, SERVER);
    video.loaded(9);
    assert.equal(video.currentTime, 9);
    assert.equal((seen.at(-1) as { at: string }).at, 'ended');
});

test('a server file that is ready before the person presses play takes over at once', async () => {
    const r = reviewRig();
    const seen = sources(r);
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    r.server.url = SERVER;
    await r.env.advance(2000);

    assert.equal(video.src, SERVER);
    video.loaded(9);
    const lead = await leadIn(r);
    assert.equal(video.currentTime, lead / 1000);
    assert.deepEqual(seen.at(-1), {
        source: 'server',
        from: 'local',
        at: 'paused',
        offset_ms: lead,
    });
    assert.deepEqual(r.urls.revoked, ['blob:fake/1']);
    assert.deepEqual(
        [r.session.state.playback.local, r.session.state.playback.localReason],
        ['cleared', 'server'],
    );
});

test('a second playback() call cancels the first player and only the latest element switches', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    const first = new FakeVideo();
    await playLocal(r, first);
    const second = new FakeVideo();
    await playLocal(r, second);
    assert.deepEqual([first.src, second.src], ['blob:fake/1', 'blob:fake/2']);

    r.server.url = SERVER;
    await r.env.advance(2000);
    first.play();
    first.pause();

    assert.equal(second.src, SERVER);
    assert.equal(first.src, 'blob:fake/1');
    assert.deepEqual(r.urls.revoked, ['blob:fake/1', 'blob:fake/2']);
});

test('playback() again on a playing local copy never changes src until a pause', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    video.play();
    video.currentTime = 3;
    r.server.url = SERVER;
    const again = r.session.playback(video as unknown as HTMLVideoElement);
    await r.env.advance(2000);

    assert.equal(await again, 'local');
    assert.equal(video.src, 'blob:fake/1');
    assert.deepEqual(r.urls.made, ['blob:fake/1']);
    assert.equal(r.session.state.playback.source, 'local');

    video.pause();
    assert.equal(video.src, SERVER);
    assert.deepEqual(r.urls.revoked, ['blob:fake/1']);
});

test('without a copy the source is preparing, then the server file', async () => {
    const r = reviewRig({ local: false });
    await recordTake(r, 6000);
    const video = new FakeVideo();
    const playing = r.session.playback(video as unknown as HTMLVideoElement);
    await r.env.advance(10);

    assert.equal(r.session.state.playback.source, 'preparing');

    r.server.url = SERVER;
    await r.env.advance(2000);
    assert.equal(await playing, 'server');
    assert.equal(video.src, SERVER);
    assert.deepEqual(r.urls.made, []);
});

test('with no copy and no status playback, playback() rejects playback_not_enabled and the source is none', async () => {
    const r = reviewRig({ local: false, inStatus: false });
    await recordTake(r, 6000);

    await assert.rejects(
        r.session.playback(new FakeVideo() as unknown as HTMLVideoElement),
        (error) =>
            error instanceof FittVideoError &&
            error.code === 'playback_not_enabled',
    );
    assert.equal(r.session.state.playback.source, 'none');
});

test('a local copy without status playback plays at once and stays local', async () => {
    const r = reviewRig({ inStatus: false });
    await recordTake(r, 6000);
    const video = new FakeVideo();
    const playing = r.session.playback(video as unknown as HTMLVideoElement);
    await r.env.advance(10);

    assert.equal(await playing, 'local');
    await r.env.advance(120_000);
    assert.equal(video.src, 'blob:fake/1');
    assert.deepEqual(
        [r.session.state.playback.source, r.session.state.playback.local],
        ['local', 'held'],
    );
});

test('an expired server URL is fetched again and keeps the place', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    r.server.url = SERVER;
    const video = new FakeVideo();
    const playing = r.session.playback(video as unknown as HTMLVideoElement);
    await r.env.advance(100);
    await playing;
    video.loaded(9);
    video.currentTime = 4;
    r.server.url = 'https://media.test/camera-2.webm';
    video.dispatchEvent(new Event('error'));
    await r.env.advance(100);

    assert.equal(video.src, 'https://media.test/camera-2.webm');
    video.loaded(9);
    assert.equal(video.currentTime, 4);
});

test('a refetched server URL that errors before its metadata is not fetched again, and the place stays', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    r.server.url = SERVER;
    const video = new FakeVideo();
    const playing = r.session.playback(video as unknown as HTMLVideoElement);
    await r.env.advance(100);
    await playing;
    video.loaded(9);
    video.currentTime = 4;
    r.server.url = 'https://media.test/camera-2.webm';
    video.dispatchEvent(new Event('error'));
    await r.env.advance(100);
    assert.equal(video.src, 'https://media.test/camera-2.webm');

    video.currentTime = 0;
    r.server.url = 'https://media.test/camera-3.webm';
    video.dispatchEvent(new Event('error'));
    await r.env.advance(10_000);
    video.dispatchEvent(new Event('error'));
    await r.env.advance(10_000);

    assert.equal(video.src, 'https://media.test/camera-2.webm');
    video.loaded(9);
    assert.equal(video.currentTime, 4);
});

test('playback() on a preview element is refused and never touches it', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    const preview = Object.assign(new FakeVideo(), { style: {} });
    r.session.attachPreview(preview as unknown as HTMLVideoElement);
    const streamed = Object.assign(new FakeVideo(), { srcObject: {} });

    for (const video of [preview, streamed]) {
        const before = video.src;
        await assert.rejects(
            r.session.playback(video as unknown as HTMLVideoElement),
            (error) =>
                error instanceof FittVideoError &&
                error.code === 'invalid_state' &&
                error.detail.reason === 'preview_element',
        );
        assert.equal(video.src, before);
    }

    assert.equal(r.session.state.playback.source, 'none');
});

test('destroy() clears the copy, revokes its URL and ends the wait for the server', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    r.session.destroy();
    r.server.url = SERVER;
    await r.env.advance(10_000);

    assert.equal(video.src, 'blob:fake/1');
    assert.deepEqual(r.urls.revoked, ['blob:fake/1']);
    assert.deepEqual(
        [r.session.state.playback.local, r.session.state.playback.localReason],
        ['cleared', 'destroy'],
    );
});

test('playback() during a take is refused', async () => {
    const r = reviewRig();
    await r.session.prepare();
    const starting = r.session.start();
    await r.env.advance(3000);
    await starting;

    await assert.rejects(
        r.session.playback(new FakeVideo() as unknown as HTMLVideoElement),
        (error) =>
            error instanceof FittVideoError && error.code === 'invalid_state',
    );
});

test('a discard the server holds ends the wait for the server file, and the source is none', async () => {
    const r = reviewRig({
        routes: {
            '/finalise': () =>
                json(409, { error: { code: 'discarded', message: 'x' } }),
        },
    });
    await recordTake(r, 6000);
    const video = new FakeVideo();
    await playLocal(r, video);
    const finalising = r.session.finalise().catch(() => undefined);
    await r.env.advance(10);
    await finalising;
    const polls = r.calls(/\/status$/).length;
    r.server.url = SERVER;
    await r.env.advance(10_000);

    assert.equal(r.calls(/\/status$/).length, polls);
    assert.equal(video.src, 'blob:fake/1');
    assert.deepEqual(
        [
            r.session.state.playback.source,
            r.session.state.playback.local,
            r.session.state.playback.localReason,
        ],
        ['none', 'cleared', 'discard'],
    );
});

test('a reset after a review returns the source to none', async () => {
    const r = reviewRig();
    await recordTake(r, 6000);
    await playLocal(r, new FakeVideo());
    const resetting = r.session.reset();
    await r.env.advance(10);
    await resetting;

    assert.deepEqual(
        [r.session.state.playback.source, r.session.state.playback.local],
        ['none', 'cleared'],
    );
});

test('a player replaced while its status answer is in flight never settles', async () => {
    const r = reviewRig({ local: false });
    await recordTake(r, 6000);
    r.server.url = SERVER;
    const first = new FakeVideo();
    const second = new FakeVideo();
    const settledFirst = { value: false };
    void r.session.playback(first as unknown as HTMLVideoElement).then(
        () => (settledFirst.value = true),
        () => (settledFirst.value = true),
    );
    const playing = r.session.playback(second as unknown as HTMLVideoElement);
    await r.env.advance(2000);

    assert.equal(await playing, 'server');
    assert.equal(settledFirst.value, false);
    assert.deepEqual([first.src, second.src], ['', SERVER]);
    assert.equal(r.session.state.playback.source, 'server');
});
