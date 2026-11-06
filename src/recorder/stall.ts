import type { Clock } from '../core/clock.ts';
import type { Environment } from '../core/env.ts';

/** The part of HTMLVideoElement the stall watch uses. */
export interface FrameSource {
    requestVideoFrameCallback(callback: () => void): number;
    cancelVideoFrameCallback(handle: number): void;
}

export interface StallWatchDeps {
    env: Environment;
    clock: Clock;
    video: FrameSource | null;
    /** The camera's target frame rate (the track's `capture.video.frame_rate`). */
    frameRate: number;
    doc: { visibilityState: string } & EventTarget;
    emit(type: string, payload: Record<string, unknown>): void;
}

export interface StallWatch {
    start(): void;
    stop(): void;
    /** The element to watch (the session's preview or its own); null stops watching. */
    setVideo(video: FrameSource | null): void;
}

/** No frame for this long is a stall (spec 6.3). */
const STALL_MS = 2000;

/** The frame rate is measured over windows this long. */
const WINDOW_MS = 5000;

/**
 * Watches the frames a video element paints with requestVideoFrameCallback,
 * because track `mute` is not a dependable stall signal (spec 6.3). No frame
 * for 2 s raises `recorder.stalled` once until the next frame; fewer than
 * half the target frames a second over a 5 s window raises
 * `recorder.fps_drop` once until a window at or above it. Hidden tabs do not
 * render, so nothing is raised while the page is hidden.
 */
export function createStallWatch(deps: StallWatchDeps): StallWatch {
    const { env } = deps;
    let video = deps.video;
    let started = false;
    let handle: number | null = null;
    let stallTimer: number | null = null;
    let windowTimer: number | null = null;
    let stalled = false;
    let dropped = false;
    let frames = 0;
    let windowStart = 0;

    const visible = (): boolean => deps.doc.visibilityState !== 'hidden';

    function clearTimers(): void {
        if (stallTimer !== null) {
            env.timers.clearTimeout(stallTimer);
            stallTimer = null;
        }

        if (windowTimer !== null) {
            env.timers.clearTimeout(windowTimer);
            windowTimer = null;
        }
    }

    function cancelFrame(): void {
        if (video !== null && handle !== null) {
            video.cancelVideoFrameCallback(handle);
        }

        handle = null;
    }

    function arm(): void {
        if (video === null || handle !== null) {
            return;
        }

        const watched = video;
        handle = watched.requestVideoFrameCallback(() => onFrame(watched));
    }

    function armStall(): void {
        if (stallTimer !== null) {
            env.timers.clearTimeout(stallTimer);
        }

        stallTimer = env.timers.setTimeout(checkStall, STALL_MS);
    }

    /** Starts a new frame-rate window, so time spent stalled or hidden never counts. */
    function resetWindow(): void {
        frames = 0;
        windowStart = env.perfNow();

        if (windowTimer !== null) {
            env.timers.clearTimeout(windowTimer);
        }

        windowTimer = env.timers.setTimeout(checkWindow, WINDOW_MS);
    }

    function onFrame(source: FrameSource): void {
        if (!started || source !== video) {
            return;
        }

        handle = null;
        frames++;

        if (stalled) {
            stalled = false;
            resetWindow();
        }

        arm();
        armStall();
    }

    function checkStall(): void {
        stallTimer = null;

        // Rendering pauses in a hidden tab; the watch re-arms on return to visible.
        if (!visible() || stalled) {
            return;
        }

        stalled = true;
        deps.emit('recorder.stalled', { track: 'camera', since_ms: STALL_MS });
    }

    function checkWindow(): void {
        windowTimer = null;
        const elapsed = env.perfNow() - windowStart;

        if (visible() && !stalled && elapsed > 0) {
            const fps = (frames * 1000) / elapsed;

            if (fps < deps.frameRate / 2) {
                if (!dropped) {
                    dropped = true;
                    deps.emit('recorder.fps_drop', {
                        track: 'camera',
                        fps: Math.round(fps),
                        target: deps.frameRate,
                    });
                }
            } else {
                dropped = false;
            }
        }

        resetWindow();
    }

    function watch(): void {
        stalled = false;
        arm();
        armStall();
        resetWindow();
    }

    function onVisibility(): void {
        if (!started || video === null || !visible()) {
            return;
        }

        watch();
    }

    return {
        start(): void {
            if (started) {
                return;
            }

            started = true;
            deps.doc.addEventListener('visibilitychange', onVisibility);

            if (video !== null) {
                watch();
            }
        },

        stop(): void {
            started = false;
            deps.doc.removeEventListener('visibilitychange', onVisibility);
            cancelFrame();
            clearTimers();
        },

        setVideo(next: FrameSource | null): void {
            if (next === video) {
                return;
            }

            cancelFrame();
            clearTimers();
            video = next;
            stalled = false;
            dropped = false;

            if (started && video !== null) {
                watch();
            }
        },
    };
}
