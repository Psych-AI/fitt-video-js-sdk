/**
 * The seekable head of a review copy (Plan 9, spec 6.10).
 *
 * The local copy of a take is the run's init followed by its media segments, joined as they
 * were cut. MediaRecorder writes no duration and no index, so a browser cannot seek such a file
 * from a `blob:` URL. This module rewrites only the init into a head that gives the joined file
 * a duration and an index; the media segment bytes never change.
 *
 * WebM (author's call 2): the head carries an Info with Duration and a Cues element before the
 * first Cluster, with one CuePoint per media segment that starts on a keyframe Cluster
 * (`nonKeyframeStart` false). Any SeekHead is dropped and none is written. The Segment keeps an
 * unknown size. Every element the writer makes has an 8-byte size field and every uint is 8
 * bytes, so the size of Cues is known before the cluster offsets and one pass is enough.
 *
 * Fragmented MP4 (author's call 3): an `mehd` in `mvex` and a `sidx` after `moov` (Task 3).
 */

/** One media segment of a run, as the cutter cut it. */
export interface SeekablePart {
    bytes: Uint8Array;
    /** CutSegment.startMs: media time of its first Cluster, or of its video tfdt, in ms. */
    startMs: number;
    durationMs: number;
    /** CutSegment.nonKeyframeStart: no cue (WebM) and no SAP (MP4) for this segment. */
    nonKeyframeStart: boolean;
}

const EBML_ID = {
    Ebml: 0x1a45dfa3,
    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    Duration: 0x4489,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackType: 0x83,
    Cues: 0x1c53bb6b,
    CuePoint: 0xbb,
    CueTime: 0xb3,
    CueTrackPositions: 0xb7,
    CueTrack: 0xf7,
    CueClusterPosition: 0xf1,
    Cluster: 0x1f43b675,
} as const;

/** A CuePoint of three 17-byte leaves: 1 + 8 + 17 + (1 + 8 + 34). */
const CUE_POINT_BYTES = 69;
/** The Cues element's 4 ID bytes and 8 size bytes. */
const CUES_HEADER_BYTES = 12;
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const DEFAULT_TIMECODE_SCALE = 1_000_000;
const TRACK_TYPE_VIDEO = 1;

interface Element {
    id: number;
    /** Offset of the element's ID. */
    at: number;
    /** Offset of its body. */
    data: number;
    /** Offset just past its body. */
    end: number;
}

/** The width of a vint from its first byte: the position of the first set bit, 1 to 8, or 0 when none is set. */
function vintWidth(first: number): number {
    for (let width = 1; width <= 8; width++) {
        if (first & (0x80 >> (width - 1))) {
            return width;
        }
    }

    return 0;
}

/**
 * The element at `at`, or null for a bad vint, an end past `limit`, or an unknown size where
 * one is not allowed. With `unknownToLimit` (the Segment) an unknown size ends at `limit`.
 */
function readElement(
    bytes: Uint8Array,
    at: number,
    limit: number,
    unknownToLimit = false,
): Element | null {
    if (at >= limit) {
        return null;
    }

    const idWidth = vintWidth(bytes[at]);

    if (idWidth === 0 || idWidth > 4 || at + idWidth >= limit) {
        return null;
    }

    let id = 0;

    for (let i = 0; i < idWidth; i++) {
        id = id * 256 + bytes[at + i];
    }

    const sizeAt = at + idWidth;
    const sizeWidth = vintWidth(bytes[sizeAt]);

    if (sizeWidth === 0 || sizeAt + sizeWidth > limit) {
        return null;
    }

    const firstValue = bytes[sizeAt] & (0xff >> sizeWidth);
    let allOnes = firstValue === 0xff >> sizeWidth;
    let size = firstValue;

    for (let i = 1; i < sizeWidth; i++) {
        size = size * 256 + bytes[sizeAt + i];
        allOnes = allOnes && bytes[sizeAt + i] === 0xff;
    }

    const data = sizeAt + sizeWidth;

    if (allOnes) {
        return unknownToLimit ? { id, at, data, end: limit } : null;
    }

    const end = data + size;

    return end > limit ? null : { id, at, data, end };
}

/** Every child of `parent`, or null when one does not read. */
function children(bytes: Uint8Array, parent: Element): Element[] | null {
    const out: Element[] = [];

    for (let at = parent.data; at < parent.end;) {
        const child = readElement(bytes, at, parent.end);

        if (child === null) {
            return null;
        }

        out.push(child);
        at = child.end;
    }

    return out;
}

/** An unsigned integer body, big-endian. */
function readUint(bytes: Uint8Array, element: Element): number {
    let value = 0;

    for (let at = element.data; at < element.end; at++) {
        value = value * 256 + bytes[at];
    }

    return value;
}

/** An ID's bytes, big-endian, with no leading zero byte. */
function idBytes(id: number): Uint8Array {
    const out: number[] = [];

    for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) {
        out.unshift(rest % 256);
    }

    return Uint8Array.from(out);
}

/** 8 bytes, big-endian, of a safe integer, by division. */
function uint64(n: number): Uint8Array {
    const out = new Uint8Array(8);
    let rest = n;

    for (let i = 7; i >= 0; i--) {
        out[i] = rest % 256;
        rest = Math.floor(rest / 256);
    }

    return out;
}

/** An 8-byte size field: the 0x01 marker, then 7 bytes of `n`, big-endian. */
function sizeBytes(n: number): Uint8Array {
    const out = uint64(n);
    out[0] = 0x01;

    return out;
}

function float64(x: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, x, false);

    return out;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;

    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }

    return out;
}

/** An element with an 8-byte size field. */
function element(id: number, ...body: Uint8Array[]): Uint8Array {
    const data = join(body);

    return join([idBytes(id), sizeBytes(data.byteLength), data]);
}

/** The video track number of a Tracks element, or null when it has no video track. */
function videoTrackNumber(bytes: Uint8Array, tracks: Element): number | null {
    for (const entry of children(bytes, tracks) ?? []) {
        if (entry.id !== EBML_ID.TrackEntry) {
            continue;
        }

        const fields = children(bytes, entry) ?? [];
        const type = fields.find((field) => field.id === EBML_ID.TrackType);
        const number = fields.find((field) => field.id === EBML_ID.TrackNumber);

        if (
            type !== undefined &&
            number !== undefined &&
            readUint(bytes, type) === TRACK_TYPE_VIDEO
        ) {
            return readUint(bytes, number);
        }
    }

    return null;
}

/** The WebM head: Duration and one cue per keyframe-led segment (author's call 2); null when the init cannot be read. */
export function seekableWebmHead(
    init: Uint8Array,
    media: readonly SeekablePart[],
): Uint8Array | null {
    const ebml = readElement(init, 0, init.length);

    if (ebml === null || ebml.id !== EBML_ID.Ebml) {
        return null;
    }

    const segment = readElement(init, ebml.end, init.length, true);

    if (segment === null || segment.id !== EBML_ID.Segment) {
        return null;
    }

    let infoChildren: Uint8Array[] | null = null;
    let scale = DEFAULT_TIMECODE_SCALE;
    let tracks: Uint8Array | null = null;
    let videoTrack: number | null = null;
    const kept: Uint8Array[] = [];

    for (let at = segment.data; at < init.length;) {
        const child = readElement(init, at, init.length);

        if (child === null) {
            return null;
        }

        at = child.end;

        if (child.id === EBML_ID.Cluster) {
            return null;
        }

        if (child.id === EBML_ID.SeekHead || child.id === EBML_ID.Cues) {
            continue;
        }

        if (child.id === EBML_ID.Info) {
            const fields = children(init, child);

            if (fields === null) {
                return null;
            }

            infoChildren = [];

            for (const field of fields) {
                if (field.id === EBML_ID.Duration) {
                    continue;
                }

                if (field.id === EBML_ID.TimecodeScale) {
                    scale = readUint(init, field) || DEFAULT_TIMECODE_SCALE;
                }

                infoChildren.push(init.subarray(field.at, field.end));
            }

            continue;
        }

        if (child.id === EBML_ID.Tracks) {
            tracks = init.subarray(child.at, child.end);
            videoTrack = videoTrackNumber(init, child);

            continue;
        }

        kept.push(init.subarray(child.at, child.end));
    }

    if (infoChildren === null || tracks === null || videoTrack === null) {
        return null;
    }

    const last = media.at(-1);
    const endMs = last === undefined ? 0 : last.startMs + last.durationMs;
    const info = element(
        EBML_ID.Info,
        ...infoChildren,
        element(EBML_ID.Duration, float64((endMs * 1_000_000) / scale)),
    );

    const keptTotal = kept.reduce((sum, part) => sum + part.byteLength, 0);
    const cued = media.filter((part) => !part.nonKeyframeStart).length;
    let position =
        info.byteLength +
        tracks.byteLength +
        keptTotal +
        CUES_HEADER_BYTES +
        CUE_POINT_BYTES * cued;
    const points: Uint8Array[] = [];

    for (const part of media) {
        if (!part.nonKeyframeStart) {
            points.push(
                element(
                    EBML_ID.CuePoint,
                    element(
                        EBML_ID.CueTime,
                        uint64(Math.round((part.startMs * 1_000_000) / scale)),
                    ),
                    element(
                        EBML_ID.CueTrackPositions,
                        element(EBML_ID.CueTrack, uint64(videoTrack)),
                        element(EBML_ID.CueClusterPosition, uint64(position)),
                    ),
                ),
            );
        }

        position += part.bytes.byteLength;
    }

    return join([
        init.subarray(0, ebml.end),
        idBytes(EBML_ID.Segment),
        Uint8Array.from(UNKNOWN_SIZE),
        info,
        tracks,
        ...kept,
        element(EBML_ID.Cues, ...points),
    ]);
}

/**
 * The bytes that replace the run's init so the joined file has a duration and an index; null
 * when the init cannot be read or the type is neither WebM nor MP4. The joined file is this head
 * followed by every `part.bytes` unchanged.
 */
export function seekableHead(
    mimeType: string,
    init: Uint8Array,
    media: readonly SeekablePart[],
): Uint8Array | null {
    if (/^(video|audio)\/webm/i.test(mimeType)) {
        return seekableWebmHead(init, media);
    }

    if (/^(video|audio)\/mp4/i.test(mimeType)) {
        // Task 3 fills the fragmented MP4 head.
        return null;
    }

    return null;
}
