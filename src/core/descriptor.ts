/**
 * Reads the descriptor the host hands to FittVideo.session(), as
 * DescriptorBuilder::build() writes it. The fixtures under tests/fixtures are
 * pinned to the server by tests/Feature/Video/Sdk/DescriptorShapeTest.php.
 */
export type Recipe = 'answer' | 'monitor' | 'conversation' | 'file';
export type TrackName = 'camera' | 'audio' | 'screen' | 'upload';

export interface UploadTarget {
    mode: string;
    url: string;
    fallback_url: string | null;
}

export interface ChunkedTrack {
    track: 'camera' | 'audio' | 'screen';
    video_id: string;
    kind: 'chunked';
    capture: {
        video?: {
            width: number;
            height: number;
            frame_rate: number;
            bitrate_bps: number;
        };
        audio: { bitrate_bps: number; channels: number };
    };
    segments: {
        target_ms: number;
        max_ms: number;
        part_size: number;
        max_bytes: number;
    };
    upload: UploadTarget;
}

export interface FileTrack {
    track: 'upload';
    video_id: string;
    kind: 'file';
    segments: { part_size: number; max_bytes: number; max_file_bytes: number };
    upload: UploadTarget;
}

export type DescriptorTrack = ChunkedTrack | FileTrack;

export interface RecordingLimits {
    countdown_ms: number;
    min_duration_ms: number;
    max_duration_ms: number;
    extension_ms: number;
    warning_before_end_ms: number;
}

export interface Descriptor {
    session_id: string;
    recipe: Recipe;
    take: number;
    clock: { session_cap_ms: number };
    token: {
        id: string;
        secret: string;
        expires_in_s: number;
        refresh_after_s: number;
    };
    endpoints: { api: string; media: string | null };
    tracks: DescriptorTrack[];
    recording?: RecordingLimits;
    signals: { groups: string[] };
    enforce: Record<string, unknown>;
    events: { batch_ms: number };
    checks?: Record<string, unknown>;
    queue: { abandon_after_ms: number; buffer_budget_bytes: number };
}

type FailReason = 'type' | 'missing' | 'max_below_min' | 'over_cap';

export type DescriptorResult =
    | { ok: true; descriptor: Descriptor }
    | {
          ok: false;
          code: 'config_invalid';
          path: string;
          reason: FailReason;
      };

const RECIPES: readonly string[] = [
    'answer',
    'monitor',
    'conversation',
    'file',
];
const CHUNKED_TRACKS: readonly string[] = ['camera', 'audio', 'screen'];
const VIDEO_TRACKS: readonly string[] = ['camera', 'screen'];

/** Thrown inside the reader only, and always caught there. */
class Invalid {
    readonly path: string;
    readonly reason: FailReason;

    constructor(path: string, reason: FailReason) {
        this.path = path;
        this.reason = reason;
    }
}

type Value = Record<string, unknown>;

const join = (path: string, key: string | number): string =>
    path === '' ? String(key) : `${path}.${key}`;

function isObject(value: unknown): value is Value {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(parent: Value, key: string, path: string): unknown {
    const value = parent[key];

    if (value === undefined) {
        throw new Invalid(join(path, key), 'missing');
    }

    return value;
}

function object(parent: Value, key: string, path: string): Value {
    const value = present(parent, key, path);

    if (!isObject(value)) {
        throw new Invalid(join(path, key), 'type');
    }

    return value;
}

function string(parent: Value, key: string, path: string): string {
    const value = present(parent, key, path);

    if (typeof value !== 'string' || value === '') {
        throw new Invalid(join(path, key), 'type');
    }

    return value;
}

function nullableString(parent: Value, key: string, path: string): void {
    const value = present(parent, key, path);

    if (value !== null && typeof value !== 'string') {
        throw new Invalid(join(path, key), 'type');
    }
}

function oneOf(
    parent: Value,
    key: string,
    path: string,
    allowed: readonly string[],
): string {
    const value = string(parent, key, path);

    if (!allowed.includes(value)) {
        throw new Invalid(join(path, key), 'type');
    }

    return value;
}

/** A whole number above 0, or at least 0 when `zero` is allowed. */
function integer(
    parent: Value,
    key: string,
    path: string,
    zero = false,
): number {
    const value = present(parent, key, path);

    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < (zero ? 0 : 1)
    ) {
        throw new Invalid(join(path, key), 'type');
    }

    return value;
}

function integers(
    parent: Value,
    key: string,
    path: string,
    keys: readonly string[],
    zero = false,
): Value {
    const value = object(parent, key, path);

    for (const name of keys) {
        integer(value, name, join(path, key), zero);
    }

    return value;
}

function readUpload(track: Value, path: string): void {
    const upload = object(track, 'upload', path);
    const uploadPath = join(path, 'upload');
    string(upload, 'mode', uploadPath);
    string(upload, 'url', uploadPath);
    nullableString(upload, 'fallback_url', uploadPath);
}

/** Reads one track and says whether it is chunked. */
function readTrack(track: unknown, path: string): boolean {
    if (!isObject(track)) {
        throw new Invalid(path, 'type');
    }

    const name = oneOf(track, 'track', path, [...CHUNKED_TRACKS, 'upload']);
    string(track, 'video_id', path);
    const kind = oneOf(track, 'kind', path, ['chunked', 'file']);

    if ((kind === 'file') !== (name === 'upload')) {
        throw new Invalid(join(path, 'kind'), 'type');
    }

    if (kind === 'file') {
        integers(track, 'segments', path, [
            'part_size',
            'max_bytes',
            'max_file_bytes',
        ]);
        readUpload(track, path);

        return false;
    }

    const capture = object(track, 'capture', path);
    const capturePath = join(path, 'capture');

    if (VIDEO_TRACKS.includes(name) || capture.video !== undefined) {
        integers(capture, 'video', capturePath, [
            'width',
            'height',
            'frame_rate',
            'bitrate_bps',
        ]);
    }

    integers(capture, 'audio', capturePath, ['bitrate_bps', 'channels']);
    integers(track, 'segments', path, [
        'target_ms',
        'max_ms',
        'part_size',
        'max_bytes',
    ]);
    readUpload(track, path);

    return true;
}

function readRecording(
    root: Value,
    required: boolean,
    sessionCapMs: number,
): void {
    if (root.recording === undefined && !required) {
        return;
    }

    const recording = integers(
        root,
        'recording',
        '',
        [
            'countdown_ms',
            'min_duration_ms',
            'max_duration_ms',
            'extension_ms',
            'warning_before_end_ms',
        ],
        true,
    ) as unknown as RecordingLimits;

    if (recording.max_duration_ms < recording.min_duration_ms) {
        throw new Invalid('recording.max_duration_ms', 'max_below_min');
    }

    if (recording.max_duration_ms + recording.extension_ms > sessionCapMs) {
        throw new Invalid('recording.max_duration_ms', 'over_cap');
    }
}

function read(input: unknown): Descriptor {
    if (!isObject(input)) {
        throw new Invalid('', 'type');
    }

    string(input, 'session_id', '');
    oneOf(input, 'recipe', '', RECIPES);
    integer(input, 'take', '');
    const sessionCapMs = integers(input, 'clock', '', ['session_cap_ms'])
        .session_cap_ms as number;

    const token = object(input, 'token', '');
    string(token, 'id', 'token');
    string(token, 'secret', 'token');
    integer(token, 'expires_in_s', 'token');
    integer(token, 'refresh_after_s', 'token');

    const endpoints = object(input, 'endpoints', '');
    string(endpoints, 'api', 'endpoints');
    nullableString(endpoints, 'media', 'endpoints');

    const tracks = present(input, 'tracks', '');

    if (!Array.isArray(tracks)) {
        throw new Invalid('tracks', 'type');
    }

    let chunked = false;

    tracks.forEach((track: unknown, index) => {
        chunked = readTrack(track, join('tracks', index)) || chunked;
    });

    readRecording(input, chunked, sessionCapMs);

    const signals = object(input, 'signals', '');
    const groups = present(signals, 'groups', 'signals');

    if (!Array.isArray(groups)) {
        throw new Invalid('signals.groups', 'type');
    }

    groups.forEach((group: unknown, index) => {
        if (typeof group !== 'string') {
            throw new Invalid(join('signals.groups', index), 'type');
        }
    });

    object(input, 'enforce', '');
    integers(input, 'events', '', ['batch_ms']);

    if (input.checks !== undefined) {
        object(input, 'checks', '');
    }

    integers(input, 'queue', '', ['abandon_after_ms', 'buffer_budget_bytes']);

    // A plain copy, never the host's object. A host hands over whatever it
    // holds, and in Vue or Inertia that is a reactive Proxy; the session
    // record is written to IndexedDB with structured clone, which refuses a
    // Proxy ("#<Object> could not be cloned"), so nothing local would ever
    // persist. A descriptor is JSON by contract, so a JSON round trip is the
    // exact copy and also detaches the SDK from later edits by the host.
    return JSON.parse(JSON.stringify(input)) as Descriptor;
}

/** Never throws. */
export function readDescriptor(input: unknown): DescriptorResult {
    try {
        return { ok: true, descriptor: read(input) };
    } catch (error) {
        if (error instanceof Invalid) {
            return {
                ok: false,
                code: 'config_invalid',
                path: error.path,
                reason: error.reason,
            };
        }

        return { ok: false, code: 'config_invalid', path: '', reason: 'type' };
    }
}
