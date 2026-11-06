import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The spike's real recordings (author's call 3).
 * Plan 4 moves them under tests/Fixtures/recordings/: change this one line then.
 */
export const FIXTURES_DIR = fileURLToPath(
    new URL(
        '../../../../docs/superpowers/spikes/2026-11-stitching/fixtures/',
        import.meta.url,
    ),
);

export interface FixtureFragment {
    seq: number;
    file: string;
    bytes: number;
    sha256: string;
    start_ms: number;
    duration_ms: number;
    kind?: 'init' | 'media';
}

export interface FixtureSet {
    name: string;
    mimeType: string;
    fragments: FixtureFragment[];
    blobs: Uint8Array[];
    whole: Uint8Array;
}

interface FixtureManifest {
    result: { mimeTypeActual: string };
    fragments: FixtureFragment[];
}

function readBytes(path: string): Uint8Array {
    const buffer = readFileSync(path);

    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function readManifest(name: string): FixtureManifest {
    return JSON.parse(
        readFileSync(`${FIXTURES_DIR}${name}/manifest.json`, 'utf8'),
    ) as FixtureManifest;
}

/** The parts joined into one new buffer. */
export function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;

    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }

    return out;
}

/** A fixture set: its manifest, each fragment file as one blob in manifest order, and all of them joined. */
export function readSet(name: string): FixtureSet {
    const manifest = readManifest(name);
    const blobs = manifest.fragments.map((fragment) =>
        readBytes(`${FIXTURES_DIR}${name}/fragments/${fragment.file}`),
    );

    return {
        name,
        mimeType: manifest.result.mimeTypeActual,
        fragments: manifest.fragments,
        blobs,
        whole: concat(blobs),
    };
}

/** The set's init.bin. */
export function initBin(name: string): Uint8Array {
    return readBytes(`${FIXTURES_DIR}${name}/init.bin`);
}

/** The aligned twin's fragments and the running byte offset each one starts at. */
export function aligned(name: string): {
    fragments: FixtureFragment[];
    offsets: number[];
} {
    const fragments = readManifest(`${name}-aligned`).fragments;
    const offsets: number[] = [];
    let offset = 0;

    for (const fragment of fragments) {
        offsets.push(offset);
        offset += fragment.bytes;
    }

    return { fragments, offsets };
}

/** Lower-case hex sha256. */
export function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** The first `count` bytes one at a time, then the rest as one chunk. */
export function byteAtATime(bytes: Uint8Array, count: number): Uint8Array[] {
    const head = Math.min(count, bytes.byteLength);
    const chunks: Uint8Array[] = [];

    for (let index = 0; index < head; index++) {
        chunks.push(bytes.subarray(index, index + 1));
    }

    if (head < bytes.byteLength) {
        chunks.push(bytes.subarray(head));
    }

    return chunks;
}

/** Chunks of random sizes from a mulberry32 stream, so the same seed gives the same splits. */
export function seededSplits(
    bytes: Uint8Array,
    seed: number,
    min = 1,
    max = 65_536,
): Uint8Array[] {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const chunks: Uint8Array[] = [];
    let offset = 0;

    while (offset < bytes.byteLength) {
        const size = min + Math.floor(next() * (max - min + 1));
        chunks.push(bytes.subarray(offset, offset + size));
        offset += size;
    }

    return chunks;
}

/** The running byte offset each segment starts at. */
export function offsetsOf(segments: { bytes: Uint8Array }[]): number[] {
    const offsets: number[] = [];
    let offset = 0;

    for (const segment of segments) {
        offsets.push(offset);
        offset += segment.bytes.byteLength;
    }

    return offsets;
}
