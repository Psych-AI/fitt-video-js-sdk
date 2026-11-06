import type { SignalContext } from './index.ts';

/** Any of these on the document starts the idle count again. */
const INPUT_EVENTS = [
    'keydown',
    'pointerdown',
    'pointermove',
    'wheel',
    'touchstart',
] as const;

/** browser.pointer_left is raised at most this often. */
const POINTER_LEFT_MS = 1000;

/**
 * The SDK's own input-idle timer (no Idle Detection, which prompts and
 * rejects thresholds under 60 s): one `browser.idle` per idle stretch. The
 * pointer leaving the page, throttled.
 */
export function startInput(context: SignalContext): void {
    const { page, env, clock, emit, idleMs } = context;
    const { doc } = page;
    let lastInput = clock.now();
    let timer: number | null = null;
    let lastLeft = Number.NEGATIVE_INFINITY;

    const schedule = (delay: number): void => {
        timer = env.timers.setTimeout(check, Math.max(0, delay));
    };

    function check(): void {
        timer = null;
        const quiet = clock.now() - lastInput;

        if (quiet < idleMs) {
            schedule(idleMs - quiet);

            return;
        }

        // One event per stretch: the next input schedules the count again.
        emit('browser.idle', { idle_ms: idleMs });
    }

    const onInput = (): void => {
        lastInput = clock.now();

        if (timer === null) {
            schedule(idleMs);
        }
    };

    for (const type of INPUT_EVENTS) {
        context.on(doc, type, onInput, { capture: true, passive: true });
    }

    context.on(doc.documentElement, 'pointerleave', () => {
        const now = clock.now();

        if (now - lastLeft < POINTER_LEFT_MS) {
            return;
        }

        lastLeft = now;
        emit('browser.pointer_left', {});
    });

    schedule(idleMs);
    context.onStop(() => {
        if (timer !== null) {
            env.timers.clearTimeout(timer);
            timer = null;
        }
    });
}
