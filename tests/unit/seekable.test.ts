import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seekableHead, type SeekablePart } from '../../src/cut/seekable.ts';
import { createCutter } from '../../src/cut/select.ts';
import type { CutSegment } from '../../src/cut/types.ts';
import { concat, readSet } from '../support/fixtures.ts';

/** A fixture set cut as a run cuts it (5 s target, 30 s max), as its init and its media parts. */
function cutSet(
    name: string,
    audioOnly = false,
): {
    mime: string;
    init: Uint8Array;
    media: SeekablePart[];
} {
    const set = readSet(name);
    let fellBack = false;
    const cutter = createCutter(
        set.mimeType,
        { targetMs: 5000, maxMs: 30_000, audioOnly },
        () => {
            fellBack = true;
        },
    );
    const cut: CutSegment[] = [];
    set.blobs.forEach((blob, index) =>
        cut.push(...cutter.push(blob, index * 5000)),
    );
    cut.push(...cutter.end(set.blobs.length * 5000));
    assert.equal(fellBack, false, `${name} fell back to raw groups`);
    const [init, ...media] = cut;

    return {
        mime: set.mimeType,
        init: init.bytes,
        media: media.map((segment) => ({
            bytes: segment.bytes,
            startMs: segment.startMs,
            durationMs: segment.durationMs,
            nonKeyframeStart: segment.nonKeyframeStart,
        })),
    };
}

/* A small EBML reader, independent of src on purpose: it checks the writer. */

interface El {
    id: number;
    at: number;
    data: number;
    /** null for an unknown size. */
    size: number | null;
}

function width(first: number): number {
    let w = 1;

    while (w <= 8 && !(first & (0x80 >> (w - 1)))) {
        w++;
    }

    return w;
}

function header(bytes: Uint8Array, at: number): El {
    const idWidth = width(bytes[at]);
    let id = 0;

    for (let i = 0; i < idWidth; i++) {
        id = id * 256 + bytes[at + i];
    }

    const sizeAt = at + idWidth;
    const sizeWidth = width(bytes[sizeAt]);
    let size = bytes[sizeAt] & (0xff >> sizeWidth);
    let ones = size === 0xff >> sizeWidth;

    for (let i = 1; i < sizeWidth; i++) {
        size = size * 256 + bytes[sizeAt + i];
        ones &&= bytes[sizeAt + i] === 0xff;
    }

    return { id, at, data: sizeAt + sizeWidth, size: ones ? null : size };
}

function kids(bytes: Uint8Array, parent: El): El[] {
    const out: El[] = [];

    for (let at = parent.data; at < parent.data + (parent.size ?? 0);) {
        const child = header(bytes, at);
        out.push(child);
        at = child.data + (child.size ?? 0);
    }

    return out;
}

function uint(bytes: Uint8Array, el: El): number {
    let value = 0;

    for (let i = 0; i < (el.size ?? 0); i++) {
        value = value * 256 + bytes[el.data + i];
    }

    return value;
}

function float(bytes: Uint8Array, el: El): number {
    const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + el.data,
        el.size ?? 0,
    );

    return el.size === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const CUES = 0x1c53bb6b;
const CLUSTER = 0x1f43b675;

/** The Segment's data start, its children up to the first Cluster, and the file's Duration and cues. */
function readWebm(file: Uint8Array): {
    segmentData: number;
    segmentSize: number | null;
    order: number[];
    durationTicks: number;
    cues: { time: number; track: number; position: number }[];
} {
    const ebml = header(file, 0);
    const segment = header(file, ebml.data + (ebml.size ?? 0));
    assert.equal(segment.id, SEGMENT);
    const order: number[] = [];
    let durationTicks = Number.NaN;
    const cues: { time: number; track: number; position: number }[] = [];

    for (let at = segment.data; ;) {
        const child = header(file, at);

        if (child.id === CLUSTER) {
            break;
        }

        order.push(child.id);

        if (child.id === INFO) {
            const duration = kids(file, child).find((kid) => kid.id === 0x4489);
            durationTicks =
                duration === undefined ? Number.NaN : float(file, duration);
        }

        if (child.id === CUES) {
            for (const point of kids(file, child)) {
                const [time, positions] = kids(file, point);
                const [track, position] = kids(file, positions);
                cues.push({
                    time: uint(file, time),
                    track: uint(file, track),
                    position: uint(file, position),
                });
            }
        }

        at = child.data + (child.size ?? 0);
    }

    return {
        segmentData: segment.data,
        segmentSize: segment.size,
        order,
        durationTicks,
        cues,
    };
}

/** The Timecode (0xE7) of the Cluster at `at`. */
function clusterTime(file: Uint8Array, at: number): number {
    const cluster = header(file, at);
    assert.equal(cluster.id, CLUSTER, `a Cluster at ${at}`);
    const timecode = header(file, cluster.data);
    assert.equal(timecode.id, 0xe7);

    return uint(file, timecode);
}

const WEBM_CASES = [
    { set: 'chrome-vp8-kf', head: 1054, cues: 12, endMs: 60_004 },
    { set: 'chrome-vp9-kf', head: 1054, cues: 12, endMs: 59_989 },
    { set: 'chrome-vp8-nokf', head: 847, cues: 9, endMs: 60_005 },
    { set: 'firefox-vp8', head: 872, cues: 8, endMs: 60_006 },
];

test('a WebM head adds Duration and one cue per keyframe segment, and every cue lands on its Cluster', () => {
    for (const expected of WEBM_CASES) {
        const { mime, init, media } = cutSet(expected.set);
        const head = seekableHead(mime, init, media);
        assert.ok(head !== null, expected.set);
        assert.equal(head.byteLength, expected.head, `${expected.set} head`);

        const file = concat([head, ...media.map((part) => part.bytes)]);
        const read = readWebm(file);

        assert.equal(
            read.segmentSize,
            null,
            `${expected.set} keeps an unknown Segment size`,
        );
        assert.deepEqual(
            read.order,
            [INFO, TRACKS, CUES],
            `${expected.set} has no SeekHead`,
        );
        // TimecodeScale is 1,000,000 in every fixture, so ticks are milliseconds.
        assert.equal(read.durationTicks, expected.endMs);
        assert.equal(read.cues.length, expected.cues);
        assert.deepEqual(
            read.cues.map((cue) => cue.time),
            media.map((part) => part.startMs),
        );

        for (const cue of read.cues) {
            assert.equal(cue.track, 1);
            assert.equal(
                clusterTime(file, read.segmentData + cue.position),
                cue.time,
            );
        }

        assert.equal(header(file, head.byteLength).id, CLUSTER);
        assert.equal(
            Buffer.compare(
                Buffer.from(file.subarray(head.byteLength)),
                Buffer.from(concat(media.map((part) => part.bytes))),
            ),
            0,
            `${expected.set} media bytes unchanged`,
        );
    }
});

test('a segment cut past max_ms gets no cue', () => {
    const { mime, init, media } = cutSet('chrome-vp8-kf');
    media[3] = { ...media[3], nonKeyframeStart: true };
    const head = seekableHead(mime, init, media);
    assert.ok(head !== null);
    const file = concat([head, ...media.map((part) => part.bytes)]);
    const read = readWebm(file);

    assert.equal(head.byteLength, 1054 - 69);
    assert.equal(read.cues.length, 11);
    assert.equal(
        read.cues.some((cue) => cue.time === 15_058),
        false,
    );

    for (const cue of read.cues) {
        assert.equal(
            clusterTime(file, read.segmentData + cue.position),
            cue.time,
        );
    }
});

test('an init that is not WebM, or a type that is neither WebM nor MP4, gives null', () => {
    const { init, media } = cutSet('chrome-vp8-kf');

    assert.equal(
        seekableHead('video/webm', new Uint8Array([1, 2, 3]), media),
        null,
    );
    assert.equal(seekableHead('video/x-unknown', init, media), null);
});

/* A small ISO BMFF reader for the MP4 cases. */

interface Box {
    type: string;
    at: number;
    end: number;
}

function boxes(bytes: Uint8Array, from: number, to: number): Box[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const out: Box[] = [];

    for (let at = from; at < to;) {
        const size = view.getUint32(at);
        out.push({
            type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
            at,
            end: at + size,
        });
        at += size;
    }

    return out;
}

function u32(bytes: Uint8Array, at: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
}

function u64(bytes: Uint8Array, at: number): number {
    return Number(
        new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at),
    );
}

/** The sidx box's fields (version 1). */
function readSidx(bytes: Uint8Array, box: Box) {
    const at = box.at + 12;
    const count = new DataView(bytes.buffer, bytes.byteOffset).getUint16(
        at + 26,
    );
    const refs = Array.from({ length: count }, (_, i) => ({
        size: u32(bytes, at + 28 + i * 12) & 0x7fffffff,
        duration: u32(bytes, at + 32 + i * 12),
        sap: u32(bytes, at + 36 + i * 12),
    }));

    return {
        version: bytes[box.at + 8],
        referenceId: u32(bytes, at),
        timescale: u32(bytes, at + 4),
        earliest: u64(bytes, at + 8),
        firstOffset: u64(bytes, at + 16),
        refs,
    };
}

test('a fragmented MP4 head adds mehd and a sidx over every media segment', () => {
    const { mime, init, media } = cutSet('webkit-mp4');
    const head = seekableHead(mime, init, media);
    assert.ok(head !== null);
    assert.equal(head.byteLength, 1339);

    const file = concat([head, ...media.map((part) => part.bytes)]);
    const top = boxes(file, 0, head.byteLength);
    assert.deepEqual(
        top.map((box) => box.type),
        ['ftyp', 'moov', 'sidx'],
    );
    const moov = top[1];
    assert.equal(moov.end - moov.at, 1127);

    const mvex = boxes(file, moov.at + 8, moov.end).find(
        (box) => box.type === 'mvex',
    )!;
    const mvexKids = boxes(file, mvex.at + 8, mvex.end);
    assert.deepEqual(
        mvexKids.map((box) => box.type),
        ['mehd', 'trex', 'trex'],
    );
    const mehd = mvexKids[0];
    assert.equal(mehd.end - mehd.at, 20);
    assert.equal(file[mehd.at + 8], 1);
    // round(60,043 ms x 600 / 1000)
    assert.equal(u64(file, mehd.at + 12), 36_026);

    const sidx = readSidx(file, top[2]);
    assert.equal(top[2].end - top[2].at, 40 + 12 * media.length);
    assert.deepEqual(
        [
            sidx.version,
            sidx.referenceId,
            sidx.timescale,
            sidx.earliest,
            sidx.firstOffset,
        ],
        [1, 2, 600, 26, 0],
    );
    assert.deepEqual(
        sidx.refs.map((ref) => ref.size),
        media.map((part) => part.bytes.byteLength),
    );
    assert.equal(
        sidx.refs.reduce((sum, ref) => sum + ref.duration, 0),
        36_026 - 26,
    );
    assert.ok(sidx.refs.every((ref) => ref.sap === 0x90000000));

    assert.equal(
        boxes(file, head.byteLength, head.byteLength + 8)[0].type,
        'moof',
    );
    assert.equal(
        Buffer.compare(
            Buffer.from(file.subarray(head.byteLength)),
            Buffer.from(concat(media.map((part) => part.bytes))),
        ),
        0,
    );
});

test('a segment that does not start on a sync sample has no SAP', () => {
    const { mime, init, media } = cutSet('webkit-mp4');
    media[2] = { ...media[2], nonKeyframeStart: true };
    const head = seekableHead(mime, init, media)!;
    const sidx = readSidx(head, boxes(head, 0, head.byteLength)[2]);

    assert.deepEqual(
        sidx.refs.map((ref) => ref.sap),
        media.map((_, i) => (i === 2 ? 0 : 0x90000000)),
    );
});

test('an MP4 init with no moov, no mvex, no video or audio track or no media gives null', () => {
    const { mime, init, media } = cutSet('webkit-mp4');
    // The positive control: this init does make a head (fails before this task).
    assert.notEqual(seekableHead(mime, init, media), null);

    // Measured: ftyp 0 to 28; moov at 28 (1107 bytes); the audio trak's hdlr at 284, the video trak's at 712; mvex at 1063 (72 bytes, moov's last child).
    const noMvex = init.slice(0, 1063);
    new DataView(noMvex.buffer).setUint32(28, 1107 - 72);
    // With no vide trak the head falls back to the soun trak (Plan 10, author's call 6), so both handlers become 'text'.
    const noVideo = init.slice();
    noVideo.set([0x74, 0x65, 0x78, 0x74], 712 + 16); // handler_type 'text'
    noVideo.set([0x74, 0x65, 0x78, 0x74], 284 + 16); // handler_type 'text'

    assert.equal(seekableHead(mime, init.subarray(0, 28), media), null);
    assert.equal(seekableHead(mime, noMvex, media), null);
    assert.equal(seekableHead(mime, noVideo, media), null);
    assert.equal(seekableHead(mime, init, []), null);
});

/** An aligned fixture set as its parts: seq 0 the init, then each media segment with its manifest times. */
function alignedSet(name: string): {
    mime: string;
    init: Uint8Array;
    media: SeekablePart[];
} {
    const set = readSet(name);
    const [init, ...media] = set.blobs;

    return {
        mime: set.mimeType,
        init,
        media: media.map((bytes, i) => ({
            bytes,
            startMs: set.fragments[i + 1].start_ms,
            durationMs: set.fragments[i + 1].duration_ms,
            nonKeyframeStart: false,
        })),
    };
}

test('an Opus-only WebM head cues the audio track on every segment, and every cue lands on its Cluster', () => {
    const { mime, init, media } = alignedSet('chrome-opus-audio');
    const head = seekableHead(mime, init, media);
    assert.ok(head !== null);
    const file = concat([head, ...media.map((part) => part.bytes)]);
    const read = readWebm(file);
    const last = media[media.length - 1];

    assert.equal(read.segmentSize, null);
    assert.equal(read.order.includes(CUES), true);
    assert.equal(read.cues.length, media.length);
    assert.equal(read.durationTicks, last.startMs + last.durationMs);
    assert.equal(new Set(read.cues.map((cue) => cue.track)).size, 1);
    assert.ok(read.cues[0].track >= 1);

    for (const cue of read.cues) {
        assert.equal(
            clusterTime(file, read.segmentData + cue.position),
            cue.time,
        );
    }
});

/** The top-level boxes of an MP4 head: type, start and size. */
function topBoxes(
    bytes: Uint8Array,
): { type: string; at: number; size: number }[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: { type: string; at: number; size: number }[] = [];

    for (let at = 0; at + 8 <= bytes.byteLength;) {
        const size = view.getUint32(at);
        out.push({
            type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
            at,
            size,
        });
        at += size;
    }

    return out;
}

test('an AAC-only MP4 head indexes the soun track with a sidx over every media segment', () => {
    const { mime, init, media } = cutSet('webkit-aac-audio', true);
    const head = seekableHead(mime, init, media);
    assert.ok(head !== null);
    const boxes = topBoxes(head);
    const sidx = boxes.find((one) => one.type === 'sidx');
    assert.ok(sidx !== undefined);
    assert.equal(boxes[boxes.length - 1].type, 'sidx');
    const view = new DataView(
        head.buffer,
        head.byteOffset + sidx.at,
        sidx.size,
    );

    // Version 1: reference_ID at 12, timescale at 16, reference_count at 38.
    assert.equal(view.getUint32(12), 1);
    assert.equal(view.getUint32(16), 48_000);
    assert.equal(view.getUint16(38), media.length);
});
