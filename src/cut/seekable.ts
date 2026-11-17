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
 * (`nonKeyframeStart` false). The cues point at the video track, else at the audio track of an
 * audio-only take (Plan 10, author's call 6). Any SeekHead is dropped and none is written. The Segment keeps an
 * unknown size. Every element the writer makes has an 8-byte size field and every uint is 8
 * bytes, so the size of Cues is known before the cluster offsets and one pass is enough.
 *
 * Fragmented MP4 (author's call 3): an `mehd` with the duration in `mvex`, and a `sidx` after
 * `moov` with one reference per media segment (`starts_with_SAP` 1 and `SAP_type` 1 unless
 * `nonKeyframeStart`), on the video track, else on the audio track of an audio-only take (Plan 10,
 * author's call 6). No Media Source Extensions are needed in any engine.
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
const TRACK_TYPE_AUDIO = 2;

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

/**
 * The track number the cues point at (Plan 10, author's call 6): the first video track (TrackType
 * 1), else the first audio track (TrackType 2), else null. Every audio segment starts a Cluster or
 * a moof with no keyframe rule, so it is always cued (WebM) or SAP type 1 (MP4).
 */
function cueTrackNumber(bytes: Uint8Array, tracks: Element): number | null {
    const numbers = new Map<number, number>();

    for (const entry of children(bytes, tracks) ?? []) {
        if (entry.id !== EBML_ID.TrackEntry) {
            continue;
        }

        const fields = children(bytes, entry) ?? [];
        const type = fields.find((field) => field.id === EBML_ID.TrackType);
        const number = fields.find((field) => field.id === EBML_ID.TrackNumber);

        if (type === undefined || number === undefined) {
            continue;
        }

        const kind = readUint(bytes, type);

        if (!numbers.has(kind)) {
            numbers.set(kind, readUint(bytes, number));
        }
    }

    return (
        numbers.get(TRACK_TYPE_VIDEO) ?? numbers.get(TRACK_TYPE_AUDIO) ?? null
    );
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
    let cueTrack: number | null = null;
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
            cueTrack = cueTrackNumber(init, child);

            continue;
        }

        kept.push(init.subarray(child.at, child.end));
    }

    if (infoChildren === null || tracks === null || cueTrack === null) {
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
                        element(EBML_ID.CueTrack, uint64(cueTrack)),
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

/* Fragmented MP4 (author's call 3). */

interface Box {
    type: string;
    /** Offset of the box's size field. */
    at: number;
    /** Offset just past the box. */
    end: number;
}

/** The most references one sidx can carry (reference_count is 16 bits). */
const MAX_SIDX_REFERENCES = 65_535;
/** referenced_size is 31 bits. */
const MAX_REFERENCED_SIZE = 2 ** 31;
/** starts_with_SAP 1, SAP_type 1, SAP_delta_time 0. */
const SAP_TYPE_1 = 0x90000000;

/** The box at `at`, or null for a size of 0 or 1 (64-bit), below 8, or past `limit`. */
function readBox(bytes: Uint8Array, at: number, limit: number): Box | null {
    if (at + 8 > limit) {
        return null;
    }

    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

    if (size < 8 || at + size > limit) {
        return null;
    }

    return {
        type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
        at,
        end: at + size,
    };
}

/** Every box from `from` to `to`, or null when one does not read. */
function boxList(bytes: Uint8Array, from: number, to: number): Box[] | null {
    const out: Box[] = [];

    for (let at = from; at < to;) {
        const found = readBox(bytes, at, to);

        if (found === null) {
            return null;
        }

        out.push(found);
        at = found.end;
    }

    return out;
}

function u16(n: number): Uint8Array {
    return Uint8Array.from([(n >>> 8) & 0xff, n & 0xff]);
}

function u32(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n >>> 0);

    return out;
}

function readU32(bytes: Uint8Array, at: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
}

/** A box with a 32-bit size and a four-letter ASCII type. */
function box(type: string, ...body: (Uint8Array | number[])[]): Uint8Array {
    const data = join(body.map((part) => Uint8Array.from(part)));
    const typeBytes = Uint8Array.from(type, (char) => char.charCodeAt(0));

    return join([u32(8 + data.byteLength), typeBytes, data]);
}

/** A full box's field at `v0` (version 0) or `v1` (version 1) past the box start. */
function versioned(
    bytes: Uint8Array,
    found: Box,
    v0: number,
    v1: number,
): number | null {
    const at = found.at + (bytes[found.at + 8] === 1 ? v1 : v0);

    return at + 4 <= found.end ? readU32(bytes, at) : null;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | null {
    return (
        (boxList(bytes, parent.at + 8, parent.end) ?? []).find(
            (kid) => kid.type === type,
        ) ?? null
    );
}

/**
 * The reference track's track_ID and media timescale (Plan 10, author's call 6): the first trak
 * whose hdlr is `vide`, else the first whose hdlr is `soun`, or null when neither reads. Every
 * audio segment starts a moof with no keyframe rule, so it is always SAP type 1.
 */
function referenceTrack(
    bytes: Uint8Array,
    moovKids: readonly Box[],
): { trackId: number; scale: number } | null {
    return (
        handlerTrack(bytes, moovKids, 'vide') ??
        handlerTrack(bytes, moovKids, 'soun')
    );
}

/** The first trak whose hdlr is `handler`: its track_ID and media timescale, or null when it does not read. */
function handlerTrack(
    bytes: Uint8Array,
    moovKids: readonly Box[],
    handler: string,
): { trackId: number; scale: number } | null {
    for (const trak of moovKids) {
        if (trak.type !== 'trak') {
            continue;
        }

        const mdia = child(bytes, trak, 'mdia');
        const hdlr = mdia === null ? null : child(bytes, mdia, 'hdlr');

        if (mdia === null || hdlr === null || hdlr.at + 20 > hdlr.end) {
            continue;
        }

        if (
            String.fromCharCode(
                ...bytes.subarray(hdlr.at + 16, hdlr.at + 20),
            ) !== handler
        ) {
            continue;
        }

        const tkhd = child(bytes, trak, 'tkhd');
        const mdhd = child(bytes, mdia, 'mdhd');
        const trackId = tkhd === null ? null : versioned(bytes, tkhd, 20, 28);
        const scale = mdhd === null ? null : versioned(bytes, mdhd, 20, 28);

        return trackId === null || scale === null || scale === 0
            ? null
            : { trackId, scale };
    }

    return null;
}

/**
 * The fragmented MP4 head: an `mehd` with the duration in `mvex`, and a `sidx` with one
 * reference per media segment after `moov` (author's call 3); null when the init cannot be read.
 * Every `tfhd` of these fragments sets default-base-is-moof, so bytes added before the first
 * `moof` move no data offset.
 */
export function seekableMp4Head(
    init: Uint8Array,
    media: readonly SeekablePart[],
): Uint8Array | null {
    if (
        media.length === 0 ||
        media.length > MAX_SIDX_REFERENCES ||
        media.some((part) => part.bytes.byteLength >= MAX_REFERENCED_SIZE)
    ) {
        return null;
    }

    const top = boxList(init, 0, init.length);

    if (
        top === null ||
        top.some((found) => found.type === 'moof' || found.type === 'mdat')
    ) {
        return null;
    }

    const moov = top.find((found) => found.type === 'moov');
    const moovKids =
        moov === undefined ? null : boxList(init, moov.at + 8, moov.end);

    if (moov === undefined || moovKids === null) {
        return null;
    }

    const mvhd = moovKids.find((found) => found.type === 'mvhd');
    const mvex = moovKids.find((found) => found.type === 'mvex');
    const movieScale =
        mvhd === undefined ? null : versioned(init, mvhd, 20, 28);
    const mvexKids =
        mvex === undefined ? null : boxList(init, mvex.at + 8, mvex.end);
    const reference = referenceTrack(init, moovKids);

    if (
        movieScale === null ||
        movieScale === 0 ||
        mvexKids === null ||
        reference === null
    ) {
        return null;
    }

    const last = media[media.length - 1];
    const endMs = last.startMs + last.durationMs;
    const mehd = box(
        'mehd',
        [1, 0, 0, 0],
        uint64(Math.round((endMs * movieScale) / 1000)),
    );
    const newMvex = box(
        'mvex',
        mehd,
        ...mvexKids
            .filter((kid) => kid.type !== 'mehd')
            .map((kid) => init.subarray(kid.at, kid.end)),
    );
    const newMoov = box(
        'moov',
        ...moovKids.map((kid) =>
            kid.type === 'mvex' ? newMvex : init.subarray(kid.at, kid.end),
        ),
    );

    const ticks = (ms: number): number =>
        Math.round((ms * reference.scale) / 1000);
    const bounds = [...media.map((part) => ticks(part.startMs)), ticks(endMs)];
    const refs = media.map((part, i) =>
        join([
            u32(part.bytes.byteLength),
            u32(bounds[i + 1] - bounds[i]),
            u32(part.nonKeyframeStart ? 0 : SAP_TYPE_1),
        ]),
    );
    const sidx = box(
        'sidx',
        [1, 0, 0, 0],
        u32(reference.trackId),
        u32(reference.scale),
        uint64(bounds[0]),
        uint64(0),
        u16(0),
        u16(media.length),
        ...refs,
    );

    return join([
        ...top.map((found) =>
            found.type === 'moov'
                ? newMoov
                : init.subarray(found.at, found.end),
        ),
        sidx,
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
        return seekableMp4Head(init, media);
    }

    return null;
}
