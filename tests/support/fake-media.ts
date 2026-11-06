import type { RecorderFactory, RecorderLike } from '../../src/recorder/run.ts';
import type { FakeEnvironment } from './fake-env.ts';

/**
 * A capture track Node can hold. `stop()` ends it and fires nothing, as a
 * real track does. `end()` is what the browser does on an unplug, a revoked
 * permission or a backgrounded iOS tab: the track ends and fires `ended`.
 */
export class FakeTrack extends EventTarget {
    readonly kind: 'audio' | 'video';
    readonly label: string;
    readonly id: string;
    readyState: 'live' | 'ended';
    enabled: boolean;
    muted: boolean;
    stopped: boolean;
    /** What getSettings() reports besides deviceId (the label). */
    settings: MediaTrackSettings;

    constructor(kind: 'audio' | 'video', label: string) {
        super();
        this.kind = kind;
        this.label = label;
        this.id = `${kind}-${label}`;
        this.readyState = 'live';
        this.enabled = true;
        this.muted = false;
        this.stopped = false;
        this.settings = {};
    }

    stop(): void {
        this.stopped = true;
        this.readyState = 'ended';
    }

    end(): void {
        this.readyState = 'ended';
        this.dispatchEvent(new Event('ended'));
    }

    setMuted(muted: boolean): void {
        this.muted = muted;
        this.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
    }

    getSettings(): MediaTrackSettings {
        return { ...this.settings, deviceId: this.label };
    }
}

/** A plain object that answers what a run and the engine ask of a MediaStream. */
function fakeStream(tracks: FakeTrack[]): MediaStream {
    const held = [...tracks];

    return {
        getTracks: () => [...held],
        getVideoTracks: () => held.filter((track) => track.kind === 'video'),
        getAudioTracks: () => held.filter((track) => track.kind === 'audio'),
    } as unknown as MediaStream;
}

/** A recorder that replays the given chunks when it stops. */
class ReplayRecorder extends EventTarget implements RecorderLike {
    readonly mimeType: string;
    state: string;
    private readonly env: FakeEnvironment;
    private readonly chunks: Uint8Array[];

    constructor(env: FakeEnvironment, chunks: Uint8Array[], mimeType: string) {
        super();
        this.env = env;
        this.chunks = chunks;
        this.mimeType = mimeType;
        this.state = 'inactive';
    }

    start(): void {
        this.state = 'recording';
        this.env.timers.setTimeout(
            () => this.dispatchEvent(new Event('start')),
            2,
        );
    }

    stop(): void {
        this.state = 'inactive';
        this.env.timers.setTimeout(() => {
            for (const chunk of this.chunks) {
                const event = new Event('dataavailable');
                Object.defineProperty(event, 'data', {
                    value: new Blob([chunk as BlobPart]),
                });
                this.dispatchEvent(event);
            }

            this.dispatchEvent(new Event('stop'));
        }, 1);
    }
}

export interface FakeMedia extends EventTarget {
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
    enumerateDevices(): Promise<MediaDeviceInfo[]>;
    /** getUserMedia calls so far, refused ones included. */
    calls(): number;
    /** While set, getUserMedia throws a DOMException with this name. */
    refuse(name: string | null): void;
    /** The tracks of each acquisition, in order. */
    readonly acquired: FakeTrack[][];
    /** Every recorder made, in order. */
    readonly recorders: (RecorderLike & EventTarget)[];
    /** The video track of the last acquisition. */
    videoTrack(): FakeTrack;
    makeStream(tracks: MediaStreamTrack[]): MediaStream;
    recorderFactory: RecorderFactory;
}

/**
 * navigator.mediaDevices and MediaRecorder for Node: an EventTarget (so a
 * test can dispatch `devicechange`) whose getUserMedia hands out FakeTracks,
 * and a recorder factory whose recorders replay `chunks` when they stop.
 */
export function fakeMedia(
    env: FakeEnvironment,
    options: { cameraLabels?: string[]; chunks?: Uint8Array[] } = {},
): FakeMedia {
    const cameraLabels = options.cameraLabels ?? ['Integrated Camera'];
    const chunks = options.chunks ?? [];
    const target = new EventTarget();
    const acquired: FakeTrack[][] = [];
    const recorders: ReplayRecorder[] = [];
    let callCount = 0;
    let refusal: string | null = null;

    return Object.assign(target, {
        async getUserMedia(
            constraints: MediaStreamConstraints,
        ): Promise<MediaStream> {
            callCount++;

            if (refusal !== null) {
                throw new DOMException('refused', refusal);
            }

            const tracks: FakeTrack[] = [];

            if (
                constraints.video !== undefined &&
                constraints.video !== false
            ) {
                tracks.push(new FakeTrack('video', cameraLabels[0]));
            }

            if (
                constraints.audio !== undefined &&
                constraints.audio !== false
            ) {
                tracks.push(new FakeTrack('audio', 'Microphone'));
            }

            acquired.push(tracks);

            return fakeStream(tracks);
        },

        async enumerateDevices(): Promise<MediaDeviceInfo[]> {
            const cameras = cameraLabels.map((label, index) => ({
                kind: 'videoinput',
                deviceId: `cam-${index + 1}`,
                label,
                groupId: '',
            }));

            return [
                ...cameras,
                {
                    kind: 'audioinput',
                    deviceId: 'mic-1',
                    label: 'Microphone',
                    groupId: '',
                },
            ] as unknown as MediaDeviceInfo[];
        },

        calls: () => callCount,

        refuse(name: string | null): void {
            refusal = name;
        },

        acquired,
        recorders,

        videoTrack(): FakeTrack {
            const track = acquired
                .at(-1)
                ?.find((each) => each.kind === 'video');

            if (track === undefined) {
                throw new Error('No video track was acquired.');
            }

            return track;
        },

        makeStream(tracks: MediaStreamTrack[]): MediaStream {
            return fakeStream(tracks as unknown as FakeTrack[]);
        },

        recorderFactory(
            _stream: MediaStream,
            recorderOptions: MediaRecorderOptions,
        ): RecorderLike {
            const recorder = new ReplayRecorder(
                env,
                chunks,
                recorderOptions.mimeType ?? '',
            );
            recorders.push(recorder);

            return recorder;
        },
    });
}
