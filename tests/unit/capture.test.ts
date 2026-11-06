import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    acquire,
    captureError,
    permissionState,
    type MediaDevicesLike,
} from '../../src/recorder/capture.ts';
import { chooseMime } from '../../src/recorder/mime.ts';
import { descriptorFixture } from '../support/records.ts';

const ANSWER_TRACKS = descriptorFixture('answer').tracks;

function media(
    getUserMedia: MediaDevicesLike['getUserMedia'],
): MediaDevicesLike {
    return { getUserMedia, enumerateDevices: async () => [] };
}

test('one getUserMedia call with the answer constraints', async () => {
    const asked: MediaStreamConstraints[] = [];
    await acquire(
        media(async (constraints) => {
            asked.push(constraints);
            return {} as MediaStream;
        }),
        ANSWER_TRACKS,
        {},
    );

    assert.deepEqual(asked, [
        {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30 },
                facingMode: 'user',
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        },
    ]);
});

test('a chosen device is asked for exactly, and once more without it when it is gone', async () => {
    const asked: MediaStreamConstraints[] = [];
    let first = true;
    await acquire(
        media(async (constraints) => {
            asked.push(constraints);

            if (first) {
                first = false;
                throw new DOMException(
                    'the device is gone',
                    'OverconstrainedError',
                );
            }

            return {} as MediaStream;
        }),
        ANSWER_TRACKS,
        { camera: 'cam-2' },
    );

    assert.deepEqual(
        asked.map((c) => (c.video as MediaTrackConstraints).deviceId),
        [{ exact: 'cam-2' }, undefined],
    );
});

test('DOMException names map to the SDK codes, never the message', () => {
    const devices = (kinds: string[]) =>
        kinds.map((kind) => ({ kind }) as MediaDeviceInfo);
    const cases = [
        ['NotAllowedError', [], 'permission_denied'],
        ['SecurityError', [], 'permission_denied'],
        ['NotReadableError', [], 'device_busy'],
        ['AbortError', [], 'device_busy'],
        ['NotFoundError', ['audioinput'], 'no_camera'],
        ['NotFoundError', ['videoinput'], 'no_microphone'],
        ['TypeError', [], 'recorder_unsupported'],
    ] as const;

    for (const [name, kinds, code] of cases) {
        assert.equal(
            captureError(
                new DOMException('any words at all', name),
                devices([...kinds]),
            ),
            code,
            name,
        );
    }
});

test('a permissions.query that rejects is caught as unknown', async () => {
    const rejecting = {
        query: async () => {
            throw new TypeError("'camera' is not a valid value");
        },
    } as unknown as Permissions;

    assert.equal(await permissionState(rejecting, 'camera'), 'unknown');
    assert.equal(await permissionState(undefined, 'microphone'), 'unknown');
});

test('the first supported MIME type wins, in the spec order', () => {
    const supported = (types: string[]) => (type: string) =>
        types.includes(type);

    assert.equal(
        chooseMime(
            'camera',
            supported([
                'video/webm',
                'video/webm;codecs=vp9,opus',
                'video/webm;codecs=vp8,opus',
            ]),
        ),
        'video/webm;codecs=vp8,opus',
    );
    assert.equal(
        chooseMime(
            'camera',
            supported(['video/mp4', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2']),
        ),
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    );
    assert.equal(chooseMime('camera', supported([])), '');
    assert.equal(
        chooseMime('audio', supported(['audio/mp4', 'audio/webm;codecs=opus'])),
        'audio/webm;codecs=opus',
    );
});
