/** sample_depends_on 2: an I frame. The cutter reads only the non-sync bit. */
export const SYNC = 0x02000000;
/** sample_is_non_sync_sample set. */
export const NON_SYNC = 0x00010000;

type Part = Uint8Array | string;

const AUDIO_TRACK = 1;
const VIDEO_TRACK = 2;

function bytesOf(part: Part): Uint8Array {
    return typeof part === 'string' ? new TextEncoder().encode(part) : part;
}

function join(parts: Part[]): Uint8Array {
    const chunks = parts.map(bytesOf);
    const out = new Uint8Array(
        chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    let offset = 0;

    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return out;
}

/** A big-endian 32-bit value. */
export function u32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value);

    return out;
}

/** A big-endian 64-bit value. */
export function u64(value: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value));

    return out;
}

function zeros(count: number): Uint8Array {
    return new Uint8Array(count);
}

/** A box with a 32-bit size. */
export function box(type: string, ...payload: Part[]): Uint8Array {
    const body = join(payload);

    return join([u32(8 + body.byteLength), type, body]);
}

/** A box with size 1 and a 64-bit largesize. */
export function largeBox(type: string, ...payload: Part[]): Uint8Array {
    const body = join(payload);

    return join([u32(1), type, u64(16 + body.byteLength), body]);
}

/** A box whose payload starts with a version byte and 24 bits of flags. */
export function fullBox(
    type: string,
    version: number,
    flags: number,
    ...payload: Part[]
): Uint8Array {
    return box(type, u32(version * 0x1000000 + flags), ...payload);
}

function trak(trackId: number, handler: string, timescale: number): Uint8Array {
    return box(
        'trak',
        fullBox('tkhd', 0, 3, u32(0), u32(0), u32(trackId), zeros(68)),
        box(
            'mdia',
            fullBox(
                'mdhd',
                0,
                0,
                u32(0),
                u32(0),
                u32(timescale),
                u32(0),
                zeros(4),
            ),
            fullBox('hdlr', 0, 0, u32(0), handler, zeros(12), zeros(1)),
        ),
    );
}

function trex(trackId: number, defaultFlags: number): Uint8Array {
    return fullBox(
        'trex',
        0,
        0,
        u32(trackId),
        u32(1),
        u32(0),
        u32(0),
        u32(defaultFlags),
    );
}

/** An init laid out like WebKit's: track 1 audio at 48000, track 2 video at 600. */
export function initSegment(trexVideoFlags = NON_SYNC): Uint8Array {
    return join([
        box('ftyp', 'iso5', u32(512), 'iso5isom'),
        box(
            'moov',
            fullBox('mvhd', 0, 0, zeros(96)),
            trak(AUDIO_TRACK, 'soun', 48000),
            trak(VIDEO_TRACK, 'vide', 600),
            box(
                'mvex',
                trex(AUDIO_TRACK, 0),
                trex(VIDEO_TRACK, trexVideoFlags),
            ),
        ),
    ]);
}

export interface VideoFragment {
    tfdt: number;
    samples: number;
    duration: number;
    firstSampleFlags?: number;
    sampleFlags?: number[];
    tfhdDefaultFlags?: number;
    tfdtVersion?: 0 | 1;
}

/** One moof (the audio traf first, as WebKit writes it, then the video traf) and a 16-byte mdat. */
export function fragment(video: VideoFragment): Uint8Array {
    const audioTraf = box(
        'traf',
        fullBox('tfhd', 0, 0x020000, u32(AUDIO_TRACK)),
        fullBox('tfdt', 1, 0, u64(0)),
        fullBox('trun', 0, 0x000100, u32(1), u32(1024)),
    );

    const tfhd =
        video.tfhdDefaultFlags === undefined
            ? fullBox('tfhd', 0, 0x020000, u32(VIDEO_TRACK))
            : fullBox(
                  'tfhd',
                  0,
                  0x020020,
                  u32(VIDEO_TRACK),
                  u32(video.tfhdDefaultFlags),
              );

    const tfdt =
        video.tfdtVersion === 0
            ? fullBox('tfdt', 0, 0, u32(video.tfdt))
            : fullBox('tfdt', 1, 0, u64(video.tfdt));

    let trunFlags = 0x000100;
    const rows: Uint8Array[] = [u32(video.samples)];

    if (video.firstSampleFlags !== undefined) {
        trunFlags |= 0x000004;
        rows.push(u32(video.firstSampleFlags));
    }

    if (video.sampleFlags !== undefined) {
        trunFlags |= 0x000400;
    }

    for (let index = 0; index < video.samples; index++) {
        rows.push(u32(video.duration));

        if (video.sampleFlags !== undefined) {
            rows.push(u32(video.sampleFlags[index]));
        }
    }

    const videoTraf = box(
        'traf',
        tfhd,
        tfdt,
        fullBox('trun', 0, trunFlags, ...rows),
    );

    return join([
        box('moof', fullBox('mfhd', 0, 0, u32(1)), audioTraf, videoTraf),
        box('mdat', zeros(16)),
    ]);
}
