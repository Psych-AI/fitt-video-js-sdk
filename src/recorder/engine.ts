import type { Clock } from '../core/clock.ts';
import type { ChunkedTrack } from '../core/descriptor.ts';
import type { Environment } from '../core/env.ts';
import { FittVideoError, type ErrorCode } from '../core/errors.ts';
import type { TakeEngine } from '../core/lifecycle.ts';
import type { RunRecord, SegmentRecord } from '../core/store.ts';
import {
    acquire,
    permissionState,
    type MediaDevicesLike,
    type Selection,
} from './capture.ts';
import { chooseMime } from './mime.ts';
import { createRun, type RecorderFactory, type Run } from './run.ts';

export interface RecorderEngine extends TakeEngine {
    prepare(): Promise<void>;
    readonly stream: MediaStream | null;
    /** Stops every track it acquired (Task 13 adds the audio graph). stopTake() calls it too. */
    release(): void;
}

export interface RecorderEngineDeps {
    env: Environment;
    clock: Clock;
    sessionId: string;
    take(): number;
    tracks: ChunkedTrack[];
    media: MediaDevicesLike & EventTarget;
    recorderFactory: RecorderFactory;
    isTypeSupported(type: string): boolean;
    bitrates(track: ChunkedTrack): { video?: number; audio: number };
    /** The camera track's audio: the microphone, or the mix (Task 13). */
    cameraAudio(stream: MediaStream): MediaStreamTrack[];
    /** `(tracks) => new MediaStream(tracks)` in the browser; the audio run gets its own stream. */
    makeStream(tracks: MediaStreamTrack[]): MediaStream;
    /** navigator.permissions, for device.permission_granted; undefined where it is missing. */
    permissions: Permissions | undefined;
    nextRunIndex(track: ChunkedTrack['track']): number;
    add(record: SegmentRecord): Promise<unknown>;
    putRun(record: RunRecord): Promise<void>;
    emit(type: string, payload: Record<string, unknown>): void;
    /** null clears it (a device came back). */
    onError(code: ErrorCode | null): void;
    ua: string;
}

/**
 * One capture for the whole session and one MediaRecorder per track per run
 * (author's call 12). prepare() acquires the stream once; startTake() starts
 * a run for the camera (video plus cameraAudio()) and one for the audio track
 * (the microphone alone, in its own stream); stopTake() stops every run and
 * releases capture, so the camera light goes off after stop() (spec 6.3).
 * The session acquires again with prepare() after a reset (spec 6.5).
 */
export function createRecorderEngine(deps: RecorderEngineDeps): RecorderEngine {
    const selection: Selection = {};
    let stream: MediaStream | null = null;
    let acquired: MediaStream[] = [];
    let runs: Run[] = [];
    /** The getUserMedia in flight, which a second prepare() joins. */
    let pending: Promise<void> | null = null;
    /** Counts releases, so a capture that lands after one is stopped, never kept. */
    let generation = 0;

    function stopAll(held: MediaStream): void {
        for (const track of held.getTracks()) {
            track.stop();
        }
    }

    async function acquireOnce(): Promise<void> {
        const asked = generation;
        const next = await acquire(deps.media, deps.tracks, selection);

        if (asked !== generation) {
            // Released while the prompt was open: a release always wins.
            stopAll(next);

            throw new FittVideoError('invalid_state', { reason: 'released' });
        }

        stream = next;
        acquired.push(next);

        const [camera, microphone] = await Promise.all([
            permissionState(deps.permissions, 'camera'),
            permissionState(deps.permissions, 'microphone'),
        ]);
        deps.emit('device.permission_granted', { camera, microphone });
    }

    function prepare(): Promise<void> {
        if (stream !== null) {
            return Promise.resolve();
        }

        if (pending === null) {
            const mine = acquireOnce().finally(() => {
                if (pending === mine) {
                    pending = null;
                }
            });
            pending = mine;
        }

        return pending;
    }

    function release(): void {
        generation++;
        pending = null;

        for (const held of acquired) {
            stopAll(held);
        }

        acquired = [];
        stream = null;
    }

    /** The stream a track's run records: video plus the camera audio, or the microphone alone. */
    function streamFor(track: ChunkedTrack, source: MediaStream): MediaStream {
        if (track.track === 'audio') {
            return deps.makeStream(source.getAudioTracks().slice(0, 1));
        }

        return deps.makeStream([
            ...source.getVideoTracks(),
            ...deps.cameraAudio(source),
        ]);
    }

    function runFor(
        track: ChunkedTrack,
        source: MediaStream,
        take: number,
    ): Run {
        const run: Run = createRun({
            env: deps.env,
            clock: deps.clock,
            sessionId: deps.sessionId,
            take,
            runIndex: deps.nextRunIndex(track.track),
            track,
            stream: streamFor(track, source),
            mimeType: chooseMime(
                track.track === 'audio' ? 'audio' : 'camera',
                (type) => deps.isTypeSupported(type),
            ),
            bitrates: deps.bitrates(track),
            recorderFactory: deps.recorderFactory,
            add: (record) => deps.add(record),
            putRun: (record) => deps.putRun(record),
            emit: (type, payload) => deps.emit(type, payload),
            onRecorderError: () => {
                // Task 12b starts the next run on the same take and stream.
                runs = runs.filter((other) => other !== run);
                deps.onError('recorder_error');
            },
            ua: deps.ua,
        });

        return run;
    }

    /** Stops every open run with this reason; the first failure is thrown after all have stopped. */
    async function stopRuns(reason: 'stop' | 'recorder_error'): Promise<void> {
        const stopping = runs;
        runs = [];
        const results = await Promise.allSettled(
            stopping.map((run) => run.stop(reason)),
        );
        const failed = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === 'rejected',
        );

        if (failed !== undefined) {
            throw failed.reason;
        }
    }

    return {
        get stream(): MediaStream | null {
            return stream;
        },

        prepare,

        async startTake(): Promise<void> {
            await prepare();
            const source = stream;

            if (source === null) {
                // Released while the permission states were read.
                throw new FittVideoError('invalid_state', {
                    reason: 'released',
                });
            }
            const take = deps.take();
            // A screen track needs its own capture, which no recipe asks for yet.
            const recorded = deps.tracks.filter(
                (track) => track.track === 'camera' || track.track === 'audio',
            );

            for (const track of recorded) {
                const run = runFor(track, source, take);

                try {
                    await run.start();
                } catch (error) {
                    // No MediaRecorder, or one that refuses this stream or type (owner decision 2).
                    await stopRuns('recorder_error').catch(() => undefined);
                    deps.onError('recorder_unsupported');

                    throw new FittVideoError('recorder_unsupported', {
                        track: track.track,
                        name:
                            typeof (error as { name?: unknown })?.name ===
                            'string'
                                ? (error as { name: string }).name
                                : null,
                    });
                }

                runs.push(run);
            }
        },

        async stopTake(): Promise<void> {
            try {
                await stopRuns('stop');
            } finally {
                release();
            }
        },

        release,
    };
}
