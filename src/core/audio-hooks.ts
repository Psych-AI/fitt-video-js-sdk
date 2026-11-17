import type { AudioGraph, AudioTapOptions } from '../recorder/audio.ts';
import { BANDS } from '../recorder/audio.ts';
import { normalisedLevel } from '../recorder/level.ts';
import type { Environment, Frames } from './env.ts';

/**
 * `session.audio`: the host's audio levels on the SDK's one capture (spec
 * 6.11, Plan 10). The host never calls getUserMedia again: a second capture
 * can mute the first on iOS. Every level is on the one curve of author's
 * call 8 (`normalisedLevel()`), and every hook reads the one graph of
 * `src/recorder/audio.ts` (author's call 9).
 */

/**
 * One animation frame of the microphone (author's call 9). level is on the
 * curve of author's call 8; peak is the raw largest absolute sample of the
 * last analyser window (0 to 1, not on the level curve); bands is one reused
 * Float32Array(BANDS), so copy it to keep it.
 */
export interface AudioFrame {
    level: number;
    peak: number;
    bands: Float32Array;
}

export type AudioAnalyserOptions = AudioTapOptions;

export interface FittAudio {
    /** The microphone now, 0 to 1. A closure: safe to pass unbound (the ElevenLabs Orb's prop). */
    getInputVolume: () => number;
    /** The interviewer side of the D20 mix now, 0 to 1; 0 with no mix. A closure, safe unbound. */
    getOutputVolume: () => number;
    /** Calls `listener` on every animation frame while the page is visible. Returns the unsubscribe. */
    onFrame(listener: (frame: AudioFrame) => void): () => void;
    /** The microphone only, no video track; the same stream across a device switch, new after every prepare. */
    readonly stream: MediaStream | null;
    /** The SDK's own AudioContext. */
    readonly context: AudioContext | null;
    /** A host analyser on the SDK's context, fed from the microphone. */
    createAnalyser(options?: AudioAnalyserOptions): AnalyserNode | null;
    /** Fires after every acquire and release: ask again for `stream` or an analyser. */
    onChange(listener: () => void): () => void;
}

/** What the session hands the hooks. */
export interface AudioHooksDeps {
    env: Environment;
    graph(): AudioGraph | null;
    doc: ({ visibilityState: string } & EventTarget) | null;
}

/** One host listener that throws must never stop the session or the other listeners. */
function safely(call: () => void): void {
    try {
        call();
    } catch (error) {
        console.error(error);
    }
}

/**
 * destroy() drops every listener and the pending frame, but is not final:
 * a session destroy() released comes back with prepare(), and its hooks
 * take new listeners then.
 */
export function createAudioHooks(deps: AudioHooksDeps): {
    audio: FittAudio;
    changed(): void;
    destroy(): void;
} {
    const frames: Frames = deps.env.frames ?? {
        request: (callback) =>
            deps.env.timers.setTimeout(() => callback(deps.env.perfNow()), 16),
        cancel: (handle) => deps.env.timers.clearTimeout(handle),
    };
    const bands = new Float32Array(BANDS);
    const frameListeners = new Set<(frame: AudioFrame) => void>();
    const changeListeners = new Set<() => void>();
    let pending: number | null = null;
    let watchingDoc = false;

    const hidden = (): boolean => deps.doc?.visibilityState === 'hidden';

    const cancel = (): void => {
        if (pending !== null) {
            frames.cancel(pending);
            pending = null;
        }
    };

    const tick = (): void => {
        pending = null;

        if (frameListeners.size === 0 || hidden()) {
            return;
        }

        const graph = deps.graph();
        let frame: AudioFrame;

        if (graph === null) {
            bands.fill(0);
            frame = { level: 0, peak: 0, bands };
        } else {
            const input = graph.readInput();
            graph.bands(bands);
            frame = {
                level: normalisedLevel(input.rms),
                peak: input.peak,
                bands,
            };
        }

        for (const listener of [...frameListeners]) {
            safely(() => listener(frame));
        }

        schedule();
    };

    function schedule(): void {
        if (pending !== null || frameListeners.size === 0 || hidden()) {
            return;
        }

        pending = frames.request(tick);
    }

    const onVisibility = (): void => {
        if (hidden()) {
            cancel();

            return;
        }

        schedule();
    };

    const watchDoc = (on: boolean): void => {
        if (deps.doc === null || watchingDoc === on) {
            return;
        }

        watchingDoc = on;

        if (on) {
            deps.doc.addEventListener('visibilitychange', onVisibility);
        } else {
            deps.doc.removeEventListener('visibilitychange', onVisibility);
        }
    };

    const audio: FittAudio = {
        getInputVolume: () =>
            normalisedLevel(deps.graph()?.readInput().rms ?? 0),
        getOutputVolume: () =>
            normalisedLevel(deps.graph()?.outputLevel() ?? 0),

        onFrame(listener: (frame: AudioFrame) => void): () => void {
            frameListeners.add(listener);
            watchDoc(true);
            schedule();

            return () => {
                frameListeners.delete(listener);

                if (frameListeners.size === 0) {
                    cancel();
                    watchDoc(false);
                }
            };
        },

        get stream(): MediaStream | null {
            return deps.graph()?.microphoneStream() ?? null;
        },

        get context(): AudioContext | null {
            return deps.graph()?.context ?? null;
        },

        createAnalyser(options?: AudioAnalyserOptions): AnalyserNode | null {
            return deps.graph()?.tap(options) ?? null;
        },

        onChange(listener: () => void): () => void {
            changeListeners.add(listener);

            return () => {
                changeListeners.delete(listener);
            };
        },
    };

    return {
        audio,

        changed(): void {
            for (const listener of [...changeListeners]) {
                safely(listener);
            }
        },

        destroy(): void {
            cancel();
            watchDoc(false);
            frameListeners.clear();
            changeListeners.clear();
        },
    };
}
