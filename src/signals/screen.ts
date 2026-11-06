import type { SignalContext } from './index.ts';
import { LAYOUT_POLL_MS } from './window.ts';

interface ScreenReading {
    width: number | null;
    height: number | null;
    dpr: number;
}

/**
 * Screen size and pixel ratio changes (moving the window to another monitor
 * changes both), and `screen.isExtended` where the browser has it: it needs
 * no permission, unlike the Window Management API, which is not used.
 */
export function startScreen(context: SignalContext): void {
    const { page, emit } = context;
    const { win, doc } = page;

    const read = (): ScreenReading => ({
        width: win.screen?.width ?? null,
        height: win.screen?.height ?? null,
        dpr: win.devicePixelRatio ?? 1,
    });

    let last = read();
    let extended = win.screen?.isExtended;

    const checkScreen = (): void => {
        const now = read();

        if (
            now.width === last.width &&
            now.height === last.height &&
            now.dpr === last.dpr
        ) {
            return;
        }

        last = now;
        emit('browser.screen_changed', { ...now });
    };

    if (typeof extended === 'boolean') {
        emit('browser.multiple_screens', { extended });
    }

    context.on(win, 'resize', checkScreen);
    context.on(win.screen, 'change', () => {
        const now = win.screen?.isExtended;

        if (typeof now === 'boolean' && now !== extended) {
            extended = now;
            emit('browser.multiple_screens', { extended: now });
        }

        checkScreen();
    });
    context.every(LAYOUT_POLL_MS, () => {
        if (doc.visibilityState !== 'hidden') {
            checkScreen();
        }
    });
}
