import type { Environment } from './env.ts';

export type AnchorSource = 'performance' | 'wall_clock';

export interface ClockJump {
    performance_ms: number;
    wall_ms: number;
}

export interface Clock {
    readonly epochMs: number;
    /** Session time in whole ms, never negative, never decreasing. */
    now(): number;
    anchorSource(): AnchorSource;
    /** Compares the two clocks; a divergence over 2000 ms either way returns the jump and switches to wall_clock. */
    check(): ClockJump | null;
}

/** More than this between the two clocks, either way, is a jump. */
const JUMP_MS = 2000;

/**
 * The session's one clock (author's call 7). On the first page it counts on
 * performance.now() from timeOrigin. After a reload (a stored epoch) it counts
 * on Date.now(). After a jump it continues from the larger reading on
 * Date.now(), so now() never goes back.
 *
 * floorMs: the highest session time handed out before a reload (SessionRecord.max_session_ms).
 */
export function createClock(
    env: Environment,
    storedEpochMs?: number,
    floorMs?: number,
): Clock {
    const perfAtStart = env.perfNow();
    const dateAtStart = env.dateNow();
    const epochMs = storedEpochMs ?? Math.floor(env.timeOrigin + perfAtStart);
    let source: AnchorSource =
        storedEpochMs === undefined ? 'performance' : 'wall_clock';
    /** The session time at the reference pair. */
    let base = storedEpochMs === undefined ? 0 : dateAtStart - epochMs;
    let perfRef = perfAtStart;
    let dateRef = dateAtStart;
    let last = 0;
    let pendingJump: ClockJump | null = null;

    if (storedEpochMs !== undefined && floorMs !== undefined) {
        const wallMs = dateAtStart - epochMs;

        if (wallMs < floorMs) {
            pendingJump = {
                performance_ms: Math.floor(floorMs),
                wall_ms: Math.floor(wallMs),
            };
            base = floorMs;
        }

        last = Math.max(0, Math.floor(floorMs));
    }

    const computed = (): number =>
        source === 'performance'
            ? base + (env.perfNow() - perfRef)
            : base + (env.dateNow() - dateRef);

    return {
        epochMs,
        now(): number {
            last = Math.max(last, Math.max(0, Math.floor(computed())));

            return last;
        },
        anchorSource: () => source,
        check(): ClockJump | null {
            if (pendingJump !== null) {
                const jump = pendingJump;
                pendingJump = null;

                return jump;
            }

            const perfNow = env.perfNow();
            const dateNow = env.dateNow();
            const performanceMs = base + (perfNow - perfRef);
            const wallMs = base + (dateNow - dateRef);

            if (Math.abs(performanceMs - wallMs) <= JUMP_MS) {
                return null;
            }

            base = Math.max(performanceMs, wallMs);
            source = 'wall_clock';
            perfRef = perfNow;
            dateRef = dateNow;

            return {
                performance_ms: Math.floor(performanceMs),
                wall_ms: Math.floor(wallMs),
            };
        },
    };
}
