import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    readDescriptor,
    startsDirect,
    type ChunkedTrack,
} from '../../src/core/descriptor.ts';

const fixture = (recipe: string): Record<string, any> =>
    JSON.parse(
        readFileSync(
            new URL(`../fixtures/descriptor-${recipe}.json`, import.meta.url),
            'utf8',
        ),
    );

test('the answer descriptor reads with every limit the SDK uses', () => {
    const result = readDescriptor(fixture('answer'));
    assert.ok(result.ok);
    const [camera, audio] = result.descriptor.tracks as ChunkedTrack[];

    assert.deepEqual(camera.segments, {
        target_ms: 5000,
        max_ms: 30000,
        part_size: 5_242_880,
        max_bytes: 8_388_608,
    });
    assert.deepEqual(camera.capture, {
        video: {
            width: 640,
            height: 480,
            frame_rate: 30,
            bitrate_bps: 300_000,
        },
        audio: { bitrate_bps: 32_000, channels: 1 },
    });
    assert.deepEqual(
        [audio.segments.part_size, audio.segments.max_bytes],
        [1_048_576, 1_048_576],
    );
    assert.deepEqual(result.descriptor.recording, {
        countdown_ms: 3000,
        min_duration_ms: 5000,
        max_duration_ms: 600_000,
        extension_ms: 30_000,
        warning_before_end_ms: 15_000,
    });
});

test('every recipe fixture reads', () => {
    for (const recipe of ['answer', 'monitor', 'conversation', 'file']) {
        assert.equal(readDescriptor(fixture(recipe)).ok, true, recipe);
    }
});

test('a maximum below the minimum is config_invalid, never a throw', () => {
    const descriptor = fixture('answer');
    descriptor.recording.max_duration_ms = 4000;

    assert.deepEqual(readDescriptor(descriptor), {
        ok: false,
        code: 'config_invalid',
        path: 'recording.max_duration_ms',
        reason: 'max_below_min',
    });
});

test('a maximum plus extension over the session cap is config_invalid, and exactly the cap is valid', () => {
    const over = fixture('answer');
    over.recording.max_duration_ms = 7_170_001;

    assert.deepEqual(readDescriptor(over), {
        ok: false,
        code: 'config_invalid',
        path: 'recording.max_duration_ms',
        reason: 'over_cap',
    });
    assert.equal(readDescriptor(fixture('monitor')).ok, true);
});

test('anything that is not a descriptor is config_invalid with the first path that failed', () => {
    const noSecret = fixture('answer');
    delete noSecret.token.secret;

    assert.deepEqual(readDescriptor(null), {
        ok: false,
        code: 'config_invalid',
        path: '',
        reason: 'type',
    });
    assert.deepEqual(readDescriptor({}), {
        ok: false,
        code: 'config_invalid',
        path: 'session_id',
        reason: 'missing',
    });
    assert.deepEqual(readDescriptor(noSecret), {
        ok: false,
        code: 'config_invalid',
        path: 'token.secret',
        reason: 'missing',
    });
});

test('a bad field inside a track names its dotted path', () => {
    const descriptor = fixture('answer');
    descriptor.tracks[1].segments.max_bytes = '1048576';

    assert.deepEqual(readDescriptor(descriptor), {
        ok: false,
        code: 'config_invalid',
        path: 'tracks.1.segments.max_bytes',
        reason: 'type',
    });
});

/** Wraps a value the way a Vue reactive prop or an Inertia page prop reaches a host: a Proxy on every object, down the tree. */
const reactive = (value: unknown): unknown =>
    typeof value === 'object' && value !== null
        ? new Proxy(value, {
              get: (target, key) =>
                  reactive(Reflect.get(target, key as string)),
          })
        : value;

test('readDescriptor returns a plain copy, never the host object: a reactive Proxy reads, the copy is structured-cloneable and later host edits do not reach it', () => {
    const input = fixture('answer');
    const proxied = reactive(input);

    const result = readDescriptor(proxied);

    assert.ok(result.ok);
    assert.notEqual(result.descriptor as unknown, proxied);
    assert.notEqual(result.descriptor as unknown, input);
    assert.doesNotThrow(() => structuredClone(result.descriptor));
    assert.deepEqual(result.descriptor, fixture('answer'));

    input.token.secret = 'changed-by-the-host-afterwards';

    assert.equal(
        result.descriptor.token.secret,
        fixture('answer').token.secret,
    );
});

test('a direct descriptor reads its confirm URL and its slots or its signed base', () => {
    for (const name of ['answer-s3', 'answer-cloudfront']) {
        const result = readDescriptor(fixture(name));
        assert.ok(result.ok, name);
        assert.equal(startsDirect(result.descriptor), true);
    }

    const passthrough = readDescriptor(fixture('answer'));
    assert.ok(passthrough.ok);
    assert.equal(startsDirect(passthrough.descriptor), false);
});

test('a direct block names what is wrong with it', () => {
    const noSlots = fixture('answer-s3');
    delete noSlots.tracks[0].upload.direct.slots;
    const both = fixture('answer-cloudfront');
    both.tracks[0].upload.direct.slots = ['https://x.test/a'];
    const badAttempt = fixture('answer-s3');
    badAttempt.tracks[1].upload.direct.attempt = 'NOT-A-ULID';
    const noConfirm = fixture('answer-s3');
    noConfirm.tracks[0].upload.confirm_url = 'https://x.test/confirm';

    assert.deepEqual(readDescriptor(noSlots), {
        ok: false,
        code: 'config_invalid',
        path: 'tracks.0.upload.direct.slots',
        reason: 'missing',
    });
    assert.deepEqual(readDescriptor(both), {
        ok: false,
        code: 'config_invalid',
        path: 'tracks.0.upload.direct.slots',
        reason: 'type',
    });
    assert.deepEqual(readDescriptor(badAttempt), {
        ok: false,
        code: 'config_invalid',
        path: 'tracks.1.upload.direct.attempt',
        reason: 'type',
    });
    assert.deepEqual(readDescriptor(noConfirm), {
        ok: false,
        code: 'config_invalid',
        path: 'tracks.0.upload.confirm_url',
        reason: 'type',
    });
});

test('the playback block reads, an older descriptor without it reads, and a bad one names its path', () => {
    const answer = readDescriptor(fixture('answer'));
    assert.ok(answer.ok);
    assert.deepEqual(answer.descriptor.playback, {
        local: true,
        local_max_bytes: 100_000_000,
        in_status: false,
    });

    const monitor = readDescriptor(fixture('monitor'));
    assert.ok(monitor.ok);
    assert.equal(monitor.descriptor.playback?.local, false);

    const older = fixture('answer');
    delete older.playback;
    assert.equal(readDescriptor(older).ok, true);

    const bad = fixture('answer');
    bad.playback.local = 'yes';
    assert.deepEqual(readDescriptor(bad), {
        ok: false,
        code: 'config_invalid',
        path: 'playback.local',
        reason: 'type',
    });
});
