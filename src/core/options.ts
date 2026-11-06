import type { Descriptor, TrackName } from './descriptor.ts';
import { readEnforce } from './enforce.ts';
import type { EnvironmentOverrides } from './env.ts';

/** What a host may pass to FittVideo.session(descriptor, options). */
export interface SessionOptions {
    signals?: { groups?: string[] };
    enforce?: Record<string, unknown>;
    thresholds?: {
        audio_silence_level?: number;
        no_audio_ms?: number;
        idle_ms?: number;
        resize_debounce_ms?: number;
    };
    capture?: {
        camera?: { video_bitrate_bps?: number; audio_bitrate_bps?: number };
        audio?: { audio_bitrate_bps?: number };
    };
    upload?: { transport?: 'put' | 'post' };
    checks?: { wait?: boolean; timeoutMs?: number };
    ui?: Record<string, unknown>;
    /** Overrides of the browser's fetch and online state: the playground's faults (author's call 14). Tests inject a whole fake through SessionSeams.env instead. */
    environment?: EnvironmentOverrides;
    /** Exposes session.debug (author's call 14). */
    debug?: boolean;
}

/** The session's settings: the descriptor, narrowed by the options. */
export interface Settings {
    groups: string[];
    stayOnPage: { graceMs: number } | null;
    silenceLevel: number;
    noAudioMs: number;
    idleMs: number;
    resizeDebounceMs: number;
    bitrates: Partial<Record<TrackName, { video?: number; audio: number }>>;
    forcePost: boolean;
    checksWait: boolean;
    checksTimeoutMs: number;
}

const SILENCE_LEVEL = 0.01;
const NO_AUDIO_MS = 5000;
const IDLE_MS = 30_000;
const RESIZE_DEBOUNCE_MS = 300;
const CHECKS_TIMEOUT_MS = 60_000;

/** A finite number of 0 or more, else the fallback. */
function amount(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : fallback;
}

/** The lower of the two, when the option is a usable number: an option never raises a bitrate. */
function lowered(allowed: number, option: unknown): number {
    return typeof option === 'number' && Number.isFinite(option) && option > 0
        ? Math.min(allowed, Math.floor(option))
        : allowed;
}

function groupsOf(
    descriptor: Descriptor,
    options: SessionOptions,
    warn: (message: string) => void,
): string[] {
    const allowed = descriptor.signals.groups;
    const asked = options.signals?.groups;

    if (!Array.isArray(asked)) {
        return [...allowed];
    }

    for (const group of asked) {
        if (!allowed.includes(group)) {
            warn(
                `Fitt Video ignores the signal group "${group}": the session does not allow it.`,
            );
        }
    }

    return allowed.filter((group) => asked.includes(group));
}

function stayOnPageOf(
    descriptor: Descriptor,
    options: SessionOptions,
    warn: (message: string) => void,
): { graceMs: number } | null {
    const { stayOnPage } = readEnforce(descriptor.enforce, warn);
    const asked = options.enforce;

    if (asked === undefined || asked === null || typeof asked !== 'object') {
        return stayOnPage;
    }

    for (const key of Object.keys(asked)) {
        if (key !== 'stay_on_page') {
            warn(`Fitt Video ignores options.enforce.${key} in this version.`);
        }
    }

    const stay = asked.stay_on_page;
    const grace =
        typeof stay === 'object' && stay !== null
            ? (stay as { grace_ms?: unknown }).grace_ms
            : undefined;

    if (
        stayOnPage === null ||
        typeof grace !== 'number' ||
        !Number.isFinite(grace) ||
        grace < 0
    ) {
        return stayOnPage;
    }

    // The option may only shorten the grace the descriptor sets.
    return { graceMs: Math.min(stayOnPage.graceMs, Math.floor(grace)) };
}

function bitratesOf(
    descriptor: Descriptor,
    options: SessionOptions,
): Settings['bitrates'] {
    const bitrates: Settings['bitrates'] = {};

    for (const track of descriptor.tracks) {
        if (track.kind !== 'chunked') {
            continue;
        }

        const video = track.capture.video?.bitrate_bps;
        let audio = track.capture.audio.bitrate_bps;
        let videoAllowed = video;

        if (track.track === 'camera') {
            const camera = options.capture?.camera;
            videoAllowed =
                video === undefined
                    ? undefined
                    : lowered(video, camera?.video_bitrate_bps);
            audio = lowered(audio, camera?.audio_bitrate_bps);
        } else if (track.track === 'audio') {
            audio = lowered(audio, options.capture?.audio?.audio_bitrate_bps);
        }

        bitrates[track.track] =
            videoAllowed === undefined
                ? { audio }
                : { video: videoAllowed, audio };
    }

    return bitrates;
}

/** Options narrow what the descriptor allows and never widen it. */
export function resolveSettings(
    descriptor: Descriptor,
    options: SessionOptions,
    warn: (message: string) => void,
): Settings {
    if (
        options.ui !== undefined &&
        options.ui !== null &&
        Object.keys(options.ui).length > 0
    ) {
        warn(
            "options.ui is not read in this version; set the element's attributes instead",
        );
    }

    const thresholds = options.thresholds ?? {};

    return {
        groups: groupsOf(descriptor, options, warn),
        stayOnPage: stayOnPageOf(descriptor, options, warn),
        silenceLevel: amount(thresholds.audio_silence_level, SILENCE_LEVEL),
        noAudioMs: amount(thresholds.no_audio_ms, NO_AUDIO_MS),
        idleMs: amount(thresholds.idle_ms, IDLE_MS),
        resizeDebounceMs: amount(
            thresholds.resize_debounce_ms,
            RESIZE_DEBOUNCE_MS,
        ),
        bitrates: bitratesOf(descriptor, options),
        forcePost: options.upload?.transport === 'post',
        checksWait: options.checks?.wait === true,
        checksTimeoutMs: amount(options.checks?.timeoutMs, CHECKS_TIMEOUT_MS),
    };
}
