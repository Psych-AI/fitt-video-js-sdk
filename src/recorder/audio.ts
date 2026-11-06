import type { Clock } from '../core/clock.ts';
import type { Environment } from '../core/env.ts';

export type MixSource =
    MediaStreamTrack | MediaStream | AudioNode | HTMLMediaElement;

export interface AudioGraph {
    readonly context: AudioContext;
    /** The microphone's RMS, 0 to 1, about every 100 ms. */
    level(): number;
    onLevel(listener: (level: number) => void): () => void;
    /** Resume after a user gesture (start()). */
    resume(): Promise<void>;
    /** D20: the microphone on the left, the interviewer on the right, into the camera track only. */
    mix(source: MixSource): void;
    cameraAudio(): MediaStreamTrack[];
    /**
     * Points the meter and the mix at a new capture stream (a device switch,
     * a return from the background). The stereo track stays the same track,
     * so the interviewer and every later run keep it.
     */
    setMicrophone(microphone: MediaStream): void;
    close(): Promise<void>;
}

export interface AudioGraphDeps {
    env: Environment;
    clock: Clock;
    microphone: MediaStream;
    stereo: boolean;
    createContext(): AudioContext;
    /** The document: a suspended context is resumed on the first pointerdown or keydown anywhere on it. */
    doc: EventTarget;
    onSample(level: number, tMs: number): void;
}

/** How often the microphone's level is read. */
const SAMPLE_MS = 100;

/** The analyser's window: about 43 ms at 48 kHz. */
const FFT_SIZE = 2048;

/**
 * How long resume() waits for the context. A browser with no audio output
 * device (Firefox in Sail and CI, owner decision 1) never settles resume(),
 * and a take must never hang on the meter.
 */
const RESUME_WAIT_MS = 1000;

const GESTURES = ['pointerdown', 'keydown'] as const;

/**
 * An interviewer media element's own context. createMediaElementSource()
 * takes an element's sound for the rest of the page's life, and an element
 * can feed only one MediaElementAudioSourceNode ever. So the element plays
 * through a context of its own that no release() closes: to the speakers,
 * so the candidate keeps hearing it after a take, and into a stream that
 * each take's graph brings in. A second take mixes the same element again.
 */
interface ElementCarrier {
    context: AudioContext;
    stream: MediaStream;
}

const carriers = new WeakMap<HTMLMediaElement, ElementCarrier>();

/** Resumes `context` now, and on the first pointerdown or keydown on `doc` when that is not enough. */
function resumeOnGesture(context: AudioContext, doc: EventTarget): void {
    context.resume().catch(() => undefined);

    if (context.state === 'running') {
        return;
    }

    const onGesture = (): void => {
        for (const type of GESTURES) {
            doc.removeEventListener(type, onGesture, { capture: true });
        }

        context.resume().catch(() => undefined);
    };

    for (const type of GESTURES) {
        doc.addEventListener(type, onGesture, { capture: true });
    }
}

function carrierFor(
    element: HTMLMediaElement,
    createContext: () => AudioContext,
    doc: EventTarget,
): ElementCarrier {
    const known = carriers.get(element);

    if (known !== undefined) {
        return known;
    }

    const context = createContext();
    const source = context.createMediaElementSource(element);
    const bridge = context.createMediaStreamDestination();
    source.connect(context.destination);
    source.connect(bridge);
    const carrier = { context, stream: bridge.stream };
    carriers.set(element, carrier);
    resumeOnGesture(context, doc);

    return carrier;
}

function rms(samples: Float32Array): number {
    let sum = 0;

    for (const sample of samples) {
        sum += sample * sample;
    }

    return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

/**
 * One AudioContext per prepared capture. The microphone feeds an analyser
 * that the meter and the dead microphone detector read; nothing else does,
 * so a loud interviewer never hides a dead microphone. For a stereo camera
 * track (conversation, D20) the mix is built before the take, because a
 * recorder cannot change its tracks: the microphone on the left, an
 * interviewer gain on the right, into one stereo stream destination, whose
 * track cameraAudio() returns. For a mono track cameraAudio() is the
 * microphone itself.
 *
 * The context is resumed at once without waiting, and, when that is not
 * enough, on the first pointerdown or keydown anywhere on the document, so
 * the meter works in `ready` after the first click (spec 6.3). No level is
 * passed on while the context is not running, so a suspended context never
 * reads as a dead microphone.
 */
export function createAudioGraph(deps: AudioGraphDeps): AudioGraph {
    const context = deps.createContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    const buffer = new Float32Array(analyser.fftSize);
    const listeners = new Set<(level: number) => void>();
    /** Bridges from other contexts, disconnected at close(). */
    const bridges: (() => void)[] = [];
    /** The element carriers this graph mixes, resumed with it. */
    const mixed = new Set<ElementCarrier>();
    let microphone = deps.microphone;
    let source: MediaStreamAudioSourceNode | null = null;
    let current = 0;
    let timer: number | null = null;
    let closed = false;
    let gestureArmed = false;

    let merger: ChannelMergerNode | null = null;
    let interviewer: GainNode | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;

    if (deps.stereo) {
        merger = context.createChannelMerger(2);
        interviewer = context.createGain();
        destination = context.createMediaStreamDestination();
        destination.channelCount = 2;
        destination.channelCountMode = 'explicit';
        interviewer.connect(merger, 0, 1);
        merger.connect(destination);
    }

    function attach(stream: MediaStream): void {
        if (source !== null) {
            source.disconnect();
            source = null;
        }

        microphone = stream;

        if (stream.getAudioTracks().length === 0) {
            return;
        }

        source = context.createMediaStreamSource(stream);
        source.connect(analyser);

        if (merger !== null) {
            source.connect(merger, 0, 0);
        }
    }

    function onGesture(): void {
        disarmGesture();
        context.resume().catch(() => undefined);
    }

    function armGesture(): void {
        if (gestureArmed) {
            return;
        }

        gestureArmed = true;

        for (const type of GESTURES) {
            deps.doc.addEventListener(type, onGesture, { capture: true });
        }
    }

    function disarmGesture(): void {
        if (!gestureArmed) {
            return;
        }

        gestureArmed = false;

        for (const type of GESTURES) {
            deps.doc.removeEventListener(type, onGesture, { capture: true });
        }
    }

    function sample(): void {
        timer = deps.env.timers.setTimeout(() => {
            timer = null;

            if (closed) {
                return;
            }

            if (context.state === 'running' && source !== null) {
                analyser.getFloatTimeDomainData(buffer);
                current = rms(buffer);

                for (const listener of [...listeners]) {
                    listener(current);
                }

                deps.onSample(current, deps.clock.now());
            }

            sample();
        }, SAMPLE_MS);
    }

    /** The node of this context that carries `input`. */
    function nodeFor(input: MixSource): AudioNode {
        if (typeof (input as MediaStream).getAudioTracks === 'function') {
            return context.createMediaStreamSource(input as MediaStream);
        }

        if (typeof (input as AudioNode).connect === 'function') {
            const node = input as AudioNode;

            if (node.context === context) {
                return node;
            }

            // Nodes cannot connect across contexts: carry it over as a stream.
            const other = node.context as AudioContext;
            const bridge = other.createMediaStreamDestination();
            node.connect(bridge);
            bridges.push(() => node.disconnect(bridge));

            return context.createMediaStreamSource(bridge.stream);
        }

        if (typeof (input as MediaStreamTrack).kind === 'string') {
            return context.createMediaStreamSource(
                new MediaStream([input as MediaStreamTrack]),
            );
        }

        // A media element plays through its own context, which outlives this graph.
        const carrier = carrierFor(
            input as HTMLMediaElement,
            deps.createContext,
            deps.doc,
        );
        mixed.add(carrier);

        return context.createMediaStreamSource(carrier.stream);
    }

    attach(microphone);
    context.resume().catch(() => undefined);

    if (context.state !== 'running') {
        armGesture();
    }

    sample();

    return {
        context,

        level(): number {
            return current;
        },

        onLevel(listener: (level: number) => void): () => void {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },

        resume(): Promise<void> {
            if (closed) {
                return Promise.resolve();
            }

            // The start gesture lets the interviewer's own context run too.
            for (const carrier of mixed) {
                carrier.context.resume().catch(() => undefined);
            }

            if (context.state === 'running') {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                const wait = deps.env.timers.setTimeout(
                    resolve,
                    RESUME_WAIT_MS,
                );
                const done = (): void => {
                    deps.env.timers.clearTimeout(wait);
                    resolve();
                };

                context.resume().then(done, done);
            });
        },

        mix(input: MixSource): void {
            if (interviewer === null) {
                console.warn(
                    'Fitt Video: mix() is ignored, because this camera track is mono.',
                );

                return;
            }

            if (closed) {
                return;
            }

            try {
                nodeFor(input).connect(interviewer);
            } catch (error) {
                // A host mistake must never break the page: an element another graph already took, a closed context.
                console.warn(
                    'Fitt Video: mix() could not bring this source in.',
                    error,
                );
            }
        },

        cameraAudio(): MediaStreamTrack[] {
            if (destination !== null) {
                return destination.stream.getAudioTracks();
            }

            return microphone.getAudioTracks().slice(0, 1);
        },

        setMicrophone(next: MediaStream): void {
            if (closed) {
                microphone = next;

                return;
            }

            attach(next);
        },

        async close(): Promise<void> {
            if (closed) {
                return;
            }

            closed = true;

            if (timer !== null) {
                deps.env.timers.clearTimeout(timer);
                timer = null;
            }

            disarmGesture();
            listeners.clear();

            for (const disconnect of bridges.splice(0)) {
                try {
                    disconnect();
                } catch {
                    // Already gone with its own context.
                }
            }

            try {
                await context.close();
            } catch {
                // Closed already.
            }
        },
    };
}
