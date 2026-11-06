import type { SignalContext } from './index.ts';

/** The brief's target element type: the tag name in lower case, or null. */
function targetOf(event: Event): string | null {
    const target = event.target as { tagName?: unknown } | null;

    return typeof target?.tagName === 'string'
        ? target.tagName.toLowerCase()
        : null;
}

/**
 * The length of what is being copied or cut. An input or a textarea keeps
 * its selection out of getSelection(), so its own selection range is read.
 */
function selectionLength(context: SignalContext, event: Event): number {
    const field = event.target as {
        selectionStart?: unknown;
        selectionEnd?: unknown;
    } | null;

    if (
        typeof field?.selectionStart === 'number' &&
        typeof field.selectionEnd === 'number'
    ) {
        return Math.max(0, field.selectionEnd - field.selectionStart);
    }

    return context.page.doc.getSelection?.()?.toString().length ?? 0;
}

/** Copy, cut and paste with lengths and target types only, never the text; the context menu, drag and drop. */
export function startClipboard(context: SignalContext): void {
    const { page, emit } = context;
    const { doc } = page;
    const capture = { capture: true };

    for (const [type, name] of [
        ['copy', 'browser.copy'],
        ['cut', 'browser.cut'],
    ] as const) {
        context.on(
            doc,
            type,
            (event) =>
                emit(name, {
                    length: selectionLength(context, event),
                    target: targetOf(event),
                }),
            capture,
        );
    }

    context.on(
        doc,
        'paste',
        (event) => {
            const data = (event as ClipboardEvent).clipboardData;

            emit('browser.paste', {
                length: data?.getData('text').length ?? 0,
                target: targetOf(event),
            });
        },
        capture,
    );

    for (const [type, name] of [
        ['contextmenu', 'browser.context_menu'],
        ['dragstart', 'browser.drag_start'],
        ['drop', 'browser.drop'],
    ] as const) {
        context.on(doc, type, () => emit(name, {}), capture);
    }
}
