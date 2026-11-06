import type { Page } from '@playwright/test';

export type MediaSource = 'native' | 'synthetic';

/**
 * Gives the page a camera and a microphone. Chromium and Firefox use their own fake devices
 * (projects.ts) unless `prefer: 'synthetic'`; WebKit has no fake device switch, so it always gets
 * the synthetic stream: a canvas camera and a 220 Hz mono tone, built from the spike's recorder
 * (docs/superpowers/spikes/2026-11-stitching/recorder/record.mjs:43-78).
 *
 * Firefox has no audio device in Sail or CI, so its AudioContext stays suspended and `resume()`
 * never settles (owner decision 1). There the stream creates the context and goes on without
 * waiting, so getUserMedia never hangs; the tone then stays silent.
 */
export async function installMedia(
    page: Page,
    browserName: string,
    options: { prefer?: MediaSource } = {},
): Promise<MediaSource> {
    if (browserName !== 'webkit' && options.prefer !== 'synthetic') {
        return 'native';
    }

    await page.addInitScript(syntheticMedia, {
        waitForAudio: browserName !== 'firefox',
    });

    return 'synthetic';
}

/** Runs in the page before its own scripts. Everything it needs lives inside this function. */
function syntheticMedia({ waitForAudio }: { waitForAudio: boolean }): void {
    const realDateNow = Date.now.bind(Date);

    window.__dateOffset ??= 0;
    Date.now = () => realDateNow() + (window.__dateOffset ?? 0);

    const cameras = [
        {
            deviceId: 'fake-camera-1',
            groupId: 'fake-group-1',
            kind: 'videoinput',
            label: 'Fake camera 1',
        },
        {
            deviceId: 'fake-camera-2',
            groupId: 'fake-group-2',
            kind: 'videoinput',
            label: 'Fake camera 2',
        },
    ] as const;
    const microphones = [
        {
            deviceId: 'fake-mic-1',
            groupId: 'fake-group-1',
            kind: 'audioinput',
            label: 'Fake microphone 1',
        },
    ] as const;

    let audio: { context: AudioContext; gain: GainNode } | null = null;
    let micGain = 0.08;
    let frozen = false;

    window.__fakeCameras = cameras;
    window.__fakeMicGain = (gain: number) => {
        micGain = gain;

        if (audio !== null) {
            audio.gain.gain.value = gain;
        }
    };
    window.__fakeFreezeCamera = (isFrozen: boolean) => {
        frozen = isFrozen;
    };

    type DeviceConstraint = boolean | MediaTrackConstraints | undefined;

    /** The device a constraint names, and whether it must be exactly that one. */
    const requested = (
        constraint: DeviceConstraint,
    ): { deviceId?: string; exact: boolean } => {
        if (
            typeof constraint !== 'object' ||
            constraint.deviceId === undefined
        ) {
            return { exact: false };
        }

        const deviceId = constraint.deviceId;

        if (typeof deviceId === 'string') {
            return { deviceId, exact: false };
        }

        if (Array.isArray(deviceId)) {
            return { deviceId: deviceId[0], exact: false };
        }

        const named =
            (deviceId as ConstrainDOMStringParameters).exact ??
            (deviceId as ConstrainDOMStringParameters).ideal;
        const first = Array.isArray(named) ? named[0] : named;

        return {
            deviceId: first,
            exact:
                (deviceId as ConstrainDOMStringParameters).exact !== undefined,
        };
    };

    const overconstrained = (): DOMException => {
        const error = new DOMException(
            'No device matches the requested deviceId',
            'OverconstrainedError',
        );
        Object.defineProperty(error, 'constraint', { value: 'deviceId' });

        return error;
    };

    /** A new canvas track for one acquisition. Stopping it ends only this acquisition's drawing. */
    const cameraTrack = (deviceId: string): MediaStreamTrack => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;

        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        const card = deviceId === 'fake-camera-2' ? '#2050c0' : '#808080';
        const t0 = performance.now();
        const draw = () => {
            if (frozen) {
                return;
            }

            const t = performance.now() - t0;
            const flash = t % 1000 < 100;
            context.fillStyle = flash ? '#ffffff' : card;
            context.fillRect(0, 0, 640, 480);
            context.fillStyle = flash ? '#000000' : '#ffffff';
            context.font = 'bold 72px monospace';
            context.fillText(`${(t / 1000).toFixed(2)}s`, 140, 260);
        };

        draw();

        const timer = setInterval(draw, 1000 / 60);
        const track = canvas.captureStream(30).getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
            clearInterval(timer);
            stop();
        };

        return track;
    };

    /** The one AudioContext and its 220 Hz tone, made by the first getUserMedia call (after a click). */
    const sharedTone = async (): Promise<{
        context: AudioContext;
        gain: GainNode;
    }> => {
        if (audio === null) {
            const context = new AudioContext();
            const tone = context.createOscillator();
            const gain = context.createGain();
            tone.frequency.value = 220;
            gain.gain.value = micGain;
            tone.connect(gain);
            tone.start();
            audio = { context, gain };
        }

        if (waitForAudio) {
            await audio.context.resume();
        } else {
            audio.context.resume().catch(() => undefined);
        }

        return audio;
    };

    /**
     * A new mono microphone track fed by the one shared tone. Its stop() may be called any number
     * of times, like a real track's: disconnect(destination) throws InvalidAccessError once the
     * connection is gone, so it runs only on the first call.
     */
    const microphoneTrack = (shared: {
        context: AudioContext;
        gain: GainNode;
    }): MediaStreamTrack => {
        const destination = shared.context.createMediaStreamDestination();
        destination.channelCount = 1;
        shared.gain.connect(destination);

        const track = destination.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        let connected = true;
        track.stop = () => {
            if (connected) {
                connected = false;
                shared.gain.disconnect(destination);
            }

            stop();
        };

        return track;
    };

    const devices = () =>
        [...cameras, ...microphones].map((device) => ({
            ...device,
            toJSON: () => ({ ...device }),
        }));

    if (navigator.mediaDevices === undefined) {
        Object.defineProperty(navigator, 'mediaDevices', {
            value: new EventTarget(),
            configurable: true,
        });
    }

    navigator.mediaDevices.enumerateDevices = async () =>
        devices() as unknown as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async (
        constraints: MediaStreamConstraints = {},
    ) => {
        const wantsVideo =
            constraints.video !== undefined && constraints.video !== false;
        const wantsAudio =
            constraints.audio !== undefined && constraints.audio !== false;

        if (!wantsVideo && !wantsAudio) {
            throw new TypeError(
                'At least one of audio and video must be requested',
            );
        }

        const camera = requested(constraints.video);
        const microphone = requested(constraints.audio);

        if (
            wantsVideo &&
            camera.exact &&
            !cameras.some((device) => device.deviceId === camera.deviceId)
        ) {
            throw overconstrained();
        }

        if (
            wantsAudio &&
            microphone.exact &&
            !microphones.some(
                (device) => device.deviceId === microphone.deviceId,
            )
        ) {
            throw overconstrained();
        }

        const shared = await sharedTone();
        const tracks: MediaStreamTrack[] = [];

        if (wantsVideo) {
            tracks.push(cameraTrack(camera.deviceId ?? cameras[0].deviceId));
        }

        if (wantsAudio) {
            tracks.push(microphoneTrack(shared));
        }

        return new MediaStream(tracks);
    };
}
