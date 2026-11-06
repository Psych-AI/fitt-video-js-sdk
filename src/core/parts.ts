import { sha256Hex } from './crypto.ts';

/**
 * Splitting a segment into parts (spec 6.3, author's call 8). A segment is
 * split only when it is larger than `part_size`; each part is at most
 * `part_size`, counting from 0. A segment of at most `part_size` (an empty
 * one too) is one request, never part 0 of 1.
 */
export function partCount(bytes: number, partSize: number): number {
    return Math.max(1, Math.ceil(bytes / partSize));
}

/** One part at a time, each hashed as it is cut. */
export async function* partsOf(
    data: ArrayBuffer,
    partSize: number,
): AsyncGenerator<{
    index: number;
    count: number;
    bytes: ArrayBuffer;
    sha256: string;
}> {
    const count = partCount(data.byteLength, partSize);

    for (let index = 0; index < count; index++) {
        const start = index * partSize;
        const bytes = data.slice(
            start,
            Math.min(start + partSize, data.byteLength),
        );

        // Awaited before it is yielded, so a large segment never holds every part hashed at once.
        yield { index, count, bytes, sha256: await sha256Hex(bytes) };
    }
}
