import { concat } from './fixtures.ts';

/** A body part: bytes as they are, a string as ASCII, a number as a big-endian unsigned integer. */
export type BodyPart = Uint8Array | string | number;

const UNKNOWN_SIZE = Uint8Array.of(
    0x01,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
);

/** The ID's bytes, big-endian, with no leading zero bytes. */
export function idBytes(id: number): Uint8Array {
    const bytes: number[] = [];
    let rest = id;

    do {
        bytes.unshift(rest & 0xff);
        rest = Math.floor(rest / 256);
    } while (rest > 0);

    return Uint8Array.from(bytes);
}

/** The shortest EBML size vint that can hold `size` without using the all-ones (unknown) value. */
export function sizeBytes(size: number): Uint8Array {
    for (let width = 1; width <= 8; width++) {
        if (size < 2 ** (7 * width) - 1) {
            const bytes = new Uint8Array(width);
            let rest = size;

            for (let index = width - 1; index >= 0; index--) {
                bytes[index] = rest % 256;
                rest = Math.floor(rest / 256);
            }

            bytes[0] |= 0x80 >> (width - 1);

            return bytes;
        }
    }

    throw new RangeError(`size ${size} needs more than 8 bytes`);
}

/** Big-endian, at least one byte. */
export function uintBytes(value: number): Uint8Array {
    return idBytes(value);
}

function bodyBytes(part: BodyPart): Uint8Array {
    if (typeof part === 'number') {
        return uintBytes(part);
    }

    if (typeof part === 'string') {
        return Uint8Array.from(part, (char) => char.charCodeAt(0));
    }

    return part;
}

/** One element: its ID, the size of its body, then the body. */
export function element(id: number, ...body: BodyPart[]): Uint8Array {
    const content = concat(body.map(bodyBytes));

    return concat([idBytes(id), sizeBytes(content.byteLength), content]);
}

/** A WebM with one Opus track and an unknown-size Cluster at each time, each holding one key SimpleBlock. */
export function audioOnlyStream(clusterTimesMs: number[]): Uint8Array {
    const parts: Uint8Array[] = [
        element(0x1a45dfa3, element(0x4282, 'webm')),
        idBytes(0x18538067),
        UNKNOWN_SIZE,
        element(0x1549a966, element(0x2ad7b1, uintBytes(1_000_000))),
        element(
            0x1654ae6b,
            element(
                0xae,
                element(0xd7, 1),
                element(0x83, 2),
                element(0x86, 'A_OPUS'),
            ),
        ),
    ];

    for (const time of clusterTimesMs) {
        parts.push(
            idBytes(0x1f43b675),
            UNKNOWN_SIZE,
            element(0xe7, uintBytes(time)),
            element(
                0xa3,
                Uint8Array.of(0x81, 0x00, 0x00, 0x80, 0xfc, 0xff, 0xfe),
            ),
        );
    }

    return concat(parts);
}

/** The EBML header ID followed by a size whose first byte is 0x00, which no valid stream holds. */
export function badSizeStream(): Uint8Array {
    return Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00);
}
