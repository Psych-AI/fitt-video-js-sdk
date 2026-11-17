/**
 * One curve for the meter, `--fitt-level` and `getInputVolume()` (Plan 10,
 * author's call 8). Raw RMS of speech sits at about 0.01 to 0.25, so a host
 * never sees raw RMS: it sees the square root of RMS over 0.25, clamped to 1,
 * and 0 at or under the floor.
 */

/** RMS at or under this is silence: level 0. */
export const LEVEL_FLOOR = 0.002;

/** RMS at or over this is a full level: 1. */
export const LEVEL_FULL = 0.25;

/** `data-speaking` turns on at this normalised level (raw RMS 0.01). */
export const SPEAKING_ON = 0.2;

/** `data-speaking` turns off after the level stays under this (raw RMS 0.0025)... */
export const SPEAKING_OFF = 0.1;

/** ...for this long. */
export const SPEAKING_HOLD_MS = 300;

/** The microphone's RMS on the curve: 0 to 1. NaN is 0. */
export function normalisedLevel(rms: number): number {
    if (!(rms > LEVEL_FLOOR)) {
        return 0;
    }

    return Math.min(1, Math.sqrt(rms / LEVEL_FULL));
}

/** Whether the person is speaking, with a hold so a short pause never flickers it. */
export interface SpeakingGate {
    /** Takes a normalised level at `tMs` and answers whether the person is speaking now. */
    update(level: number, tMs: number): boolean;
    reset(): void;
}

export function createSpeakingGate(): SpeakingGate {
    let speaking = false;
    let quietSince: number | null = null;

    return {
        update(level: number, tMs: number): boolean {
            if (level >= SPEAKING_ON) {
                speaking = true;
                quietSince = null;

                return speaking;
            }

            if (!speaking) {
                return speaking;
            }

            if (level < SPEAKING_OFF) {
                quietSince ??= tMs;

                if (tMs - quietSince >= SPEAKING_HOLD_MS) {
                    speaking = false;
                    quietSince = null;
                }
            } else {
                quietSince = null;
            }

            return speaking;
        },

        reset(): void {
            speaking = false;
            quietSince = null;
        },
    };
}
