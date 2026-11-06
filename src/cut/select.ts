import { createBlobCutter } from './blob.ts';
import { createBmffCutter } from './bmff.ts';
import { createEbmlCutter } from './ebml.ts';
import {
    CutterError,
    type CutOptions,
    type CutSegment,
    type Cutter,
    type Segmenting,
} from './types.ts';

/** The cutter that reads this MIME type: EBML for WebM, BMFF for MP4, raw groups for anything else. */
function innerCutter(mimeType: string, options: CutOptions): Cutter {
    if (/^(video|audio)\/webm/i.test(mimeType)) {
        return createEbmlCutter(options);
    }

    if (/^(video|audio)\/mp4/i.test(mimeType)) {
        return createBmffCutter(options);
    }

    return createBlobCutter(options);
}

/**
 * Picks the cutter for a MIME type and falls back to raw groups on a parse error (author's
 * call 5). Cuts already made stand byte for byte, the run is not restarted, and from the first
 * error on the whole run reports `segmenting: 'blob'`. The bytes returned over the run always
 * concatenate to exactly the bytes pushed.
 */
export function createCutter(
    mimeType: string,
    options: CutOptions,
    onFallback: (reason: 'parse_error') => void,
): Cutter {
    let inner = innerCutter(mimeType, options);
    let segmenting: Segmenting = inner.segmenting;
    let fellBack = false;
    let initReturned = false;
    /** Where the bytes not yet returned start, in media time. */
    let pendingStartMs = 0;

    function note(segments: CutSegment[]): CutSegment[] {
        for (const segment of segments) {
            if (segment.kind === 'init') {
                initReturned = true;
            } else {
                pendingStartMs = segment.startMs + segment.durationMs;
            }
        }

        return segments;
    }

    /** Swaps the failed cutter for a blob cutter fed with its pending bytes first. */
    function fallBack(
        error: CutterError,
        arrivalMs: number | undefined,
    ): CutSegment[] {
        const completed = note(error.completed);
        const failed = inner;

        fellBack = true;
        segmenting = 'blob';
        onFallback(error.reason);

        inner = createBlobCutter({
            ...options,
            firstKind: initReturned || failed.initDone() ? 'media' : 'init',
            startMs: pendingStartMs,
        });

        const pending = failed.pending();

        if (pending.byteLength > 0) {
            completed.push(...note(inner.push(pending, arrivalMs)));
        }

        return completed;
    }

    /** Runs one call on the current cutter, falling back once on its first CutterError. */
    function guarded(
        run: () => CutSegment[],
        arrivalMs: number | undefined,
        ending: boolean,
    ): CutSegment[] {
        try {
            return note(run());
        } catch (error) {
            if (fellBack || !(error instanceof CutterError)) {
                throw error;
            }

            const completed = fallBack(error, arrivalMs);

            return ending
                ? [...completed, ...note(inner.end(arrivalMs))]
                : completed;
        }
    }

    return {
        get segmenting(): Segmenting {
            return segmenting;
        },

        push(chunk: Uint8Array, arrivalMs?: number): CutSegment[] {
            return guarded(
                () => inner.push(chunk, arrivalMs),
                arrivalMs,
                false,
            );
        },

        end(arrivalMs?: number): CutSegment[] {
            return guarded(() => inner.end(arrivalMs), arrivalMs, true);
        },

        pending(): Uint8Array {
            return inner.pending();
        },

        initDone(): boolean {
            return initReturned;
        },
    };
}
