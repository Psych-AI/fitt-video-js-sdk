import { TOLERANCE_MS } from './ebml.ts';
import {
    CutterError,
    type CutOptions,
    type CutSegment,
    type Cutter,
} from './types.ts';

const INITIAL_CAPACITY = 65_536;
const NON_SYNC_BIT = 0x00010000;

interface Box {
    type: string;
    /** Absolute offset of the box's first byte. */
    start: number;
    /** Absolute offset of the payload. */
    data: number;
    /** Absolute offset just past the box. */
    end: number;
}

interface Track {
    id: number;
    handler: string;
    timescale: number;
    defaultDuration: number;
    defaultFlags: number;
}

/** What one moof says about the track that decides. */
interface FragmentTimes {
    startMs: number;
    endMs: number;
    /** Whether the first sample is a sync sample, or null when the traf has no sample. */
    sync: boolean | null;
}

/**
 * A streaming fragmented-MP4 reader that cuts before a moof whose first video sample is sync
 * (author's call 4). The video traf is found by its tfhd track_ID, never by position: WebKit
 * writes the audio traf first.
 */
export function createBmffCutter(options: CutOptions): Cutter {
    const audioOnly = options.audioOnly === true;

    let buffer = new Uint8Array(INITIAL_CAPACITY);
    /** Absolute offset of buffer[0]. */
    let base = 0;
    /** Valid bytes in the buffer. */
    let length = 0;
    /** Absolute parse position. It may run past the bytes received while a box is skipped. */
    let position = 0;
    let failed = false;

    /** Absolute offset of the current segment, not yet returned. */
    let segmentStart = 0;
    let initReturned = false;
    const tracks = new Map<number, Track>();
    let decidingTrack: number | null = null;

    let started = false;
    let lastCutMs = 0;
    let currentNonKeyframe = false;
    /** The end of the last fragment that carried the deciding track. */
    let lastEndMs: number | null = null;

    const end = (): number => base + length;
    const byteAt = (offset: number): number => buffer[offset - base];
    const copy = (from: number, to: number): Uint8Array =>
        buffer.slice(from - base, to - base);

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

    function u32(at: number): number {
        return (
            byteAt(at) * 0x1000000 +
            (byteAt(at + 1) << 16) +
            (byteAt(at + 2) << 8) +
            byteAt(at + 3)
        );
    }

    function u64(at: number): number {
        return u32(at) * 0x100000000 + u32(at + 4);
    }

    function typeAt(at: number): string {
        return String.fromCharCode(
            byteAt(at),
            byteAt(at + 1),
            byteAt(at + 2),
            byteAt(at + 3),
        );
    }

    /** The box header at `at`, or null when the buffer ends inside it. */
    function readBox(
        at: number,
        limit: number | null,
        completed: CutSegment[],
    ): Box | null {
        if (at + 8 > end()) {
            return null;
        }

        const size = u32(at);
        const type = typeAt(at + 4);
        let data = at + 8;
        let boxEnd: number;

        if (size === 0) {
            return fail(`a box of size 0 ("${type}") at byte ${at}`, completed);
        }

        if (size === 1) {
            if (at + 16 > end()) {
                return null;
            }

            data = at + 16;
            boxEnd = at + u64(at + 8);
        } else {
            boxEnd = at + size;
        }

        if (boxEnd < data) {
            return fail(
                `a box smaller than its header ("${type}") at byte ${at}`,
                completed,
            );
        }

        if (limit !== null && boxEnd > limit) {
            return fail(
                `a box overruns its parent ("${type}") at byte ${at}`,
                completed,
            );
        }

        return { type, start: at, data, end: boxEnd };
    }

    /** Every child of a box whose bytes are all in the buffer. */
    function children(parent: Box, completed: CutSegment[]): Box[] {
        const found: Box[] = [];
        let at = parent.data;

        while (at < parent.end) {
            const child = readBox(at, parent.end, completed);

            if (child === null) {
                return fail(
                    `a truncated box inside "${parent.type}" at byte ${at}`,
                    completed,
                );
            }

            found.push(child);
            at = child.end;
        }

        return found;
    }

    function child(
        parent: Box,
        type: string,
        completed: CutSegment[],
    ): Box | null {
        return (
            children(parent, completed).find((box) => box.type === type) ?? null
        );
    }

    /** A full box's version, and the absolute offset just past its version and flags. */
    function fullBox(
        box: Box,
        need: number | ((version: number) => number),
        completed: CutSegment[],
    ): { version: number; flags: number; body: number } {
        const version = box.data + 4 <= box.end ? byteAt(box.data) : 0;
        const bytes = typeof need === 'number' ? need : need(version);

        if (box.data + 4 + bytes > box.end) {
            return fail(
                `a "${box.type}" box too short to read at byte ${box.start}`,
                completed,
            );
        }

        return {
            version,
            flags: u32(box.data) & 0xffffff,
            body: box.data + 4,
        };
    }

    function readMoov(moov: Box, completed: CutSegment[]): void {
        const defaults = new Map<number, { duration: number; flags: number }>();

        for (const box of children(moov, completed)) {
            if (box.type === 'trak') {
                const tkhd = child(box, 'tkhd', completed);
                const mdia = child(box, 'mdia', completed);

                if (tkhd === null || mdia === null) {
                    continue;
                }

                const mdhd = child(mdia, 'mdhd', completed);
                const hdlr = child(mdia, 'hdlr', completed);

                if (mdhd === null || hdlr === null) {
                    continue;
                }

                const head = fullBox(tkhd, 20, completed);
                const media = fullBox(mdhd, 20, completed);
                const handler = fullBox(hdlr, 8, completed);
                const id = u32(head.body + (head.version === 1 ? 16 : 8));

                tracks.set(id, {
                    id,
                    handler: typeAt(handler.body + 4),
                    timescale: u32(media.body + (media.version === 1 ? 16 : 8)),
                    defaultDuration: 0,
                    defaultFlags: 0,
                });
            } else if (box.type === 'mvex') {
                for (const trex of children(box, completed)) {
                    if (trex.type !== 'trex') {
                        continue;
                    }

                    const fields = fullBox(trex, 20, completed);

                    defaults.set(u32(fields.body), {
                        duration: u32(fields.body + 8),
                        flags: u32(fields.body + 16),
                    });
                }
            }
        }

        for (const [id, values] of defaults) {
            const track = tracks.get(id);

            if (track !== undefined) {
                track.defaultDuration = values.duration;
                track.defaultFlags = values.flags;
            }
        }

        const all = [...tracks.values()];

        decidingTrack =
            all.find((track) => track.handler === 'vide')?.id ??
            (audioOnly
                ? (all.find((track) => track.handler === 'soun')?.id ?? null)
                : null);
    }

    /** The deciding track's times in this moof, or null when it has no traf for that track. */
    function readMoof(
        moof: Box,
        completed: CutSegment[],
    ): FragmentTimes | null {
        const track =
            decidingTrack === null ? undefined : tracks.get(decidingTrack);

        if (track === undefined || track.timescale === 0) {
            return null;
        }

        for (const traf of children(moof, completed)) {
            if (traf.type !== 'traf') {
                continue;
            }

            const parts = children(traf, completed);
            const tfhdBox = parts.find((box) => box.type === 'tfhd');

            if (tfhdBox === undefined) {
                return fail(
                    `a traf with no tfhd at byte ${traf.start}`,
                    completed,
                );
            }

            const tfhd = fullBox(tfhdBox, 4, completed);

            if (u32(tfhd.body) !== track.id) {
                continue;
            }

            let at = tfhd.body + 4;

            if (tfhd.flags & 0x01) {
                at += 8;
            }

            if (tfhd.flags & 0x02) {
                at += 4;
            }

            let defaultDuration = track.defaultDuration;
            let defaultFlags = track.defaultFlags;

            if (tfhd.flags & 0x08) {
                defaultDuration = u32(at);
                at += 4;
            }

            if (tfhd.flags & 0x10) {
                at += 4;
            }

            if (tfhd.flags & 0x20) {
                defaultFlags = u32(at);
                at += 4;
            }

            if (at > tfhdBox.end) {
                return fail(
                    `a tfhd shorter than its flags at byte ${tfhdBox.start}`,
                    completed,
                );
            }

            const tfdtBox = parts.find((box) => box.type === 'tfdt');

            if (tfdtBox === undefined) {
                return fail(
                    `a traf with no tfdt at byte ${traf.start}`,
                    completed,
                );
            }

            const tfdt = fullBox(
                tfdtBox,
                (version) => (version === 1 ? 8 : 4),
                completed,
            );
            const decodeTime =
                tfdt.version === 1 ? u64(tfdt.body) : u32(tfdt.body);

            let sync: boolean | null = null;
            let totalDuration = 0;

            for (const trunBox of parts) {
                if (trunBox.type !== 'trun') {
                    continue;
                }

                const trun = fullBox(trunBox, 4, completed);
                const count = u32(trun.body);
                let row = trun.body + 4;

                if (trun.flags & 0x01) {
                    row += 4;
                }

                let firstFlags: number | null = null;

                if (trun.flags & 0x04) {
                    firstFlags = u32(row);
                    row += 4;
                }

                const rowWidth =
                    ((trun.flags & 0x100) !== 0 ? 4 : 0) +
                    ((trun.flags & 0x200) !== 0 ? 4 : 0) +
                    ((trun.flags & 0x400) !== 0 ? 4 : 0) +
                    ((trun.flags & 0x800) !== 0 ? 4 : 0);

                if (row + count * rowWidth > trunBox.end) {
                    return fail(
                        `a trun shorter than its samples at byte ${trunBox.start}`,
                        completed,
                    );
                }

                for (let index = 0; index < count; index++) {
                    let duration = defaultDuration;
                    let flags: number | null = null;

                    if (trun.flags & 0x100) {
                        duration = u32(row);
                        row += 4;
                    }

                    if (trun.flags & 0x200) {
                        row += 4;
                    }

                    if (trun.flags & 0x400) {
                        flags = u32(row);
                        row += 4;
                    }

                    if (trun.flags & 0x800) {
                        row += 4;
                    }

                    if (sync === null) {
                        // Sample 0: first sample flags, then its own, then tfhd, then trex.
                        const sampleFlags =
                            (index === 0 ? firstFlags : null) ??
                            flags ??
                            defaultFlags;
                        sync = (sampleFlags & NON_SYNC_BIT) === 0;
                    }

                    totalDuration += duration;
                }
            }

            return {
                startMs: Math.round((decodeTime * 1000) / track.timescale),
                endMs: Math.round(
                    ((decodeTime + totalDuration) * 1000) / track.timescale,
                ),
                sync,
            };
        }

        return null;
    }

    function cutAt(
        moofStart: number,
        timeMs: number,
        nonKeyframe: boolean,
        completed: CutSegment[],
    ): void {
        completed.push({
            kind: 'media',
            bytes: copy(segmentStart, moofStart),
            startMs: lastCutMs,
            durationMs: timeMs - lastCutMs,
            nonKeyframeStart: currentNonKeyframe,
        });
        segmentStart = moofStart;
        lastCutMs = timeMs;
        currentNonKeyframe = nonKeyframe;
    }

    /** The cut rule of the EBML cutter, with "sync" for "keyframe" (author's call 4). */
    function decide(
        moof: Box,
        times: FragmentTimes | null,
        completed: CutSegment[],
    ): void {
        if (times !== null) {
            lastEndMs = times.endMs;
        }

        if (!started) {
            started = true;
            lastCutMs = times?.startMs ?? 0;
            currentNonKeyframe = false;

            return;
        }

        if (times === null || times.sync === null) {
            // No sample of the deciding track in this moof: never a cut.
            return;
        }

        if (
            (audioOnly || times.sync) &&
            times.startMs >= lastCutMs + options.targetMs - TOLERANCE_MS
        ) {
            cutAt(moof.start, times.startMs, false, completed);
        } else if (!audioOnly && times.startMs >= lastCutMs + options.maxMs) {
            cutAt(moof.start, times.startMs, !times.sync, completed);
        }
    }

    /** One step of the parser. False when it must wait for more bytes. */
    function step(completed: CutSegment[]): boolean {
        const box = readBox(position, null, completed);

        if (box === null) {
            return false;
        }

        if (box.type === 'moof') {
            if (box.end > end()) {
                return false;
            }

            if (!initReturned) {
                completed.push({
                    kind: 'init',
                    bytes: copy(segmentStart, box.start),
                    startMs: 0,
                    durationMs: 0,
                    nonKeyframeStart: false,
                });
                initReturned = true;
                segmentStart = box.start;
            }

            decide(box, readMoof(box, completed), completed);
        } else if (box.type === 'moov' && !initReturned) {
            if (box.end > end()) {
                return false;
            }

            readMoov(box, completed);
        }

        position = box.end;

        return true;
    }

    function parse(completed: CutSegment[]): void {
        while (step(completed)) {
            // Keep reading until the bytes run out.
        }
    }

    return {
        segmenting: 'moof',

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

            return [
                {
                    kind: 'media',
                    bytes,
                    startMs,
                    durationMs: Math.max(0, (lastEndMs ?? startMs) - startMs),
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
