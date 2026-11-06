import {
    CutterError,
    type CutOptions,
    type CutSegment,
    type Cutter,
} from './types.ts';

export const TOLERANCE_MS = 250; // author's call 4: with 0, chrome-vp8-kf gives media starts 0, 5026, 15058, 25081, 30121, 40141, 45167, 50192, 55198 (three 10 s segments)

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;

/** Level-1 IDs (children of Segment). One of these ends a Cluster of unknown size. */
const LEVEL1 = new Set([
    ID_CLUSTER,
    ID_INFO,
    ID_TRACKS,
    0x1c53bb6b,
    0x114d9b74,
    0x1254c367,
    0x1941a469,
    0x1043a770,
]);

const TRACK_VIDEO = 1;
const TRACK_AUDIO = 2;
const INITIAL_CAPACITY = 65_536;

interface Header {
    id: number;
    /** Absolute offset of the body. */
    data: number;
    /** Body size, or null when unknown. */
    size: number | null;
}

type Phase = 'ebml' | 'segment' | 'level1' | 'cluster';

/**
 * A streaming WebM reader that cuts before a Cluster whose first video block is a keyframe
 * (author's call 4). One sequential parser over one growing buffer: a blob edge is never a
 * boundary, so any split of the same bytes gives the same segments.
 */
export function createEbmlCutter(options: CutOptions): Cutter {
    const audioOnly = options.audioOnly === true;

    let buffer = new Uint8Array(INITIAL_CAPACITY);
    /** Absolute offset of buffer[0]. */
    let base = 0;
    /** Valid bytes in the buffer. */
    let length = 0;
    /** Absolute parse position. It may run past the bytes received while a body is skipped. */
    let position = 0;
    let phase: Phase = 'ebml';
    let failed = false;

    /** Absolute offset of the current segment, not yet returned. */
    let segmentStart = 0;
    let initReturned = false;
    let timecodeScale = 1_000_000;
    let videoTrack: number | null = null;
    let audioTrack: number | null = null;
    let firstTrack: number | null = null;

    let started = false;
    let lastCutMs = 0;
    let currentNonKeyframe = false;

    let clusterStart = 0;
    let clusterEnd: number | null = null;
    let clusterTicks: number | null = null;
    let decided = false;

    let lastBlockMs: number | null = null;
    let lastGapMs = 0;

    const end = (): number => base + length;
    const byteAt = (offset: number): number => buffer[offset - base];
    const copy = (from: number, to: number): Uint8Array =>
        buffer.slice(from - base, to - base);
    const toMs = (ticks: number): number =>
        Math.round((ticks * timecodeScale) / 1e6);

    function append(chunk: Uint8Array): void {
        if (length + chunk.byteLength > buffer.byteLength) {
            const drop = segmentStart - base;

            if (drop > buffer.byteLength / 2) {
                buffer.copyWithin(0, drop, length);
                length -= drop;
                base += drop;
            }

            if (length + chunk.byteLength > buffer.byteLength) {
                let capacity = buffer.byteLength * 2;

                while (capacity < length + chunk.byteLength) {
                    capacity *= 2;
                }

                const grown = new Uint8Array(capacity);
                grown.set(buffer.subarray(0, length));
                buffer = grown;
            }
        }

        buffer.set(chunk, length);
        length += chunk.byteLength;
    }

    function fail(message: string, completed: CutSegment[]): never {
        failed = true;

        throw new CutterError(message, completed);
    }

    /** A vint's width from its first byte, or a CutterError when no marker bit is set in range. */
    function vintWidth(
        first: number,
        max: number,
        what: string,
        at: number,
        completed: CutSegment[],
    ): number {
        for (let width = 1; width <= max; width++) {
            if (first & (0x80 >> (width - 1))) {
                return width;
            }
        }

        return fail(`bad ${what} at byte ${at}`, completed);
    }

    /** The element header at `at`, or null when the buffer ends inside it. */
    function readHeader(at: number, completed: CutSegment[]): Header | null {
        if (at >= end()) {
            return null;
        }

        const idWidth = vintWidth(byteAt(at), 4, 'element id', at, completed);

        if (at + idWidth >= end()) {
            return null;
        }

        let id = 0;

        for (let index = 0; index < idWidth; index++) {
            id = id * 256 + byteAt(at + index);
        }

        const sizeAt = at + idWidth;
        const first = byteAt(sizeAt);
        const sizeWidth = vintWidth(
            first,
            8,
            'element size',
            sizeAt,
            completed,
        );

        if (sizeAt + sizeWidth > end()) {
            return null;
        }

        const mask = 0xff >> sizeWidth;
        let size = first & mask;
        let allOnes = size === mask;

        for (let index = 1; index < sizeWidth; index++) {
            const value = byteAt(sizeAt + index);
            size = size * 256 + value;
            allOnes &&= value === 0xff;
        }

        return { id, data: sizeAt + sizeWidth, size: allOnes ? null : size };
    }

    function readUint(at: number, size: number): number {
        let value = 0;

        for (let index = 0; index < size; index++) {
            value = value * 256 + byteAt(at + index);
        }

        return value;
    }

    /** A block's track number, relative timecode and flags, or null when the buffer ends inside them. */
    function readBlockHeader(
        at: number,
        limit: number,
        completed: CutSegment[],
    ): { track: number; relative: number; flags: number } | null {
        if (at >= end()) {
            return null;
        }

        const first = byteAt(at);
        const width = vintWidth(first, 8, 'block track number', at, completed);

        if (at + width + 3 > limit) {
            return fail(
                `block header overruns its element at byte ${at}`,
                completed,
            );
        }

        if (at + width + 3 > end()) {
            return null;
        }

        let track = first & (0xff >> width);

        for (let index = 1; index < width; index++) {
            track = track * 256 + byteAt(at + index);
        }

        const raw = (byteAt(at + width) << 8) | byteAt(at + width + 1);

        return {
            track,
            relative: raw >= 0x8000 ? raw - 0x10000 : raw,
            flags: byteAt(at + width + 2),
        };
    }

    /** Every sized child of the body [from, to), which must be in the buffer. */
    function readChildren(
        from: number,
        to: number,
        completed: CutSegment[],
    ): Header[] {
        const found: Header[] = [];
        let at = from;

        while (at < to) {
            const header = readHeader(at, completed);

            if (header === null || header.size === null) {
                return fail(`bad child element at byte ${at}`, completed);
            }

            if (header.data + header.size > to) {
                return fail(
                    `child element overruns its parent at byte ${at}`,
                    completed,
                );
            }

            found.push(header);
            at = header.data + header.size;
        }

        return found;
    }

    function readInfo(header: Header, completed: CutSegment[]): void {
        for (const child of readChildren(
            header.data,
            header.data + header.size!,
            completed,
        )) {
            if (child.id === ID_TIMECODE_SCALE && child.size! > 0) {
                timecodeScale = readUint(child.data, child.size!);
            }
        }
    }

    function readTracks(header: Header, completed: CutSegment[]): void {
        for (const entry of readChildren(
            header.data,
            header.data + header.size!,
            completed,
        )) {
            if (entry.id !== ID_TRACK_ENTRY) {
                continue;
            }

            let number: number | null = null;
            let type: number | null = null;

            for (const field of readChildren(
                entry.data,
                entry.data + entry.size!,
                completed,
            )) {
                if (field.id === ID_TRACK_NUMBER) {
                    number = readUint(field.data, field.size!);
                } else if (field.id === ID_TRACK_TYPE) {
                    type = readUint(field.data, field.size!);
                }
            }

            if (number === null) {
                continue;
            }

            firstTrack ??= number;

            if (type === TRACK_VIDEO) {
                videoTrack ??= number;
            } else if (type === TRACK_AUDIO) {
                audioTrack ??= number;
            }
        }
    }

    /** The track whose blocks give the final segment's end. */
    function timingTrack(): number | null {
        return audioOnly
            ? (audioTrack ?? firstTrack)
            : (videoTrack ?? audioTrack ?? firstTrack);
    }

    function cutAt(
        clusterMs: number,
        nonKeyframe: boolean,
        completed: CutSegment[],
    ): void {
        completed.push({
            kind: 'media',
            bytes: copy(segmentStart, clusterStart),
            startMs: lastCutMs,
            durationMs: clusterMs - lastCutMs,
            nonKeyframeStart: currentNonKeyframe,
        });
        segmentStart = clusterStart;
        lastCutMs = clusterMs;
        currentNonKeyframe = nonKeyframe;
    }

    /** The cut rule (author's call 4), decided once per Cluster. */
    function decide(
        firstVideoIsKey: boolean | null,
        completed: CutSegment[],
    ): void {
        decided = true;

        const clusterMs = toMs(clusterTicks ?? 0);

        if (!started) {
            started = true;
            lastCutMs = clusterMs;
            currentNonKeyframe = false;

            return;
        }

        if (
            (audioOnly || firstVideoIsKey === true) &&
            clusterMs >= lastCutMs + options.targetMs - TOLERANCE_MS
        ) {
            cutAt(clusterMs, false, completed);
        } else if (
            !audioOnly &&
            firstVideoIsKey !== null &&
            clusterMs >= lastCutMs + options.maxMs
        ) {
            cutAt(clusterMs, !firstVideoIsKey, completed);
        }
    }

    function onBlock(
        track: number,
        relative: number,
        key: boolean,
        completed: CutSegment[],
    ): void {
        if (clusterTicks === null) {
            fail(
                `a block before the Cluster Timecode at byte ${position}`,
                completed,
            );
        }

        if (track === timingTrack()) {
            const blockMs = toMs(clusterTicks + relative);

            if (lastBlockMs !== null && blockMs > lastBlockMs) {
                lastGapMs = blockMs - lastBlockMs;
            }

            lastBlockMs = blockMs;
        }

        if (!decided && !audioOnly && track === videoTrack) {
            decide(key, completed);
        }
    }

    function closeCluster(completed: CutSegment[]): void {
        if (!decided && clusterTicks !== null) {
            // No video block in this Cluster: never a cut on a video track.
            decide(audioOnly ? true : null, completed);
        }

        phase = 'level1';
    }

    /** One step of the parser. False when it must wait for more bytes. */
    function step(completed: CutSegment[]): boolean {
        if (
            phase === 'cluster' &&
            clusterEnd !== null &&
            position >= clusterEnd
        ) {
            closeCluster(completed);

            return true;
        }

        const header = readHeader(position, completed);

        if (header === null) {
            return false;
        }

        if (phase === 'ebml') {
            if (header.id !== ID_EBML || header.size === null) {
                return fail(
                    'the stream does not start with a sized EBML header',
                    completed,
                );
            }

            position = header.data + header.size;
            phase = 'segment';

            return true;
        }

        if (phase === 'segment') {
            if (header.id !== ID_SEGMENT) {
                return fail('no Segment after the EBML header', completed);
            }

            position = header.data;
            phase = 'level1';

            return true;
        }

        if (phase === 'level1') {
            if (header.id === ID_CLUSTER) {
                if (!initReturned) {
                    completed.push({
                        kind: 'init',
                        bytes: copy(segmentStart, position),
                        startMs: 0,
                        durationMs: 0,
                        nonKeyframeStart: false,
                    });
                    initReturned = true;
                    segmentStart = position;
                }

                clusterStart = position;
                clusterEnd =
                    header.size === null ? null : header.data + header.size;
                clusterTicks = null;
                decided = false;
                position = header.data;
                phase = 'cluster';

                return true;
            }

            if (header.size === null) {
                return fail(
                    `level-1 element 0x${header.id.toString(16)} of unknown size at byte ${position}`,
                    completed,
                );
            }

            if (
                !initReturned &&
                (header.id === ID_INFO || header.id === ID_TRACKS)
            ) {
                if (header.data + header.size > end()) {
                    return false;
                }

                if (header.id === ID_INFO) {
                    readInfo(header, completed);
                } else {
                    readTracks(header, completed);
                }
            }

            position = header.data + header.size;

            return true;
        }

        // Inside a Cluster.
        if (clusterEnd === null && LEVEL1.has(header.id)) {
            closeCluster(completed);

            return true;
        }

        if (header.size === null) {
            return fail(
                `element of unknown size inside a Cluster at byte ${position}`,
                completed,
            );
        }

        const bodyEnd = header.data + header.size;

        if (header.id === ID_TIMECODE) {
            if (bodyEnd > end()) {
                return false;
            }

            clusterTicks = readUint(header.data, header.size);

            if (!started || audioOnly) {
                decide(audioOnly ? true : null, completed);
            }
        } else if (header.id === ID_SIMPLE_BLOCK) {
            const block = readBlockHeader(header.data, bodyEnd, completed);

            if (block === null) {
                return false;
            }

            onBlock(
                block.track,
                block.relative,
                (block.flags & 0x80) !== 0,
                completed,
            );
        } else if (header.id === ID_BLOCK_GROUP) {
            if (bodyEnd > end()) {
                return false;
            }

            let block: { track: number; relative: number } | null = null;
            let hasReference = false;

            for (const child of readChildren(header.data, bodyEnd, completed)) {
                if (child.id === ID_BLOCK) {
                    block = readBlockHeader(
                        child.data,
                        child.data + child.size!,
                        completed,
                    );
                } else if (child.id === ID_REFERENCE_BLOCK) {
                    hasReference = true;
                }
            }

            if (block !== null) {
                onBlock(block.track, block.relative, !hasReference, completed);
            }
        }

        position = bodyEnd;

        return true;
    }

    function parse(completed: CutSegment[]): void {
        while (step(completed)) {
            // Keep reading until the bytes run out.
        }
    }

    return {
        segmenting: 'cluster',

        push(chunk: Uint8Array): CutSegment[] {
            append(chunk);

            if (failed) {
                throw new CutterError('the cutter already met bad bytes', []);
            }

            const completed: CutSegment[] = [];
            parse(completed);

            return completed;
        },

        end(): CutSegment[] {
            if (failed) {
                throw new CutterError('the cutter already met bad bytes', []);
            }

            if (segmentStart >= end()) {
                return [];
            }

            const bytes = copy(segmentStart, end());
            segmentStart = end();

            if (!initReturned) {
                initReturned = true;

                return [
                    {
                        kind: 'init',
                        bytes,
                        startMs: 0,
                        durationMs: 0,
                        nonKeyframeStart: false,
                    },
                ];
            }

            const startMs = started ? lastCutMs : 0;
            const lastEnd =
                lastBlockMs === null ? startMs : lastBlockMs + lastGapMs;

            return [
                {
                    kind: 'media',
                    bytes,
                    startMs,
                    durationMs: Math.max(0, lastEnd - startMs),
                    nonKeyframeStart: currentNonKeyframe,
                },
            ];
        },

        pending(): Uint8Array {
            return copy(segmentStart, end());
        },

        initDone(): boolean {
            return initReturned;
        },
    };
}
