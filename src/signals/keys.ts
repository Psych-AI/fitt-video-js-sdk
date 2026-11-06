import type { SignalContext } from './index.ts';

/** The letters reported with Ctrl or Meta alone. */
const PLAIN_COMBOS: ReadonlySet<string> = new Set([
    'C',
    'V',
    'X',
    'P',
    'S',
    'U',
]);

/** The letters reported with Ctrl or Meta and Shift (the DevTools shortcuts). */
const SHIFT_COMBOS: ReadonlySet<string> = new Set(['I', 'J', 'C']);

/** The named combination this key press is, or null. Alt (and AltGr, which also sets Ctrl) is never one. */
function comboOf(event: KeyboardEvent): string | null {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey) {
        return null;
    }

    const letter = event.key.toUpperCase();
    const modifier = event.ctrlKey ? 'Ctrl' : 'Meta';

    if (event.shiftKey) {
        return SHIFT_COMBOS.has(letter) ? `${modifier}+Shift+${letter}` : null;
    }

    return PLAIN_COMBOS.has(letter) ? `${modifier}+${letter}` : null;
}

/** Print Screen and a fixed list of combinations. Never any other key, and never text. */
export function startKeys(context: SignalContext): void {
    const { page, emit } = context;

    context.on(
        page.doc,
        'keydown',
        (event) => {
            const key = event as KeyboardEvent;

            if (typeof key.key !== 'string') {
                return;
            }

            if (key.key === 'PrintScreen') {
                emit('browser.print_screen', {});

                return;
            }

            const combo = comboOf(key);

            if (combo !== null) {
                emit('browser.key_combo', { combo });
            }
        },
        { capture: true },
    );
}
