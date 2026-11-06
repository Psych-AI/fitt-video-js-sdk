import type { SignalContext } from './index.ts';

/** While visible, document.hasFocus() is read this often, for focus changes no window event reported. */
const FOCUS_POLL_MS = 1000;

/**
 * Visibility, window focus and the page going away. One `focused` flag is
 * kept by the window events and the hasFocus() poll together, so a change is
 * never reported twice.
 */
export function startAttention(context: SignalContext): void {
    const { page, emit } = context;
    const { win, doc } = page;
    let focused = doc.hasFocus();

    const setFocused = (next: boolean): void => {
        if (next === focused) {
            return;
        }

        focused = next;
        emit(next ? 'browser.focus' : 'browser.blur', {});
    };

    context.on(doc, 'visibilitychange', () => {
        emit(
            doc.visibilityState === 'hidden'
                ? 'browser.hidden'
                : 'browser.visible',
        );
    });
    context.on(win, 'blur', () => setFocused(false));
    context.on(win, 'focus', () => setFocused(true));
    context.every(FOCUS_POLL_MS, () => {
        if (doc.visibilityState !== 'hidden') {
            setFocused(doc.hasFocus());
        }
    });
    context.on(win, 'pagehide', () =>
        emit('browser.page_hidden', { reason: 'pagehide' }),
    );
    // Page Lifecycle: a frozen tab runs no more script until it resumes.
    context.on(doc, 'freeze', () =>
        emit('browser.page_hidden', { reason: 'freeze' }),
    );
}
