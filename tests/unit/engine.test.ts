import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import type { ChunkedTrack } from '../../src/core/descriptor.ts';
import { FittVideoError } from '../../src/core/errors.ts';
import type { RunRecord, SegmentRecord } from '../../src/core/store.ts';
import { createRecorderEngine } from '../../src/recorder/engine.ts';
import { fakeEnvironment, settle } from '../support/fake-env.ts';
import { fakeMedia } from '../support/fake-media.ts';
import { readSet } from '../support/fixtures.ts';
import { descriptorFixture, SID } from '../support/records.ts';

function engineRig(
    options: {
        labels?: string[];
        permission?: Partial<Record<'camera' | 'microphone', PermissionState>>;
        chunks?: boolean;
        noRecorder?: boolean;
        /** Held before a segment is stored, when it returns a promise. */
        holdAdd?: (record: SegmentRecord) => Promise<void> | undefined;
        /** Gives the engine an audio graph on this context. */
        audioContext?: () => AudioContext;
        /** The fixture descriptor the tracks come from (answer by default). */
        recipe?: string;
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
    const streams: (MediaStream | null)[] = [];
    const runs = new Map<string, RunRecord>();
    const samples: [number, number][] = [];
    /** Every stream a run was given, in order. */
    const made: MediaStream[] = [];
    let runIndex = 0;
    const engine = createRecorderEngine({
        env,
        clock,
        sessionId: SID,
        take: () => 1,
        tracks: descriptorFixture(options.recipe ?? 'answer')
            .tracks as ChunkedTrack[],
        media,
        recorderFactory: options.noRecorder
            ? () => {
                  throw new ReferenceError('MediaRecorder is not defined');
              }
            : media.recorderFactory,
        isTypeSupported: () => true,
        bitrates: () => ({ video: 300_000, audio: 32_000 }),
        cameraAudio: (stream) => stream.getAudioTracks(),
        createAudioContext: options.audioContext ?? null,
        onSample: (level, tMs) => samples.push([level, tMs]),
        makeStream: (tracks) => {
            const made_ = media.makeStream(tracks);
            made.push(made_);

            return made_;
        },
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
            await options.holdAdd?.(record);
            added.push(record);
        },
        emit: (type, payload) => events.push([type, payload]),
        onError: (code) => errors.push(code),
        ua: 'Mozilla/5.0 (test)',
        doc,
        onStream: (stream) => streams.push(stream),
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
        streams,
        runs,
        added,
        samples,
        made,
        cameraReasons,
        stop,
    };
}

/** A node that only remembers what it was connected to. */
class FakeAudioNode {
    connections: unknown[] = [];
    fftSize = 0;

    connect(target: unknown): unknown {
        this.connections.push(target);

        return target;
    }

    disconnect(): void {
        this.connections = [];
    }

    getFloatTimeDomainData(buffer: Float32Array): void {
        buffer.fill(0.5);
    }
}

/** The AudioContext members the graph uses, recording each stream it was given. */
function fakeAudioContext(
    options: {
        state?: AudioContextState;
        /** resume() never settles, as in Firefox with no audio output device. */
        stuck?: boolean;
    } = {},
) {
    const sources: MediaStream[] = [];
    /** The stereo destination's track: what a camera run records when the mix is live. */
    const mixTrack = {
        kind: 'audio',
        id: 'mix',
    } as unknown as MediaStreamTrack;
    const context = {
        state: options.state ?? ('running' as AudioContextState),
        createAnalyser: () => new FakeAudioNode(),
        createChannelMerger: () => new FakeAudioNode(),
        createGain: () => new FakeAudioNode(),
        createMediaStreamDestination: () =>
            Object.assign(new FakeAudioNode(), {
                channelCount: 0,
                channelCountMode: 'max',
                stream: { getAudioTracks: () => [mixTrack] },
            }),
        createMediaStreamSource: (stream: MediaStream) => {
            sources.push(stream);

            return new FakeAudioNode();
        },
        resume: (): Promise<void> =>
            options.stuck === true ? new Promise(() => {}) : Promise.resolve(),
        close: async () => {
            context.state = 'closed';
        },
    };

    return { context: context as unknown as AudioContext, sources, mixTrack };
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

test('two prepares at once share one getUserMedia, so the preview and the recorders get one capture', async () => {
    const r = engineRig();
    const open = r.media.hold();
    const first = r.engine.prepare();
    const second = r.engine.prepare();
    open();
    await Promise.all([first, second]);

    assert.equal(r.media.calls(), 1);
    assert.equal(r.media.acquired.length, 1);
});

test('a release while the permission prompt is open wins: the late capture is stopped and never kept', async () => {
    const r = engineRig();
    const open = r.media.hold();
    const preparing = r.engine.prepare();
    r.engine.release();
    open();

    await assert.rejects(
        preparing,
        (error: unknown) =>
            error instanceof FittVideoError && error.code === 'invalid_state',
    );
    assert.equal(r.engine.stream, null);
    assert.equal(r.media.acquired.flat().length, 2);
    assert.ok(r.media.acquired.flat().every((track) => track.stopped));
});

test('a prepare after that release acquires again and keeps its own capture', async () => {
    const r = engineRig();
    const open = r.media.hold();
    const late = r.engine.prepare();
    r.engine.release();
    const again = r.engine.prepare();
    open();

    await assert.rejects(late);
    await again;
    assert.equal(r.media.calls(), 2);
    assert.ok(r.media.acquired[0].every((track) => track.stopped));
    assert.ok(r.media.acquired[1].every((track) => !track.stopped));
    assert.notEqual(r.engine.stream, null);
});

test('a backgrounded tab ends the run and a new one starts on return', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.doc.visibilityState = 'hidden';
    r.media.videoTrack().end();
    await r.env.advance(10);
    r.doc.visibilityState = 'visible';
    r.doc.dispatchEvent(new Event('visibilitychange'));
    await r.env.advance(10);
    await r.stop();

    assert.deepEqual(r.cameraReasons(), ['backgrounded', 'stop']);
    assert.equal(r.media.calls(), 2);
    assert.deepEqual(r.errors, []);
});

test('track mute and unmute are device.track_muted hints', async () => {
    const r = engineRig();
    await r.engine.prepare();
    r.media.videoTrack().setMuted(true);
    r.media.videoTrack().setMuted(false);

    assert.deepEqual(
        r.events
            .filter(([type]) => type === 'device.track_muted')
            .map(([, payload]) => payload),
        [
            { kind: 'video', muted: true },
            { kind: 'video', muted: false },
        ],
    );
});

test('an ended track whose permission is now denied is device.permission_lost and permission_denied', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.permission.camera = 'denied';
    r.media.videoTrack().end();
    await r.env.advance(10);

    assert.deepEqual(
        r.events.find(([type]) => type === 'device.permission_lost')?.[1],
        { kind: 'camera' },
    );
    assert.ok(r.errors.includes('permission_denied'));
});

test('a recorder error mid-take ends that run and starts a new one on the same take and stream', async () => {
    const r = engineRig({ chunks: true });
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.media.recorders[0].dispatchEvent(new Event('error'));
    await r.env.advance(10);
    await r.stop();
    const cameraRuns = [...r.runs.values()].filter(
        (run) => run.track === 'camera',
    );

    assert.deepEqual(r.cameraReasons(), ['recorder_error', 'stop']);
    assert.deepEqual(r.errors, ['recorder_error', null]);
    assert.equal(new Set(cameraRuns.map((run) => run.run_id)).size, 2);
    assert.deepEqual(
        r.added
            .filter((s) => s.run_id === cameraRuns[1].run_id)
            .map((s) => s.seq)[0],
        0,
    );
    assert.equal(r.media.calls(), 1);
});

test('a change in the camera track settings is device.track_settings_changed, read on a 2 s poll', async () => {
    const r = engineRig();
    await r.engine.prepare();
    r.media.videoTrack().settings = { width: 320, height: 240, frameRate: 15 };
    await r.env.advance(4000);

    assert.deepEqual(
        r.events
            .filter(([type]) => type === 'device.track_settings_changed')
            .map(([, payload]) => payload),
        [{ kind: 'video', width: 320, height: 240, frame_rate: 15 }],
    );
});

test('a virtual camera label is device.virtual_camera_suspected', async () => {
    const r = engineRig({ labels: ['OBS Virtual Camera'] });
    await r.engine.prepare();

    assert.deepEqual(
        r.events.find(
            ([type]) => type === 'device.virtual_camera_suspected',
        )?.[1],
        { label: 'OBS Virtual Camera' },
    );
});

test('a replacement run that fails before it cut a media segment is not replaced again, and the error stays', async () => {
    const r = engineRig({ chunks: true });
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.media.recorders[0].dispatchEvent(new Event('error'));
    await r.env.advance(10);
    r.media.recorders[2].dispatchEvent(new Event('error'));
    await r.env.advance(10);
    await r.stop();

    assert.deepEqual(r.cameraReasons(), ['recorder_error', 'recorder_error']);
    assert.deepEqual(r.errors, ['recorder_error', null, 'recorder_error']);
    assert.equal(r.media.recorders.length, 3);
});

test('stopTake waits for a run the recorder failed just before it, so its last segments and its ended record are stored', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    const r = engineRig({
        chunks: true,
        holdAdd: (record) =>
            record.track === 'camera' && record.run_index === 0
                ? gate
                : undefined,
    });
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.media.recorders[0].dispatchEvent(new Event('error'));
    let settled = false;
    const stopping = r.engine.stopTake().then(() => {
        settled = true;

        return {
            reasons: r.cameraReasons(),
            failedSegments: r.added.filter(
                (s) => s.track === 'camera' && s.run_index === 0,
            ).length,
        };
    });
    const audioStopped = (): boolean =>
        [...r.runs.values()].some(
            (run) => run.track === 'audio' && run.ended_reason === 'stop',
        );

    for (let turn = 0; turn < 100 && !audioStopped(); turn++) {
        await r.env.advance(10);
    }

    await settle();
    assert.ok(audioStopped());
    assert.equal(settled, false);
    assert.ok(r.media.acquired[0].some((track) => !track.stopped));

    open();
    const seen = await stopping;

    assert.deepEqual(seen.reasons, ['recorder_error']);
    assert.ok(seen.failedSegments > 0);
    assert.equal(r.media.recorders.length, 2);
    assert.ok(r.media.acquired[0].every((track) => track.stopped));
});

test('a replacement run that fails before its start event leaves the error set', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.media.recorders[0].dispatchEvent(new Event('error'));
    await settle();
    assert.equal(r.media.recorders.length, 3);
    r.media.recorders[2].dispatchEvent(new Event('error'));
    await r.env.advance(10);
    await r.stop();

    assert.deepEqual(r.cameraReasons(), ['recorder_error', 'recorder_error']);
    assert.deepEqual(r.errors, ['recorder_error', 'recorder_error']);
});

test('a replacement run stopped by an unplug before its start event leaves device_disconnected set', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.media.recorders[0].dispatchEvent(new Event('error'));
    await settle();
    assert.equal(r.media.recorders.length, 3);
    r.media.videoTrack().end();
    await r.env.advance(10);
    await r.stop();

    assert.deepEqual(r.cameraReasons(), ['recorder_error', 'device_switch']);
    assert.deepEqual(r.errors, ['recorder_error', 'device_disconnected']);
});

test('an unplugged camera is device_disconnected, and a devicechange that brings it back starts a new run', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    r.media.videoTrack().end();
    await r.env.advance(10);
    assert.deepEqual(r.errors, ['device_disconnected']);

    r.media.dispatchEvent(new Event('devicechange'));
    await r.env.advance(10);
    await r.stop();

    assert.deepEqual(r.cameraReasons(), ['device_switch', 'stop']);
    assert.deepEqual(r.errors, ['device_disconnected', null]);
    assert.equal(r.media.calls(), 2);
    assert.ok(r.media.acquired.flat().every((track) => track.stopped));
});

test('a camera chosen mid-take ends the run as device_switch, hands the new stream on and stops the old tracks', async () => {
    const r = engineRig();
    await r.engine.prepare();
    await r.engine.startTake(0);
    await r.env.advance(10);
    const switching = r.engine.devices().select('camera', 'cam-2');
    await r.env.advance(10);
    await switching;

    assert.deepEqual(r.engine.devices().selected, { camera: 'cam-2' });
    assert.deepEqual(
        r.engine.devices().cameras.map((camera) => camera.deviceId),
        ['cam-1'],
    );
    assert.ok(r.media.acquired[0].every((track) => track.stopped));
    assert.ok(r.media.acquired[1].every((track) => !track.stopped));
    await r.stop();

    assert.deepEqual(r.cameraReasons(), ['device_switch', 'stop']);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(
        r.streams.map((stream) => stream?.getTracks()[0] ?? null),
        [r.media.acquired[0][0], r.media.acquired[1][0], null],
    );
});

test('a release while the permission of an ended track is read reports nothing afterwards', async () => {
    const r = engineRig();
    await r.engine.prepare();
    r.media.videoTrack().end();
    r.engine.release();
    await r.env.advance(10);

    assert.deepEqual(r.errors, []);
    assert.equal(r.engine.stream, null);
    assert.equal(
        r.events.filter(([type]) => type === 'device.permission_lost').length,
        0,
    );
});

test('the audio graph is built at prepare, follows a camera chosen mid-take, and closes at stopTake', async () => {
    const audio = fakeAudioContext();
    const r = engineRig({ audioContext: () => audio.context });
    await r.engine.prepare();
    const graph = r.engine.audio();

    assert.ok(graph !== null);
    await r.engine.startTake(0);
    await r.env.advance(250);
    assert.ok(r.samples.length >= 2);
    assert.ok(r.samples.every(([level]) => level === 0.5));

    const switching = r.engine.devices().select('camera', 'cam-2');
    await r.env.advance(10);
    await switching;
    const microphones = r.media.acquired.map((tracks) =>
        tracks.find((track) => track.kind === 'audio'),
    );

    // The meter and the camera run's audio follow the new capture; the old microphone is stopped.
    assert.deepEqual(
        audio.sources.map((stream) => stream.getAudioTracks()[0]),
        microphones,
    );
    assert.deepEqual(graph.cameraAudio(), [microphones[1]]);
    await r.stop();

    assert.equal(r.engine.audio(), null);
    assert.equal(audio.context.state, 'closed');
});

test('without createAudioContext there is no graph and the camera run records the microphone as is', async () => {
    const r = engineRig();
    await r.engine.prepare();

    assert.equal(r.engine.audio(), null);
    await r.engine.startTake(0);
    await r.env.advance(250);
    await r.stop();

    assert.deepEqual(r.samples, []);
    assert.deepEqual(r.cameraReasons(), ['stop']);
});

test('a stereo camera run records the interviewer mix while the audio context runs', async () => {
    const audio = fakeAudioContext();
    const r = engineRig({
        recipe: 'conversation',
        audioContext: () => audio.context,
    });
    await r.engine.startTake(0);
    await r.stop();

    assert.deepEqual(r.made[0].getAudioTracks(), [audio.mixTrack]);
    assert.equal(
        r.events.some(([type]) => type === 'recorder.mix_unavailable'),
        false,
    );
});

test('a stereo take whose audio context never resumes records the microphone as is and says so once', async () => {
    const audio = fakeAudioContext({ state: 'suspended', stuck: true });
    const r = engineRig({
        recipe: 'conversation',
        audioContext: () => audio.context,
    });
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
        const starting = r.engine.startTake(0);
        // resume() waits 1000 ms at most, then the take starts anyway.
        await r.env.advance(1000);
        await starting;
        const microphone = r.media.acquired[0].find(
            (track) => track.kind === 'audio',
        );

        // The mix of a suspended context is silence on both channels: the candidate's voice is kept instead.
        assert.deepEqual(r.made[0].getAudioTracks(), [microphone]);
        const restarting = r.engine.restartRuns('device_switch');
        await r.env.advance(10);
        await restarting;
        assert.deepEqual(r.made[1].getAudioTracks(), [microphone]);
        await r.stop();
    } finally {
        console.warn = warn;
    }

    assert.deepEqual(
        r.events.filter(([type]) => type === 'recorder.mix_unavailable'),
        [['recorder.mix_unavailable', { context_state: 'suspended' }]],
    );
    assert.equal(warnings.length, 1);
});
