import type { SignalContext } from './index.ts';

/** The window's online and offline events, and the connection type where the browser exposes it. */
export function startNet(context: SignalContext): void {
    const { page, emit } = context;
    const connection = page.nav?.connection;

    context.on(page.win, 'online', () => emit('net.online'));
    context.on(page.win, 'offline', () => emit('net.offline'));
    context.on(connection, 'change', () =>
        emit('net.connection_changed', {
            // Desktop Chrome has no `type`; a browser that hides a field gives null.
            type: connection?.type ?? null,
            effective_type: connection?.effectiveType ?? null,
        }),
    );
}
