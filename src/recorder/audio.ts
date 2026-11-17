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
    /**
     * D20: the microphone on the left, the interviewer on the right, into the
     * camera track, or into the audio track when it is the only track.
     */
    mix(source: MixSource): void;
    cameraAudio(): MediaStreamTrack[];
    /**
     * Points the meter and the mix at a new capture stream (a device switch,
     * a return from the background). The stereo track stays the same track,
     * so the interviewer and every later run keep it.
     */
    setMicrophone(microphone: MediaStream): void;
    /**
     * The microphone now (Plan 10, author's call 9): its RMS and the largest
     * absolute sample of the last analyser window, both raw. The same
     * analyser the meter and the dead microphone detector read, so a loud
     * interviewer never lifts it. 0 and 0 while the context is not running
     * or there is no microphone.
     */
    readInput(): { rms: number; peak: number };
    /**
     * The interviewer side's RMS now (author's call 9): a second analyser on
     * the interviewer gain of the D20 mix. 0 with no mix (a mono session).
     */
    outputLevel(): number;
    /**
     * Fills `into` with BANDS values, 0 to 1, log spaced from 100 Hz to
     * 8 kHz over the microphone analyser's byte frequency data (author's
     * call 9). All 0 while the context is not running or there is no microphone.
     */
    bands(into: Float32Array): void;
    /**
     * A stream of the microphone only, no video track, made on first use
     * (author's call 9). The same stream across setMicrophone(), so a host
     * holding it keeps hearing the new device.
     */
    microphoneStream(): MediaStream;
    /**
     * A host analyser on this context, fed from the microphone and kept
     * across setMicrophone() (author's call 9). null while there is no
     * microphone source.
     */
    tap(options?: AudioTapOptions): AnalyserNode | null;
    close(): Promise<void>;
}

/** How many frequency bands bands() fills (Plan 10, author's call 9). */
export const BANDS = 8;

/** The lowest band's lower edge. */
const BAND_LOW_HZ = 100;

/** The highest band's upper edge. */
const BAND_HIGH_HZ = 8000;

/** A host analyser's settings; the defaults are the browser's own. */
export interface AudioTapOptions {
    fftSize?: number;
    smoothingTimeConstant?: number;
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

/** The largest absolute sample. */
function peakOf(samples: Float32Array): number {
    let peak = 0;

    for (const sample of samples) {
        const size = Math.abs(sample);

        if (size > peak) {
            peak = size;
        }
    }

    return peak;
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
    /** The interviewer side's analyser, for outputLevel() (author's call 9). */
    let outputAnalyser: AnalyserNode | null = null;
    let outputBuffer: Float32Array<ArrayBuffer> | null = null;
    /** The microphone-only stream for the host, made on first use. */
    let micDestination: MediaStreamAudioDestinationNode | null = null;
    /** The host's analysers, fed from the microphone. */
    const taps = new Set<AnalyserNode>();
    /** The microphone analyser's frequency bins, made on first use. */
    let byteBins: Uint8Array<ArrayBuffer> | null = null;

    if (deps.stereo) {
        merger = context.createChannelMerger(2);
        interviewer = context.createGain();
        outputAnalyser = context.createAnalyser();
        outputAnalyser.fftSize = FFT_SIZE;
        outputBuffer = new Float32Array(FFT_SIZE);
        interviewer.connect(outputAnalyser);
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

        // The host's stream and analysers follow a device switch.
        if (micDestination !== null) {
            source.connect(micDestination);
        }

        for (const each of taps) {
            source.connect(each);
        }

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
                    'Fitt Video: mix() is ignored, because this session records mono audio.',
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

        readInput(): { rms: number; peak: number } {
            if (context.state !== 'running' || source === null) {
                return { rms: 0, peak: 0 };
            }

            analyser.getFloatTimeDomainData(buffer);

            return { rms: rms(buffer), peak: peakOf(buffer) };
        },

        outputLevel(): number {
            if (
                context.state !== 'running' ||
                outputAnalyser === null ||
                outputBuffer === null
            ) {
                return 0;
            }

            outputAnalyser.getFloatTimeDomainData(outputBuffer);

            return rms(outputBuffer);
        },

        bands(into: Float32Array): void {
            if (context.state !== 'running' || source === null) {
                into.fill(0);

                return;
            }

            byteBins ??= new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(byteBins);
            const binHz = context.sampleRate / analyser.fftSize;
            const ratio = BAND_HIGH_HZ / BAND_LOW_HZ;

            for (let band = 0; band < into.length && band < BANDS; band += 1) {
                const low = BAND_LOW_HZ * ratio ** (band / BANDS);
                const high = BAND_LOW_HZ * ratio ** ((band + 1) / BANDS);
                const from = Math.floor(low / binHz);
                const to = Math.min(
                    byteBins.length,
                    Math.max(from + 1, Math.floor(high / binHz)),
                );
                let sum = 0;

                for (let bin = from; bin < to; bin += 1) {
                    sum += byteBins[bin];
                }

                into[band] = to > from ? sum / (to - from) / 255 : 0;
            }
        },

        microphoneStream(): MediaStream {
            if (micDestination === null) {
                micDestination = context.createMediaStreamDestination();
                source?.connect(micDestination);
            }

            return micDestination.stream;
        },

        tap(options: AudioTapOptions = {}): AnalyserNode | null {
            if (source === null || closed) {
                return null;
            }

            const node = context.createAnalyser();
            node.fftSize = options.fftSize ?? FFT_SIZE;
            node.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.8;
            source.connect(node);
            taps.add(node);

            return node;
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

            for (const node of [...taps, micDestination, outputAnalyser]) {
                try {
                    node?.disconnect();
                } catch {
                    // Already gone.
                }
            }

            taps.clear();

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
