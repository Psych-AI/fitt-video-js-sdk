import type { Clock } from '../core/clock.ts';
import { sha256Hex } from '../core/crypto.ts';
import type { ChunkedTrack } from '../core/descriptor.ts';
import type { Environment } from '../core/env.ts';
import { partCount } from '../core/parts.ts';
import type {
    RunEndedReason,
    RunRecord,
    SegmentRecord,
} from '../core/store.ts';
import { ulid } from '../core/ulid.ts';
import { keyframeOptionHonoured } from '../cut/honoured.ts';
import { createCutter } from '../cut/select.ts';
import type { CutSegment, Cutter } from '../cut/types.ts';

/** The part of MediaRecorder a run uses. */
export interface RecorderLike extends EventTarget {
    readonly mimeType: string;
    readonly state: string;
    start(timeslice: number): void;
    stop(): void;
}

/** MediaRecorderOptions plus the keyframe interval Chromium reads (the spike passed it the same way). */
export type RunRecorderOptions = MediaRecorderOptions & {
    videoKeyFrameIntervalDuration?: number;
};

export type RecorderFactory = (
    stream: MediaStream,
    options: MediaRecorderOptions,
) => RecorderLike;

export interface Run {
    readonly runId: string;
    start(): Promise<void>;
    /**
     * Resolves after the last dataavailable is cut and stored. A failed
     * store never rejects it: the failure is reported as
     * `recorder.store_failed` and the take goes on.
     */
    stop(reason: RunEndedReason): Promise<RunRecord>;
    record(): RunRecord;
    /** Media segments cut so far (the engine's guard against a recorder that errors in a loop). */
    mediaSegmentsCut(): number;
}

export interface RunDeps {
    env: Environment;
    clock: Clock;
    sessionId: string;
    take: number;
    runIndex: number;
    track: ChunkedTrack;
    stream: MediaStream;
    mimeType: string;
    bitrates: { video?: number; audio: number };
    recorderFactory: RecorderFactory;
    add(record: SegmentRecord): Promise<unknown>;
    putRun(record: RunRecord): Promise<void>;
    emit(type: string, payload: Record<string, unknown>): void;
    /** The recorder fired `error` and the run stopped itself with recorder_error. */
    onRecorderError(): void;
    ua: string;
}

/** The recorder hands over a blob this often. */
const TIMESLICE_MS = 1000;

/** The manifest's `ua` limit, in code points, so a cut never splits a surrogate pair. */
const UA_MAX = 512;

/** An error's name for an event payload, never its message. */
function nameOf(error: unknown): string {
    const name = (error as { name?: unknown } | null | undefined)?.name;

    return typeof name === 'string' ? name : 'unknown';
}

/**
 * One MediaRecorder for one track of one take (author's call 6). Its blobs
 * are cut as they arrive and every segment is stored before the next blob is
 * read. `started_ms` is the start() call, `anchor_ms` the recorder's `start`
 * event; the init sits at the anchor with no duration, and each media
 * segment at the anchor plus its media time.
 */
export function createRun(deps: RunDeps): Run {
    const { clock, track } = deps;
    const runId = ulid(deps.env);
    const isVideo = track.track !== 'audio';
    const record: RunRecord = {
        session_id: deps.sessionId,
        track: track.track,
        take: deps.take,
        run_index: deps.runIndex,
        run_id: runId,
        anchor_ms: 0,
        anchor_source: clock.anchorSource(),
        mime_type: deps.mimeType,
        started_ms: 0,
        ended_ms: null,
        ended_reason: null,
        segmenting: 'cluster',
        keyframe_option_honoured: null,
        ua: Array.from(deps.ua).slice(0, UA_MAX).join(''),
    };
    let recorder: RecorderLike | null = null;
    let cutter: Cutter | null = null;
    let anchored = false;
    let nextSeq = 0;
    let mediaCut = 0;
    const mediaDurations: number[] = [];
    let chain: Promise<void> = Promise.resolve();
    let stopping: Promise<RunRecord> | null = null;
    let stopped: Promise<void> = Promise.resolve();

    /**
     * A write to the local queue failed (an IndexedDB error, a full disk the
     * store could not route round). The take goes on: the event says what
     * was lost, and `seq` (null for the run record) is never handed out
     * again, so the hole shows in the manifest instead of a second segment
     * claiming the same number.
     */
    function storeFailed(seq: number | null, error: unknown): void {
        deps.emit('recorder.store_failed', {
            track: track.track,
            run_id: runId,
            seq,
            name: nameOf(error),
        });
    }

    /** Runs the step after every step before it; a failure is reported and later steps still run. */
    function enqueue(step: () => Promise<void>): void {
        chain = chain
            .then(step)
            .catch((error: unknown) => storeFailed(null, error));
    }

    /** Waits for every step queued so far, including steps queued while waiting. */
    async function drain(): Promise<void> {
        let current: Promise<void>;

        do {
            current = chain;
            await current;
        } while (current !== chain);
    }

    /** The recorder started (or, failing a `start` event, the first data or the stop arrived). */
    function anchor(): Cutter {
        if (anchored && cutter !== null) {
            return cutter;
        }

        anchored = true;
        record.anchor_ms = clock.now();
        record.anchor_source = clock.anchorSource();
        record.mime_type = recorder?.mimeType || deps.mimeType;
        cutter = createCutter(
            record.mime_type,
            {
                targetMs: track.segments.target_ms,
                maxMs: track.segments.max_ms,
                audioOnly: track.track === 'audio',
            },
            (reason) => {
                record.segmenting = 'blob';
                deps.emit('recorder.fallback', {
                    track: track.track,
                    run_id: runId,
                    reason,
                });
            },
        );
        record.segmenting = cutter.segmenting;
        deps.emit('recorder.started', {
            track: track.track,
            run_id: runId,
            mime_type: record.mime_type,
        });
        const snapshot = { ...record };
        enqueue(() => deps.putRun(snapshot));

        return cutter;
    }

    async function store(segment: CutSegment): Promise<void> {
        const seq = nextSeq++;
        const bytes = segment.bytes;
        const isInit = segment.kind === 'init';
        const segmentRecord: SegmentRecord = {
            session_id: deps.sessionId,
            track: track.track,
            take: deps.take,
            run_index: deps.runIndex,
            run_id: runId,
            seq,
            kind: segment.kind,
            start_ms: isInit
                ? record.anchor_ms
                : record.anchor_ms + segment.startMs,
            duration_ms: isInit ? 0 : segment.durationMs,
            recorded_at: Math.floor(deps.env.dateNow()),
            bytes: bytes.byteLength,
            sha256: await sha256Hex(bytes),
            part_count: partCount(bytes.byteLength, track.segments.part_size),
            created_ms: clock.now(),
            state: 'pending',
            failures: 0,
            init: isInit
                ? {
                      anchor_ms: record.anchor_ms,
                      anchor_source: record.anchor_source,
                      mime: record.mime_type,
                      started_ms: record.started_ms,
                  }
                : null,
            data: bytes.slice().buffer,
        };

        if (segment.nonKeyframeStart) {
            deps.emit('recorder.non_keyframe_cut', {
                track: track.track,
                run_id: runId,
                seq,
            });
        }

        if (!isInit) {
            mediaCut++;
            mediaDurations.push(segment.durationMs);
        }

        try {
            await deps.add(segmentRecord);
        } catch (error) {
            storeFailed(seq, error);
        }
    }

    async function storeAll(segments: CutSegment[]): Promise<void> {
        for (const segment of segments) {
            await store(segment);
        }
    }

    function onData(event: Event): void {
        const data = (event as BlobEvent).data;

        enqueue(async () => {
            const active = anchor();

            if (data === undefined || data === null) {
                return;
            }

            const bytes = new Uint8Array(await data.arrayBuffer());

            await storeAll(active.push(bytes, clock.now()));
        });
    }

    function onError(event: Event): void {
        deps.emit('recorder.error', {
            track: track.track,
            run_id: runId,
            name: nameOf((event as { error?: unknown }).error),
        });

        if (stopping !== null) {
            return;
        }

        void run.stop('recorder_error').then(
            () => deps.onRecorderError(),
            () => deps.onRecorderError(),
        );
    }

    async function finish(reason: RunEndedReason): Promise<RunRecord> {
        record.ended_ms = clock.now();

        if (recorder !== null && recorder.state !== 'inactive') {
            try {
                recorder.stop();
            } catch {
                // A recorder that already stopped itself throws InvalidStateError in older engines.
            }
        }

        await stopped;
        await drain();

        // The ended run record and recorder.stopped are written whatever the
        // last cut does, so the take can always be stopped and sealed.
        try {
            const active = anchor();
            await drain();
            await storeAll(active.end(clock.now()));
            record.segmenting = active.segmenting;
        } catch (error) {
            storeFailed(null, error);
        }

        record.keyframe_option_honoured = keyframeOptionHonoured(
            mediaDurations,
            track.segments.target_ms,
        );
        record.ended_reason = reason;

        try {
            await deps.putRun({ ...record });
        } catch (error) {
            storeFailed(null, error);
        }

        deps.emit('recorder.stopped', {
            track: track.track,
            run_id: runId,
            reason,
        });

        return { ...record };
    }

    const run: Run = {
        runId,

        async start(): Promise<void> {
            record.started_ms = clock.now();
            const options: RunRecorderOptions = {};

            if (deps.mimeType !== '') {
                options.mimeType = deps.mimeType;
            }

            if (isVideo && deps.bitrates.video !== undefined) {
                options.videoBitsPerSecond = deps.bitrates.video;
            }

            options.audioBitsPerSecond = deps.bitrates.audio;

            if (isVideo) {
                options.videoKeyFrameIntervalDuration =
                    track.segments.target_ms;
            }

            const made = deps.recorderFactory(deps.stream, options);
            recorder = made;
            stopped = new Promise<void>((resolve) =>
                made.addEventListener('stop', () => resolve(), { once: true }),
            );
            made.addEventListener('start', () => {
                anchor();
            });
            made.addEventListener('dataavailable', onData);
            made.addEventListener('error', onError);
            made.start(TIMESLICE_MS);
        },

        stop(reason: RunEndedReason): Promise<RunRecord> {
            stopping ??= finish(reason);

            return stopping;
        },

        record(): RunRecord {
            return { ...record };
        },

        mediaSegmentsCut(): number {
            return mediaCut;
        },
    };

    return run;
}
