import type { Clock } from '../core/clock.ts';
import type { ChunkedTrack } from '../core/descriptor.ts';
import type { Environment } from '../core/env.ts';
import { FittVideoError, type ErrorCode } from '../core/errors.ts';
import type { TakeEngine } from '../core/lifecycle.ts';
import type {
    RunEndedReason,
    RunRecord,
    SegmentRecord,
} from '../core/store.ts';
import { createAudioGraph, type AudioGraph } from './audio.ts';
import {
    acquire,
    permissionState,
    type MediaDevicesLike,
    type Selection,
} from './capture.ts';
import { createDeviceList, type DevicesView } from './devices.ts';
import { chooseMime } from './mime.ts';
import { createRun, type RecorderFactory, type Run } from './run.ts';

export interface RecorderEngine extends TakeEngine {
    prepare(): Promise<void>;
    readonly stream: MediaStream | null;
    /** Stops every track it acquired and closes the audio graph. stopTake() calls it too. */
    release(): void;
    /** The graph built by prepare(); null before it, after release(), and without createAudioContext. */
    audio(): AudioGraph | null;
    devices(): DevicesView;
    /** End every open run with this reason and start new ones on the same take (clock jump, device change). */
    restartRuns(reason: RunEndedReason): Promise<void>;
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
    /** The camera track's audio when there is no audio graph: the microphone as is. */
    cameraAudio(stream: MediaStream): MediaStreamTrack[];
    /** `() => new AudioContext()` in the browser; absent or null means no graph (Node tests). */
    createAudioContext?: (() => AudioContext) | null;
    /** Every microphone sample of the graph, for the session's silence detector (Task 15). */
    onSample?(level: number, tMs: number): void;
    /** `(tracks) => new MediaStream(tracks)` in the browser; the audio run gets its own stream. */
    makeStream(tracks: MediaStreamTrack[]): MediaStream;
    /** navigator.permissions, for device.permission_granted; undefined where it is missing. */
    permissions: Permissions | undefined;
    nextRunIndex(track: ChunkedTrack['track']): number;
    /**
     * `nonKeyframeStart` is true for a media segment cut past max_ms at a non-keyframe Cluster;
     * the review copy reads it, nothing stores it (Plan 9).
     */
    add(record: SegmentRecord, nonKeyframeStart?: boolean): Promise<unknown>;
    putRun(record: RunRecord): Promise<void>;
    emit(type: string, payload: Record<string, unknown>): void;
    /** null clears it (a device came back). */
    onError(code: ErrorCode | null): void;
    ua: string;
    /** The document, for visibilityState and visibilitychange. */
    doc: { visibilityState: string } & EventTarget;
    /** The new stream after every acquire (prepare, select, a backgrounded return, a device coming back), and null after release(); the session's previews follow it. */
    onStream?(stream: MediaStream | null): void;
}

/** The camera track's settings are read this often while a stream is held. */
const SETTINGS_POLL_MS = 2000;

/**
 * Why the runs are not recording although a take is open: the tab was
 * hidden (iOS stops capture there), a device went away, or a permission
 * was revoked.
 */
type Suspended = 'backgrounded' | 'disconnected' | 'permission_lost' | null;

interface VideoSettings {
    width: number | null;
    height: number | null;
    frame_rate: number | null;
}

function kindOf(track: MediaStreamTrack): 'camera' | 'microphone' {
    return track.kind === 'video' ? 'camera' : 'microphone';
}

/**
 * One capture for the whole session and one MediaRecorder per track per run
 * (author's call 12). prepare() acquires the stream once; startTake() starts
 * a run for the camera (video plus cameraAudio()) and one for the audio track
 * (the microphone alone, in its own stream); stopTake() stops every run and
 * releases capture, so the camera light goes off after stop() (spec 6.3).
 * The session acquires again with prepare() after a reset (spec 6.5).
 *
 * Within a take, a run ends and a new one starts on the same take when the
 * candidate picks another device, the recorder fails, the tab comes back
 * from the background, or a device that went away comes back. Every such
 * change goes through one queue, so two of them never interleave.
 */
export function createRecorderEngine(deps: RecorderEngineDeps): RecorderEngine {
    const selection: Selection = {};
    let stream: MediaStream | null = null;
    let acquired: MediaStream[] = [];
    let runs: Run[] = [];
    /** The stops of runs the recorder failed, which left `runs` at the error; stopRuns() waits for them. */
    const failing = new Set<Promise<RunRecord>>();
    /** The getUserMedia in flight, which a second prepare() joins. */
    let pending: Promise<void> | null = null;
    /** Counts releases, so a capture that lands after one is stopped, never kept. */
    let generation = 0;
    /** A take is open: from startTake() until stopTake(). */
    let recording = false;
    let currentTake = 0;
    /** Whether the take records a camera track at all (Plan 10: audio only has none). */
    const usesCamera = deps.tracks.some((track) => track.track === 'camera');
    let suspended: Suspended = null;
    /** Device changes, restarts and the stop, one at a time. */
    let ops: Promise<void> = Promise.resolve();
    /** Removes the listeners on the current stream's tracks. */
    let unwatchTracks: () => void = () => {};
    let watchingPage = false;
    let settingsTimer: number | null = null;
    let lastSettings: VideoSettings | null = null;
    /** The meter and the mix, built at the first acquire of a capture and closed at release(). */
    let graph: AudioGraph | null = null;
    /** Whether this take already reported a stereo mix it could not record. */
    let mixUnavailable = false;
    /** Whether a camera choice in a session with no camera was already warned about. */
    let cameraChoiceWarned = false;
    /**
     * The track that records the D20 mix: a stereo camera track, else a stereo
     * audio track that is the only track (audio-only conversation, Plan 10).
     */
    const mixTrack =
        deps.tracks.find(
            (track) =>
                track.capture.audio.channels === 2 &&
                (track.track === 'camera' ||
                    (track.track === 'audio' && !usesCamera)),
        )?.track ?? null;
    const stereo = mixTrack !== null;
    const permissions: Record<
        'camera' | 'microphone',
        PermissionState | 'unknown'
    > = { camera: 'unknown', microphone: 'unknown' };
    const deviceList = createDeviceList({
        media: deps.media,
        emit: (type, payload) => deps.emit(type, payload),
    });

    /** Runs `step` after every queued step; a failed step never blocks the next. */
    function serial<T>(step: () => Promise<T>): Promise<T> {
        const result = ops.then(step);
        ops = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    }

    /** For listeners: queue the step and keep its failure from becoming an unhandled rejection. */
    function background(step: () => Promise<void>): void {
        void serial(step).catch(() => undefined);
    }

    const hidden = (): boolean => deps.doc.visibilityState === 'hidden';

    function stopAll(held: MediaStream): void {
        for (const track of held.getTracks()) {
            track.stop();
        }
    }

    function holds(track: MediaStreamTrack): boolean {
        return stream?.getTracks().includes(track) ?? false;
    }

    function onTrackMute(track: MediaStreamTrack, muted: boolean): void {
        if (!holds(track)) {
            return;
        }

        // A hint only: mute does not reliably mean another app took the device (spec 6.6).
        deps.emit('device.track_muted', { kind: track.kind, muted });

        if (muted && hidden() && recording && suspended === null) {
            backgrounded();
        }
    }

    function onTrackEnded(track: MediaStreamTrack): void {
        if (!holds(track) || suspended !== null) {
            return;
        }

        if (hidden() && recording) {
            backgrounded();

            return;
        }

        const kind = kindOf(track);
        // Claimed now, so the other track ending too is not handled twice.
        suspended = 'disconnected';
        const asked = generation;
        background(async () => {
            const state = await permissionState(deps.permissions, kind);

            if (asked !== generation) {
                // Released while the permission was read: nothing is held any more.
                return;
            }

            if (state === 'denied') {
                permissions[kind] = 'denied';
                suspended = 'permission_lost';
                const stopping = stopRuns('device_switch');
                permissionLost(kind);
                await stopping;

                return;
            }

            const stopping = stopRuns('device_switch');
            deps.onError('device_disconnected');
            await stopping;
        });
    }

    /** spec 6.3: a revoked permission is device.permission_lost and permission_denied. */
    function permissionLost(kind: 'camera' | 'microphone'): void {
        deps.emit('device.permission_lost', { kind });
        deps.onError('permission_denied');
    }

    /** spec 6.9: iOS stops capture in a backgrounded tab. The runs end; new ones start on return. */
    function backgrounded(): void {
        suspended = 'backgrounded';
        background(() => stopRuns('backgrounded'));
    }

    function watchTracks(held: MediaStream): void {
        const removers: (() => void)[] = [];

        for (const track of held.getTracks()) {
            const ended = (): void => onTrackEnded(track);
            const mute = (): void => onTrackMute(track, true);
            const unmute = (): void => onTrackMute(track, false);
            track.addEventListener('ended', ended);
            track.addEventListener('mute', mute);
            track.addEventListener('unmute', unmute);
            removers.push(() => {
                track.removeEventListener('ended', ended);
                track.removeEventListener('mute', mute);
                track.removeEventListener('unmute', unmute);
            });
        }

        unwatchTracks = () => {
            for (const remove of removers) {
                remove();
            }
        };
    }

    function readSettings(): VideoSettings | null {
        const video = stream?.getVideoTracks()[0];

        if (video === undefined || typeof video.getSettings !== 'function') {
            return null;
        }

        const settings = video.getSettings();

        return {
            width: settings.width ?? null,
            height: settings.height ?? null,
            frame_rate: settings.frameRate ?? null,
        };
    }

    function pollSettings(): void {
        settingsTimer = deps.env.timers.setTimeout(() => {
            settingsTimer = null;
            const read = readSettings();

            if (
                read !== null &&
                lastSettings !== null &&
                (read.width !== lastSettings.width ||
                    read.height !== lastSettings.height ||
                    read.frame_rate !== lastSettings.frame_rate)
            ) {
                deps.emit('device.track_settings_changed', {
                    kind: 'video',
                    ...read,
                });
            }

            lastSettings = read ?? lastSettings;
            pollSettings();
        }, SETTINGS_POLL_MS);
    }

    function stopPolling(): void {
        if (settingsTimer !== null) {
            deps.env.timers.clearTimeout(settingsTimer);
            settingsTimer = null;
        }
    }

    function onDeviceChange(): void {
        background(async () => {
            await deviceList.refresh();
            await recover();
        });
    }

    function onVisibility(): void {
        if (hidden()) {
            return;
        }

        background(async () => {
            // Chrome holds devicechange back while hidden (spec 6.6), so list again here.
            await deviceList.refresh();
            const lost = await recheckPermissions();

            if (suspended === 'backgrounded') {
                if (lost) {
                    suspended = 'permission_lost';
                    await stopRuns('device_switch');

                    return;
                }

                await returnFromBackground();

                return;
            }

            await recover();
        });
    }

    /** A permission that was granted and is now denied is device.permission_lost. True when one was. */
    async function recheckPermissions(): Promise<boolean> {
        const [camera, microphone] = await Promise.all([
            cameraPermission(),
            permissionState(deps.permissions, 'microphone'),
        ]);
        let lost = false;

        for (const [kind, state] of [
            ['camera', camera],
            ['microphone', microphone],
        ] as const) {
            if (kind === 'camera' && !usesCamera) {
                // A take with no camera never rechecks it: an old denial elsewhere is not a loss here.
                continue;
            }

            if (permissions[kind] === 'granted' && state === 'denied') {
                lost = true;
                permissionLost(kind);
            }

            permissions[kind] = state;
        }

        return lost;
    }

    function watchPage(): void {
        if (watchingPage) {
            return;
        }

        watchingPage = true;
        deps.media.addEventListener('devicechange', onDeviceChange);
        deps.doc.addEventListener('visibilitychange', onVisibility);
    }

    function unwatchPage(): void {
        if (!watchingPage) {
            return;
        }

        watchingPage = false;
        deps.media.removeEventListener('devicechange', onDeviceChange);
        deps.doc.removeEventListener('visibilitychange', onVisibility);
    }

    /** One getUserMedia with the current choice; a release while it is open wins. */
    async function capture(): Promise<MediaStream> {
        const asked = generation;
        const next = await acquire(deps.media, deps.tracks, selection);

        if (asked !== generation) {
            // Released while the prompt was open: a release always wins.
            stopAll(next);

            throw new FittVideoError('invalid_state', { reason: 'released' });
        }

        return next;
    }

    /** Makes `next` the stream, tells the previews, then stops the stream it replaces (if any). */
    function adopt(next: MediaStream): MediaStream | null {
        const previous = stream;
        unwatchTracks();
        stream = next;
        acquired.push(next);
        watchTracks(next);
        watchPage();
        follow(next);
        deps.onStream?.(next);

        return previous;
    }

    /**
     * The graph listens to the stream just adopted: built on the first
     * acquire after a release, pointed at the new microphone after a device
     * switch or a return from the background.
     */
    function follow(next: MediaStream): void {
        if (graph !== null) {
            graph.setMicrophone(next);

            return;
        }

        const createContext = deps.createAudioContext;

        if (createContext === undefined || createContext === null) {
            return;
        }

        try {
            graph = createAudioGraph({
                env: deps.env,
                clock: deps.clock,
                microphone: next,
                stereo,
                createContext,
                doc: deps.doc,
                onSample: (level, tMs) => deps.onSample?.(level, tMs),
            });
        } catch (error) {
            // No meter is better than no recording: the camera run then records the microphone as is.
            graph = null;
            console.warn(
                'Fitt Video: the audio graph could not be built.',
                error,
            );
        }
    }

    function closeGraph(): void {
        const closing = graph;
        graph = null;

        if (closing !== null) {
            void closing.close().catch(() => undefined);
        }
    }

    function retire(previous: MediaStream | null): void {
        if (previous === null) {
            return;
        }

        stopAll(previous);
        acquired = acquired.filter((held) => held !== previous);
    }

    /** The camera permission, or `unknown` without a query when the take records no camera. */
    function cameraPermission(): Promise<PermissionState | 'unknown'> {
        return usesCamera
            ? permissionState(deps.permissions, 'camera')
            : Promise.resolve<PermissionState | 'unknown'>('unknown');
    }

    async function acquireOnce(): Promise<void> {
        const asked = generation;
        const next = await capture();
        adopt(next);

        const [camera, microphone] = await Promise.all([
            cameraPermission(),
            permissionState(deps.permissions, 'microphone'),
        ]);
        permissions.camera = camera;
        permissions.microphone = microphone;
        deps.emit('device.permission_granted', { camera, microphone });
        await deviceList.refresh();

        if (asked === generation && stream === next) {
            lastSettings = readSettings();
            stopPolling();
            pollSettings();
        }
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
        const held = stream;

        for (const each of acquired) {
            stopAll(each);
        }

        unwatchTracks();
        unwatchTracks = () => {};
        unwatchPage();
        stopPolling();
        acquired = [];
        stream = null;
        suspended = null;
        closeGraph();

        if (held !== null) {
            deps.onStream?.(null);
        }
    }

    /** The stream a track's run records: video plus the camera audio, or the microphone alone. */
    function streamFor(track: ChunkedTrack, source: MediaStream): MediaStream {
        if (track.track === 'audio') {
            return deps.makeStream(
                (mixTrack === 'audio'
                    ? cameraAudioOf(source)
                    : source.getAudioTracks()
                ).slice(0, 1),
            );
        }

        return deps.makeStream([
            ...source.getVideoTracks(),
            ...cameraAudioOf(source),
        ]);
    }

    /**
     * The graph's camera audio, while its context runs. A stereo mix whose
     * context is not running (resume() refused, or a browser with no audio
     * output device) carries silence on both channels and passes no level
     * to the dead microphone detector, so the candidate's voice would be
     * lost without a word. Such a run records the microphone as is, and the
     * take reports the missing D20 mix once. It also serves an audio-only
     * conversation's audio track (Plan 10).
     */
    function cameraAudioOf(source: MediaStream): MediaStreamTrack[] {
        if (graph === null) {
            return deps.cameraAudio(source);
        }

        const state = graph.context.state;

        if (!stereo || state === 'running') {
            return graph.cameraAudio();
        }

        if (!mixUnavailable) {
            mixUnavailable = true;
            console.warn(
                `Fitt Video: the audio context is ${state}, so this ${mixTrack} run records the microphone without the interviewer mix.`,
            );
            deps.emit('recorder.mix_unavailable', { context_state: state });
        }

        return deps.cameraAudio(source);
    }

    /**
     * The recorder of `run` fired `error` while it was recording. The run
     * stops itself with recorder_error (run.ts); the replacement starts at
     * once on the same take and stream, without waiting for the failed
     * run's last data to be stored, so the gap is as short as it can be.
     * The failed run's stop is kept in `failing`, so stopTake() still waits
     * for its last segments and its ended record before it releases capture.
     */
    function onRunError(
        run: Run,
        track: ChunkedTrack,
        replacing: boolean,
    ): void {
        if (!runs.includes(run)) {
            // Already stopping (a stop, a restart): the run ignores the error too.
            return;
        }

        runs = runs.filter((other) => other !== run);
        // The same promise the run's own error listener gets from stop().
        const stopping = run.stop('recorder_error');
        failing.add(stopping);
        void stopping
            .finally(() => failing.delete(stopping))
            .catch(() => undefined);
        deps.onError('recorder_error');

        // Loop guard: a replacement that fails before it cut a media segment is not replaced again.
        if (replacing && run.mediaSegmentsCut() === 0) {
            return;
        }

        background(async () => {
            if (!recording || suspended !== null || stream === null) {
                return;
            }

            const next = runFor(track, stream, true);
            await next.start();
            runs.push(next);
        });
    }

    /**
     * A run for one track. A run that replaces one the recorder failed
     * (`replacing`) clears the error at its recorder's own `start` event
     * while it is still an open run, and is not replaced again if it fails
     * before it cut a media segment.
     */
    function runFor(
        track: ChunkedTrack,
        source: MediaStream,
        replacing: boolean,
    ): Run {
        const run: Run = createRun({
            env: deps.env,
            clock: deps.clock,
            sessionId: deps.sessionId,
            take: currentTake,
            runIndex: deps.nextRunIndex(track.track),
            track,
            stream: streamFor(track, source),
            mimeType: chooseMime(
                track.track === 'audio' ? 'audio' : 'camera',
                (type) => deps.isTypeSupported(type),
            ),
            bitrates: deps.bitrates(track),
            recorderFactory: (recorderStream, options) => {
                const made = deps.recorderFactory(recorderStream, options);
                // Added before the run's own listener, so the run is still recording when it runs.
                made.addEventListener('error', () =>
                    onRunError(run, track, replacing),
                );

                if (replacing) {
                    // Not the run's recorder.started, which finish() also emits for a recorder that never started.
                    made.addEventListener(
                        'start',
                        () => {
                            if (runs.includes(run)) {
                                deps.onError(null);
                            }
                        },
                        { once: true },
                    );
                }

                return made;
            },
            add: (record, nonKeyframeStart) =>
                deps.add(record, nonKeyframeStart),
            putRun: (record) => deps.putRun(record),
            emit: (type, payload) => deps.emit(type, payload),
            // onRunError() has already handed the track to a replacement.
            onRecorderError: () => undefined,
            ua: deps.ua,
        });

        return run;
    }

    /**
     * Stops every open run with this reason and waits for the runs the
     * recorder failed to finish stopping; the first failure is thrown after
     * all have stopped.
     */
    async function stopRuns(reason: RunEndedReason): Promise<void> {
        const stopping = runs;
        runs = [];
        const results = await Promise.allSettled([
            ...stopping.map((run) => run.stop(reason)),
            ...failing,
        ]);
        const failed = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === 'rejected',
        );

        if (failed !== undefined) {
            throw failed.reason;
        }
    }

    /** Starts a run for every recorded track on the current stream and take. */
    async function startRuns(): Promise<void> {
        const source = stream;

        if (source === null) {
            // Released while the permission states were read.
            throw new FittVideoError('invalid_state', { reason: 'released' });
        }

        // A screen track needs its own capture, which no recipe asks for yet.
        const recorded = deps.tracks.filter(
            (track) => track.track === 'camera' || track.track === 'audio',
        );

        for (const track of recorded) {
            const run = runFor(track, source, false);

            try {
                await run.start();
            } catch (error) {
                // No MediaRecorder, or one that refuses this stream or type (owner decision 2).
                await stopRuns('recorder_error').catch(() => undefined);
                deps.onError('recorder_unsupported');

                throw new FittVideoError('recorder_unsupported', {
                    track: track.track,
                    name:
                        typeof (error as { name?: unknown })?.name === 'string'
                            ? (error as { name: string }).name
                            : null,
                });
            }

            runs.push(run);
        }
    }

    async function restart(reason: RunEndedReason): Promise<void> {
        await stopRuns(reason);

        if (recording && suspended === null && stream !== null) {
            await startRuns();
        }
    }

    /** On return to visible after the runs ended as backgrounded: capture again and go on. */
    async function returnFromBackground(): Promise<void> {
        const asked = generation;
        let next: MediaStream;

        try {
            next = await capture();
        } catch {
            if (asked !== generation) {
                // Released while the capture was open: a release always wins.
                return;
            }

            suspended = 'disconnected';
            deps.onError('device_disconnected');

            return;
        }

        retire(adopt(next));
        suspended = null;

        if (recording) {
            await startRuns();
        }
    }

    /** After a device change: when a device went away, try to capture again, and go on if it works. */
    async function recover(): Promise<void> {
        if (suspended !== 'disconnected' || stream === null) {
            return;
        }

        let next: MediaStream;

        try {
            next = await capture();
        } catch {
            // Still no usable device: wait for the next devicechange.
            return;
        }

        retire(adopt(next));
        suspended = null;

        if (recording) {
            await startRuns();
        }

        deps.onError(null);
    }

    async function select(
        kind: 'camera' | 'microphone',
        deviceId: string,
    ): Promise<void> {
        if (kind === 'camera' && !usesCamera) {
            if (!cameraChoiceWarned) {
                cameraChoiceWarned = true;
                console.warn(
                    'Fitt Video: this session records no camera, so a camera choice is ignored.',
                );
            }

            return;
        }

        selection[kind] = deviceId;

        if (stream === null) {
            // The next acquire uses the choice.
            return;
        }

        const next = await capture();
        const previous = adopt(next);

        if (suspended === 'disconnected') {
            suspended = null;

            if (recording) {
                await startRuns();
            }

            retire(previous);
            deps.onError(null);

            return;
        }

        if (recording && suspended === null) {
            await restart('device_switch');
        }

        retire(previous);
    }

    return {
        get stream(): MediaStream | null {
            return stream;
        },

        prepare,

        async startTake(): Promise<void> {
            await prepare();

            if (stream === null) {
                // Released while the permission states were read.
                throw new FittVideoError('invalid_state', {
                    reason: 'released',
                });
            }

            // The start gesture lets a suspended context run; never more than a short wait.
            await graph?.resume();

            if (stream === null) {
                throw new FittVideoError('invalid_state', {
                    reason: 'released',
                });
            }

            currentTake = deps.take();
            recording = true;
            mixUnavailable = false;

            try {
                // A device that went away before the take: its runs start when it comes back.
                await serial(async () => {
                    if (suspended === null) {
                        await startRuns();
                    }
                });
            } catch (error) {
                recording = false;

                throw error;
            }
        },

        async stopTake(): Promise<void> {
            recording = false;

            try {
                await serial(() => stopRuns('stop'));
            } finally {
                release();
            }
        },

        release,

        audio(): AudioGraph | null {
            return graph;
        },

        devices(): DevicesView {
            return {
                get cameras(): MediaDeviceInfo[] {
                    return usesCamera ? deviceList.cameras : [];
                },
                get microphones(): MediaDeviceInfo[] {
                    return deviceList.microphones;
                },
                get selected(): Selection {
                    return { ...selection };
                },
                select: (kind, deviceId) =>
                    serial(() => select(kind, deviceId)),
            };
        },

        restartRuns(reason: RunEndedReason): Promise<void> {
            return serial(() => restart(reason));
        },
    };
}
