import type { SignalContext } from './index.ts';

/**
 * A try to leave the page. It only observes: it never calls preventDefault()
 * or sets returnValue, so the candidate is never asked to stay.
 */
export function startPage(context: SignalContext): void {
    context.on(context.page.win, 'beforeunload', () =>
        context.emit('page.leave_attempt', {}),
    );
}
