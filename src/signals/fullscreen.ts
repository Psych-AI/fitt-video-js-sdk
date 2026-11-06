import type { SignalContext } from './index.ts';

export interface ActionResult {
    ok: boolean;
    reason?: string;
}

/** The reason a refused promise gives: the DOMException name, or not_allowed. */
function reasonOf(error: unknown): string {
    const name = (error as { name?: unknown } | null)?.name;

    return typeof name === 'string' && name !== '' ? name : 'not_allowed';
}

/** Entering and leaving fullscreen. */
export function startFullscreen(context: SignalContext): void {
    const { doc } = context.page;

    context.on(doc, 'fullscreenchange', () =>
        context.emit(
            doc.fullscreenElement === null
                ? 'browser.fullscreen_exit'
                : 'browser.fullscreen_enter',
        ),
    );
}

/**
 * Asks for fullscreen on `target`. Resolves `{ok: true}` once the document is
 * in fullscreen, else `{ok: false, reason}`; it never throws, also without a
 * user gesture or in a frame without `allow="fullscreen"`.
 */
export async function requestFullscreen(
    target: Element | null,
    doc: Document | null,
): Promise<ActionResult> {
    if (
        target === null ||
        doc === null ||
        typeof target.requestFullscreen !== 'function'
    ) {
        return { ok: false, reason: 'not_supported' };
    }

    if (doc.fullscreenEnabled === false) {
        return { ok: false, reason: 'not_allowed' };
    }

    try {
        await target.requestFullscreen();
    } catch (error) {
        return { ok: false, reason: reasonOf(error) };
    }

    return doc.fullscreenElement === null
        ? { ok: false, reason: 'not_allowed' }
        : { ok: true };
}

/**
 * Keyboard Lock, so Esc and Alt+Tab reach the page. It works only in the
 * top-level page during script-started fullscreen (spec 6.6), and only in
 * Chromium.
 */
export async function lockKeyboard(
    nav: Navigator | null,
    doc: Document | null,
): Promise<ActionResult> {
    const keyboard = (
        nav as { keyboard?: { lock?(keys?: string[]): Promise<void> } } | null
    )?.keyboard;

    if (typeof keyboard?.lock !== 'function') {
        return { ok: false, reason: 'not_supported' };
    }

    if (doc?.fullscreenElement == null) {
        return { ok: false, reason: 'not_fullscreen' };
    }

    try {
        await keyboard.lock();
    } catch (error) {
        return { ok: false, reason: reasonOf(error) };
    }

    return { ok: true };
}
