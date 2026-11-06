import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    readDescriptor,
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
