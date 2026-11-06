export type SegmentKind = 'init' | 'media';
export type Segmenting = 'cluster' | 'moof' | 'blob';

export interface CutSegment {
    kind: SegmentKind;
    bytes: Uint8Array;
    /** Media time of the segment's first Cluster (or video tfdt), in ms. 0 for the init. */
    startMs: number;
    durationMs: number;
    /** Cut past max_ms at a Cluster whose first video block is not a keyframe. */
    nonKeyframeStart: boolean;
}

export interface CutOptions {
    targetMs: number;
    maxMs: number;
    /** An audio-only track: any Cluster may start a segment. */
    audioOnly?: boolean;
    /** Blob cutter only: the recorder's timeslice, default 1000. */
    timesliceMs?: number;
}

export interface Cutter {
    readonly segmenting: Segmenting;
    /** Feed the next bytes. Returns the segments these bytes completed, in order. */
    push(chunk: Uint8Array, arrivalMs?: number): CutSegment[];
    /** End of stream. Returns the final segment(s). */
    end(arrivalMs?: number): CutSegment[];
    /** Bytes received but not yet returned in a segment (used by the fallback, Task 3). */
    pending(): Uint8Array;
    /** Whether the init segment was already returned. */
    initDone(): boolean;
}

export class CutterError extends Error {
    readonly reason: 'parse_error';
    /** Segments the failing push completed before the bad bytes, so a fallback loses none of them. */
    readonly completed: CutSegment[];
    constructor(message: string, completed: CutSegment[] = []) {
        super(message);
        this.name = 'CutterError';
        this.reason = 'parse_error';
        this.completed = completed;
    }
}
