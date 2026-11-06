import { partCount } from './parts.ts';
import type { RunRecord, SegmentRecord, SegmentState } from './store.ts';

/**
 * A track's manifest (spec 6.3, author's call 8): the body of
 * `POST /sessions/{id}/tracks/{track}/manifest`, as
 * `StoreManifestRequest` reads it.
 */
export interface ManifestBody {
    take: number;
    take_start_ms?: number;
    end_ms: number;
    runs: Record<string, unknown>[];
    segments: {
        run_id: string;
        seq: number;
        kind: 'init' | 'media';
        start_ms: number;
        duration_ms: number;
        bytes: number;
        sha256: string;
        part_count?: number;
        status: 'expected' | 'abandoned';
    }[];
}

/** The longest user agent the server takes, in characters (`runs.*.ua`, max:512). */
const UA_MAX = 512;

/** Local states the server is told it will never get. */
const GIVEN_UP: readonly SegmentState[] = ['abandoned', 'rejected'];

/**
 * At most 512 code points, as PHP's mb_strlen counts them, so a cut never
 * splits a surrogate pair into a lone surrogate the server cannot decode.
 */
function cutUa(ua: string): string {
    const points = Array.from(ua);

    return points.length <= UA_MAX ? ua : points.slice(0, UA_MAX).join('');
}

function runEntry(run: RunRecord): Record<string, unknown> {
    // codec_params is never sent: it is the client's claim, and Plan 4 probes the real values.
    const entry: Record<string, unknown> = {
        run_id: run.run_id,
        anchor_ms: run.anchor_ms,
        anchor_source: run.anchor_source,
        mime_type: run.mime_type,
        started_ms: run.started_ms,
        ended_ms: run.ended_ms,
        ended_reason: run.ended_reason,
        segmenting: run.segmenting,
        ua: cutUa(run.ua),
    };

    if (run.keyframe_option_honoured !== null) {
        entry.keyframe_option_honoured = run.keyframe_option_honoured;
    }

    return entry;
}

/**
 * Lists every seq of the take, seq 0 always expected. A body the server refuses (422) takes the normal terminal path in sealTracks (Task 15).
 *
 * Abandoned and rejected records are listed `abandoned`; pending, delivered
 * and dropped ones `expected`, so a re-post never un-lists a delivered seq.
 * Seq 0 is always `expected`, because the server never accepts it abandoned.
 * Neither the seqs nor the 100-run and 20,000-entry limits are re-checked
 * here: the server answers a body that breaks them with 422.
 */
export function buildManifest(input: {
    take: number;
    takeStartMs: number | null;
    endMs: number;
    partSize: number;
    runs: RunRecord[];
    segments: SegmentRecord[];
}): ManifestBody {
    const runs = input.runs
        .filter((run) => run.take === input.take)
        .sort((a, b) => a.run_index - b.run_index);
    const segments = input.segments
        .filter((segment) => segment.take === input.take)
        .sort((a, b) => a.run_index - b.run_index || a.seq - b.seq);

    const body: ManifestBody = {
        take: input.take,
        end_ms: input.endMs,
        runs: runs.map(runEntry),
        segments: segments.map((segment) => {
            const parts = partCount(segment.bytes, input.partSize);
            const status: 'expected' | 'abandoned' =
                segment.seq !== 0 && GIVEN_UP.includes(segment.state)
                    ? 'abandoned'
                    : 'expected';

            return {
                run_id: segment.run_id,
                seq: segment.seq,
                kind: segment.kind,
                start_ms: segment.start_ms,
                duration_ms: segment.duration_ms,
                bytes: segment.bytes,
                sha256: segment.sha256,
                ...(parts > 1 ? { part_count: parts } : {}),
                status,
            };
        }),
    };

    if (input.takeStartMs !== null) {
        body.take_start_ms = input.takeStartMs;
    }

    return body;
}
