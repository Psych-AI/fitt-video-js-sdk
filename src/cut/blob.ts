import type { CutOptions, CutSegment, Cutter, SegmentKind } from './types.ts';

const DEFAULT_TIMESLICE_MS = 1000;

export interface BlobCutOptions extends CutOptions {
    /** The kind of the first group: `init` for a pure blob run (author's call 5), `media` after a fallback past the init. */
    firstKind?: SegmentKind;
    /** The media time the first group starts at. */
    startMs?: number;
}

/**
 * Groups raw recorder chunks by arrival time into segments of about `targetMs`, with no
 * parsing at all. Its times are arrival times, approximate by nature: the server re-encodes
 * blob runs (D5).
 */
export function createBlobCutter(options: BlobCutOptions): Cutter {
    const timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    const baseMs = options.startMs ?? 0;

    let chunks: Uint8Array[] = [];
    let groupFirstArrival: number | null = null;
    let groupLastArrival = 0;
    let runFirstArrival: number | null = null;
    let lastArrival = 0;
    let groups = 0;

    const startOf = (arrival: number): number =>
        baseMs + arrival - (runFirstArrival ?? arrival);

    /** The open group's chunks joined into one new buffer. */
    function joined(): Uint8Array {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;

        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return bytes;
    }

    function take(durationMs: number): CutSegment {
        const segment: CutSegment = {
            kind: groups === 0 ? (options.firstKind ?? 'init') : 'media',
            bytes: joined(),
            startMs: startOf(groupFirstArrival ?? 0),
            durationMs,
            nonKeyframeStart: false,
        };

        groups++;
        chunks = [];
        groupFirstArrival = null;

        return segment;
    }

    return {
        segmenting: 'blob',

        push(chunk: Uint8Array, arrivalMs?: number): CutSegment[] {
            const arrival = arrivalMs ?? lastArrival;
            lastArrival = arrival;
            runFirstArrival ??= arrival;

            const completed: CutSegment[] = [];

            if (
                groupFirstArrival !== null &&
                arrival - groupFirstArrival >= options.targetMs
            ) {
                completed.push(
                    take(startOf(arrival) - startOf(groupFirstArrival)),
                );
            }

            groupFirstArrival ??= arrival;
            groupLastArrival = arrival;
            // Copy: the caller may reuse or detach the chunk's buffer.
            chunks.push(chunk.slice());

            return completed;
        },

        end(): CutSegment[] {
            if (groupFirstArrival === null) {
                return [];
            }

            return [
                take(
                    startOf(groupLastArrival) +
                        timesliceMs -
                        startOf(groupFirstArrival),
                ),
            ];
        },

        pending(): Uint8Array {
            return joined();
        },

        initDone(): boolean {
            return groups > 0 && (options.firstKind ?? 'init') === 'init';
        },
    };
}
