import type { SignalContext } from './index.ts';

/** While visible, the window position and the screen are read this often. */
export const LAYOUT_POLL_MS = 2000;

/**
 * Resizes, debounced from the last event, with the inner and outer size (a
 * sudden gap between them hints at docked DevTools), and window moves,
 * found at a resize or on the poll.
 */
export function startWindow(context: SignalContext): void {
    const { page, env, emit } = context;
    const { win, doc } = page;
    let debounce: number | null = null;
    let x = win.screenX;
    let y = win.screenY;

    const checkMoved = (): void => {
        if (win.screenX === x && win.screenY === y) {
            return;
        }

        x = win.screenX;
        y = win.screenY;
        emit('browser.window_moved', { x, y });
    };

    const clearDebounce = (): void => {
        if (debounce !== null) {
            env.timers.clearTimeout(debounce);
            debounce = null;
        }
    };

    context.on(win, 'resize', () => {
        clearDebounce();
        debounce = env.timers.setTimeout(() => {
            debounce = null;
            emit('browser.resize', {
                width: win.innerWidth,
                height: win.innerHeight,
                outer_width: win.outerWidth,
                outer_height: win.outerHeight,
            });
        }, context.resizeDebounceMs);
        checkMoved();
    });
    context.every(LAYOUT_POLL_MS, () => {
        if (doc.visibilityState !== 'hidden') {
            checkMoved();
        }
    });
    context.onStop(clearDebounce);
}
