import type { Phase } from '../core/state.ts';

export interface SilenceDetector {
    sample(level: number, tMs: number, phase: Phase): void;
    state(): 'ok' | 'silent';
}

/** Silence is RMS below this (author's call 12). */
const SILENT_LEVEL = 0.01;

/** A quiet stretch this long is a dead microphone (spec 6.3). */
const NO_AUDIO_MS = 5000;

/** The phases the detector runs in: before the take and during it. */
function listens(phase: Phase): boolean {
    return phase === 'ready' || phase === 'recording';
}

/**
 * The dead microphone. A quiet stretch starts at the first quiet sample in
 * `ready` or `recording`. A sample `noAudioMs` after its start raises
 * `device.no_audio` once and goes `silent`. A loud sample ends the stretch,
 * and raises `device.audio_resumed` with the stretch's length when silent
 * was raised. A sample in any other phase ends the stretch with no event.
 *
 * level 0.01 RMS and noAudioMs 5000 by default (author's call 12; spec 6.3).
 */
export function createSilenceDetector(deps: {
    level?: number;
    noAudioMs?: number;
    emit(type: string, payload: Record<string, unknown>): void;
    onState(state: 'ok' | 'silent'): void;
}): SilenceDetector {
    const level = deps.level ?? SILENT_LEVEL;
    const noAudioMs = deps.noAudioMs ?? NO_AUDIO_MS;
    /** When the current quiet stretch started, or null when there is none. */
    let quietSince: number | null = null;
    let current: 'ok' | 'silent' = 'ok';

    function end(tMs: number, report: boolean): void {
        const since = quietSince;
        quietSince = null;

        if (current === 'silent') {
            current = 'ok';

            if (report && since !== null) {
                deps.emit('device.audio_resumed', {
                    silent_ms: Math.max(0, tMs - since),
                });
            }

            deps.onState('ok');
        }
    }

    return {
        sample(sampled: number, tMs: number, phase: Phase): void {
            if (!listens(phase)) {
                // A stretch outside ready and recording says nothing about the microphone.
                end(tMs, false);

                return;
            }

            if (sampled >= level) {
                end(tMs, true);

                return;
            }

            if (quietSince === null) {
                quietSince = tMs;
            }

            if (current === 'ok' && tMs - quietSince >= noAudioMs) {
                current = 'silent';
                deps.emit('device.no_audio', { silent_ms: noAudioMs });
                deps.onState('silent');
            }
        },

        state(): 'ok' | 'silent' {
            return current;
        },
    };
}
