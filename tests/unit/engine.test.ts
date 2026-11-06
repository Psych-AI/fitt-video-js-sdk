import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import type { ChunkedTrack } from '../../src/core/descriptor.ts';
import { FittVideoError } from '../../src/core/errors.ts';
import type { RunRecord, SegmentRecord } from '../../src/core/store.ts';
import { createRecorderEngine } from '../../src/recorder/engine.ts';
import { fakeEnvironment } from '../support/fake-env.ts';
import { fakeMedia } from '../support/fake-media.ts';
import { readSet } from '../support/fixtures.ts';
import { descriptorFixture, SID } from '../support/records.ts';

function engineRig(
    options: {
        labels?: string[];
        permission?: Partial<Record<'camera' | 'microphone', PermissionState>>;
        chunks?: boolean;
        noRecorder?: boolean;
    } = {},
) {
    const env = fakeEnvironment();
    const clock = createClock(env);
    const media = fakeMedia(env, {
        cameraLabels: options.labels,
        chunks: options.chunks
            ? readSet('chrome-vp8-kf').blobs.slice(0, 4)
            : [],
    });
    const added: SegmentRecord[] = [];
    const doc = Object.assign(new EventTarget(), {
        visibilityState: 'visible',
    });
    const permission: Record<string, PermissionState> = {
        camera: 'granted',
        microphone: 'granted',
        ...options.permission,
    };
    const events: [string, Record<string, unknown>][] = [];
    const errors: (string | null)[] = [];
    const runs = new Map<string, RunRecord>();
    let runIndex = 0;
    const engine = createRecorderEngine({
        env,
        clock,
        sessionId: SID,
        take: () => 1,
        tracks: descriptorFixture('answer').tracks as ChunkedTrack[],
        media,
        recorderFactory: options.noRecorder
            ? () => {
                  throw new ReferenceError('MediaRecorder is not defined');
              }
            : media.recorderFactory,
        isTypeSupported: () => true,
        bitrates: () => ({ video: 300_000, audio: 32_000 }),
        cameraAudio: (stream) => stream.getAudioTracks(),
        makeStream: media.makeStream,
        permissions: {
            query: async ({ name }: { name: string }) => ({
                state: permission[name],
            }),
        } as unknown as Permissions,
        nextRunIndex: () => runIndex++,
        putRun: async (record) => {
            runs.set(record.run_id, record);
        },
        add: async (record) => {
            added.push(record);
        },
        emit: (type, payload) => events.push([type, payload]),
        onError: (code) => errors.push(code),
        ua: 'Mozilla/5.0 (test)',
    });
    const cameraReasons = (): (string | null)[] =>
        [...runs.values()]
            .filter((run) => run.track === 'camera')
            .map((run) => run.ended_reason);
    const stop = async (): Promise<void> => {
        const stopping = engine.stopTake();
        await env.advance(10);
        await stopping;
    };

    return {
        env,
        media,
        doc,
        permission,
        engine,
        events,
        errors,
        runs,
        added,
        cameraReasons,
        stop,
    };
}

test('prepare reports the permission states as device.permission_granted', async () => {
    const r = engineRig();
    await r.engine.prepare();

    assert.deepEqual(
        r.events.find(([type]) => type === 'device.permission_granted')?.[1],
        { camera: 'granted', microphone: 'granted' },
    );
});

test('stopTake ends every run with stop and releases every track it acquired', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    await r.stop();

    assert.deepEqual(r.cameraReasons(), ['stop']);
    assert.ok(r.media.acquired.flat().every((track) => track.stopped));
});

test('the camera run takes a camera type and the audio run an audio type, each its own recorder', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);

    assert.deepEqual(
        r.media.recorders.map((recorder) => recorder.mimeType),
        ['video/webm;codecs=vp8,opus', 'audio/webm;codecs=opus'],
    );
    assert.deepEqual(
        [...r.runs.values()].map((run) => run.track),
        ['camera', 'audio'],
    );
    await r.stop();
});

test('a browser with no MediaRecorder is recorder_unsupported, and stopTake still releases capture', async () => {
    const r = engineRig({ noRecorder: true });
    await r.engine.prepare();

    await assert.rejects(
        r.engine.startTake(0),
        (error: unknown) =>
            error instanceof FittVideoError &&
            error.code === 'recorder_unsupported',
    );
    assert.deepEqual(r.errors, ['recorder_unsupported']);
    assert.equal(r.runs.size, 0);

    await r.stop();
    assert.ok(r.media.acquired.flat().every((track) => track.stopped));
    assert.equal(r.engine.stream, null);
});

test('a prepare after a release acquires again, and one while a stream is held does nothing', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.prepare();
    assert.equal(r.media.calls(), 1);

    r.engine.release();
    await r.engine.prepare();
    assert.equal(r.media.calls(), 2);
});

test('a refused capture throws its SDK code', async () => {
    const r = engineRig();
    r.media.refuse('NotAllowedError');

    await assert.rejects(
        r.engine.prepare(),
        (error: unknown) =>
            error instanceof FittVideoError &&
            error.code === 'permission_denied',
    );
    assert.equal(r.engine.stream, null);
});
