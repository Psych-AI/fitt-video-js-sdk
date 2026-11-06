/**
 * A small whole-buffer WebM reader for tests. It is independent of src/cut on purpose:
 * it checks the cutter instead of sharing its code.
 */

const CLUSTER = 0x1f43b675;
const LEVEL1 = new Set([
    0x1f43b675, 0x1549a966, 0x1654ae6b, 0x1c53bb6b, 0x114d9b74, 0x1254c367,
    0x1941a469, 0x1043a770,
]);

interface Header {
    id: number;
    /** Offset of the body. */
    data: number;
    /** Body size, or null when unknown. */
    size: number | null;
}

function vintWidth(first: number, max: number, offset: number): number {
    for (let width = 1; width <= max; width++) {
        if (first & (0x80 >> (width - 1))) {
            return width;
        }
    }

    throw new Error(`bad vint at ${offset}`);
}

function readHeader(bytes: Uint8Array, offset: number): Header {
    const idWidth = vintWidth(bytes[offset], 4, offset);
    let id = 0;

    for (let index = 0; index < idWidth; index++) {
        id = id * 256 + bytes[offset + index];
    }

    const sizeAt = offset + idWidth;
    const sizeWidth = vintWidth(bytes[sizeAt], 8, sizeAt);
    let size = bytes[sizeAt] & (0xff >> sizeWidth);
    let allOnes = size === 0xff >> sizeWidth;

    for (let index = 1; index < sizeWidth; index++) {
        size = size * 256 + bytes[sizeAt + index];
        allOnes &&= bytes[sizeAt + index] === 0xff;
    }

    return { id, data: sizeAt + sizeWidth, size: allOnes ? null : size };
}

function readUint(bytes: Uint8Array, offset: number, size: number): number {
    let value = 0;

    for (let index = 0; index < size; index++) {
        value = value * 256 + bytes[offset + index];
    }

    return value;
}

/** Track number vint (marker masked off) and its width. */
function readTrackNumber(
    bytes: Uint8Array,
    offset: number,
): { track: number; width: number } {
    const width = vintWidth(bytes[offset], 8, offset);
    let track = bytes[offset] & (0xff >> width);

    for (let index = 1; index < width; index++) {
        track = track * 256 + bytes[offset + index];
    }

    return { track, width };
}

function* children(
    bytes: Uint8Array,
    start: number,
    end: number,
): Generator<Header> {
    let offset = start;

    while (offset < end) {
        const header = readHeader(bytes, offset);

        if (header.size === null) {
            throw new Error(`unknown size child at ${offset}`);
        }

        yield header;
        offset = header.data + header.size;
    }
}

/** The offset of the Segment's first level-1 child. */
function segmentStart(bytes: Uint8Array): number {
    const ebml = readHeader(bytes, 0);
    const segment = readHeader(bytes, ebml.data + (ebml.size ?? 0));

    return segment.data;
}

export interface TrackInfo {
    number: number;
    type: number;
    channels: number | null;
}

/** Every TrackEntry before the first Cluster. */
export function tracksOf(bytes: Uint8Array): TrackInfo[] {
    const tracks: TrackInfo[] = [];
    let offset = segmentStart(bytes);

    while (offset < bytes.byteLength) {
        const header = readHeader(bytes, offset);

        if (header.id === CLUSTER || header.size === null) {
            break;
        }

        if (header.id === 0x1654ae6b) {
            for (const entry of children(
                bytes,
                header.data,
                header.data + header.size,
            )) {
                if (entry.id !== 0xae) {
                    continue;
                }

                const track: TrackInfo = { number: 0, type: 0, channels: null };

                for (const field of children(
                    bytes,
                    entry.data,
                    entry.data + entry.size!,
                )) {
                    if (field.id === 0xd7) {
                        track.number = readUint(bytes, field.data, field.size!);
                    } else if (field.id === 0x83) {
                        track.type = readUint(bytes, field.data, field.size!);
                    } else if (field.id === 0xe1) {
                        for (const audio of children(
                            bytes,
                            field.data,
                            field.data + field.size!,
                        )) {
                            if (audio.id === 0x9f) {
                                track.channels = readUint(
                                    bytes,
                                    audio.data,
                                    audio.size!,
                                );
                            }
                        }
                    }
                }

                tracks.push(track);
            }
        }

        offset = header.data + header.size;
    }

    return tracks;
}

/** The Channels of the first audio track. */
export function audioChannels(init: Uint8Array): number | null {
    return tracksOf(init).find((track) => track.type === 2)?.channels ?? null;
}

function firstClusterOffset(bytes: Uint8Array): number {
    let offset = segmentStart(bytes);

    while (offset < bytes.byteLength) {
        const header = readHeader(bytes, offset);

        if (header.id === CLUSTER || header.size === null) {
            return offset;
        }

        offset = header.data + header.size;
    }

    return offset;
}

/** Every block of the video track, in stream order, with its time in ms (TimecodeScale 1 ms assumed). */
export function* videoBlocks(
    bytes: Uint8Array,
    videoTrack?: number,
    from?: number,
): Generator<{ timeMs: number; key: boolean }> {
    const track =
        videoTrack ?? tracksOf(bytes).find((entry) => entry.type === 1)?.number;

    if (track === undefined) {
        return;
    }

    let offset = from ?? firstClusterOffset(bytes);

    while (offset < bytes.byteLength) {
        const cluster = readHeader(bytes, offset);

        if (cluster.id !== CLUSTER) {
            if (cluster.size === null) {
                return;
            }

            offset = cluster.data + cluster.size;
            continue;
        }

        const end =
            cluster.size === null
                ? bytes.byteLength
                : cluster.data + cluster.size;
        let clusterTime = 0;
        let inner = cluster.data;

        while (inner < end) {
            const child = readHeader(bytes, inner);

            if (cluster.size === null && LEVEL1.has(child.id)) {
                break;
            }

            const size = child.size ?? 0;

            if (child.id === 0xe7) {
                clusterTime = readUint(bytes, child.data, size);
            } else if (child.id === 0xa3) {
                const { track: number, width } = readTrackNumber(
                    bytes,
                    child.data,
                );

                if (number === track) {
                    yield {
                        timeMs:
                            clusterTime + relative(bytes, child.data + width),
                        key: (bytes[child.data + width + 2] & 0x80) !== 0,
                    };
                }
            } else if (child.id === 0xa0) {
                let blockTrack: number | null = null;
                let blockTime = 0;
                let hasReference = false;

                for (const part of children(
                    bytes,
                    child.data,
                    child.data + size,
                )) {
                    if (part.id === 0xa1) {
                        const { track: number, width } = readTrackNumber(
                            bytes,
                            part.data,
                        );
                        blockTrack = number;
                        blockTime = relative(bytes, part.data + width);
                    } else if (part.id === 0xfb) {
                        hasReference = true;
                    }
                }

                if (blockTrack === track) {
                    yield {
                        timeMs: clusterTime + blockTime,
                        key: !hasReference,
                    };
                }
            }

            inner = child.data + size;
        }

        offset = inner;
    }
}

function relative(bytes: Uint8Array, offset: number): number {
    const value = (bytes[offset] << 8) | bytes[offset + 1];

    return value >= 0x8000 ? value - 0x10000 : value;
}

/** Whether the segment's first block of the init's video track is a keyframe. */
export function firstVideoBlockIsKey(
    init: Uint8Array,
    segment: Uint8Array,
): boolean {
    const track = tracksOf(init).find((entry) => entry.type === 1)?.number;

    if (track === undefined) {
        return false;
    }

    for (const block of videoBlocks(segment, track, 0)) {
        return block.key;
    }

    return false;
}
