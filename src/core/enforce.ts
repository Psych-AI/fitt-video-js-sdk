import type { PageLike } from '../signals/index.ts';
import type { Clock } from './clock.ts';
import type { Environment } from './env.ts';
import type { EventBus } from './events.ts';

/** The grace a candidate has to come back when the descriptor names none. */
const DEFAULT_GRACE_MS = 10_000;

/** A leave_tick is raised on each whole second away. */
const TICK_MS = 1000;

/**
 * The enforcement this version applies: `stay_on_page` only (author's call
 * 13, owner question 5). Every other key is ignored with one warning each.
 */
export function readEnforce(
    enforce: Record<string, unknown>,
    warn: (message: string) => void,
): { stayOnPage: { graceMs: number } | null } {
    for (const key of Object.keys(enforce)) {
        if (key !== 'stay_on_page') {
            warn(`Fitt Video ignores enforce.${key} in this version.`);
        }
    }

    const stay = enforce.stay_on_page;

    if (stay === undefined || stay === null || stay === false) {
        return { stayOnPage: null };
    }

    const grace =
        typeof stay === 'object'
            ? (stay as { grace_ms?: unknown }).grace_ms
            : undefined;

    return {
        stayOnPage: {
            graceMs:
                typeof grace === 'number' &&
                Number.isFinite(grace) &&
                grace >= 0
                    ? Math.floor(grace)
                    : DEFAULT_GRACE_MS,
        },
    };
}

/**
 * Stay on page. While armed, the page is away when it is hidden or the
 * window lost focus while visible. Away, it raises `enforce.leave_tick` on
 * each whole second with the grace that is left, and at the end of the grace
 * `enforce.left_page` and one forced stop, after which it disarms. Coming
 * back (visible and focused) cancels. Every time is read from the session
 * clock, so a throttled background tab still stops on time.
 *
 * Window events miss some focus changes: a click into a child frame raises
 * `blur` on this window while `doc.hasFocus()` stays true, and a return may
 * raise no `focus`. So while away and visible, the guard reads hasFocus()
 * just after each blur, at each visibility change and before each tick, as
 * the attention signal's poll does, and a true answer counts as back.
 */
export function createStayOnPage(deps: {
    page: PageLike;
    env: Environment;
    clock: Clock;
    graceMs: number;
    emit: EventBus['emit'];
    forceStop(): void;
}): { arm(): void; disarm(): void } {
    const { page, env, clock, graceMs } = deps;
    const { win, doc } = page;
    let armed = false;
    let focused = true;
    let leftAt: number | null = null;
    let timer: number | null = null;
    let focusCheck: number | null = null;

    /** A visible page whose document holds focus (a child frame counts) is focused. */
    const readFocus = (): void => {
        if (doc.visibilityState !== 'hidden' && doc.hasFocus()) {
            focused = true;
        }
    };

    const cancel = (): void => {
        if (timer !== null) {
            env.timers.clearTimeout(timer);
            timer = null;
        }

        leftAt = null;
    };

    const schedule = (): void => {
        if (leftAt === null) {
            return;
        }

        const away = clock.now() - leftAt;
        const next = Math.min(
            TICK_MS * (Math.floor(away / TICK_MS) + 1),
            graceMs,
        );
        timer = env.timers.setTimeout(tick, Math.max(0, next - away));
    };

    function tick(): void {
        timer = null;

        if (!armed || leftAt === null) {
            return;
        }

        readFocus();
        evaluate();

        if (leftAt === null) {
            return;
        }

        const remaining = graceMs - (clock.now() - leftAt);

        if (remaining > 0) {
            deps.emit('enforce.leave_tick', { remaining_ms: remaining });
            schedule();

            return;
        }

        deps.emit('enforce.left_page', { grace_ms: graceMs });
        disarm();
        deps.forceStop();
    }

    function evaluate(): void {
        if (!armed) {
            return;
        }

        const away = doc.visibilityState === 'hidden' || !focused;

        if (away && leftAt === null) {
            leftAt = clock.now();
            schedule();
        } else if (!away && leftAt !== null) {
            cancel();
        }
    }

    const onVisibility = (): void => {
        readFocus();
        evaluate();
    };
    const onBlur = (): void => {
        focused = false;
        evaluate();

        // The new focus target is only settled once the blur has run.
        if (focusCheck === null) {
            focusCheck = env.timers.setTimeout(() => {
                focusCheck = null;
                readFocus();
                evaluate();
            }, 0);
        }
    };
    const onFocus = (): void => {
        focused = true;
        evaluate();
    };

    function disarm(): void {
        if (!armed) {
            return;
        }

        armed = false;
        doc.removeEventListener('visibilitychange', onVisibility);
        win.removeEventListener('blur', onBlur);
        win.removeEventListener('focus', onFocus);
        cancel();

        if (focusCheck !== null) {
            env.timers.clearTimeout(focusCheck);
            focusCheck = null;
        }
    }

    return {
        arm(): void {
            if (armed) {
                return;
            }

            armed = true;
            focused = doc.hasFocus();
            doc.addEventListener('visibilitychange', onVisibility);
            win.addEventListener('blur', onBlur);
            win.addEventListener('focus', onFocus);
            evaluate();
        },
        disarm,
    };
}
