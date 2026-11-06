import type { Clock } from '../core/clock.ts';
import type { Environment } from '../core/env.ts';
import type { EventBus } from '../core/events.ts';
import { startAttention } from './attention.ts';
import { startClipboard } from './clipboard.ts';
import { startFullscreen } from './fullscreen.ts';
import { startInput } from './input.ts';
import { startKeys } from './keys.ts';
import { startNet } from './net.ts';
import { startPage } from './page.ts';
import { startScreen } from './screen.ts';
import { startWindow } from './window.ts';

/**
 * The page the signals watch: the window, the document and the navigator,
 * or test doubles of the members the SDK reads. Nothing here needs a
 * permission.
 */
export interface PageLike {
    win: EventTarget & {
        innerWidth: number;
        innerHeight: number;
        outerWidth: number;
        outerHeight: number;
        screenX: number;
        screenY: number;
        screen?: {
            width: number;
            height: number;
            isExtended?: boolean;
        } & Partial<EventTarget>;
        devicePixelRatio?: number;
        top?: unknown;
    };
    doc: EventTarget & {
        visibilityState: string;
        hasFocus(): boolean;
        fullscreenElement: Element | null;
        getSelection?(): { toString(): string } | null;
        documentElement?: EventTarget;
        /** The session's own stall-watch element (Task 15); absent in Node. */
        createElement?(tag: 'video'): HTMLVideoElement;
        body?: { appendChild(node: Node): Node } | null;
    };
    nav?: {
        userAgent: string;
        languages?: readonly string[];
        maxTouchPoints?: number;
        connection?: {
            effectiveType?: string;
            type?: string;
        } & Partial<EventTarget>;
    };
}

/** What each signal module is handed. Every listener and timer it adds through it is removed by the stop function. */
export interface SignalContext {
    page: PageLike;
    env: Environment;
    clock: Clock;
    emit: EventBus['emit'];
    idleMs: number;
    resizeDebounceMs: number;
    /** Adds a listener; a target that is absent or no event target is skipped. */
    on(
        target: Partial<EventTarget> | null | undefined,
        type: string,
        handler: (event: Event) => void,
        options?: AddEventListenerOptions,
    ): void;
    /** Calls `tick` every `ms` until the signals stop. */
    every(ms: number, tick: () => void): void;
    /** Runs at stop, for a module's own timers. */
    onStop(cleanup: () => void): void;
}

/** The SDK's own input-idle threshold: Idle Detection rejects anything under 60 s and prompts. */
const IDLE_MS = 30_000;

/** Resize events are reported once, this long after the last one. */
const RESIZE_DEBOUNCE_MS = 300;

/**
 * Starts every page signal of the brief's catalogue as spec 6.6 corrects it,
 * with no permission-prompting API (author's call 13). Returns the function
 * that removes every listener and timer again.
 */
export function startSignals(deps: {
    page: PageLike;
    env: Environment;
    clock: Clock;
    emit: EventBus['emit'];
    idleMs?: number;
    resizeDebounceMs?: number;
}): () => void {
    const cleanups: (() => void)[] = [];
    let stopped = false;

    const context: SignalContext = {
        page: deps.page,
        env: deps.env,
        clock: deps.clock,
        emit: deps.emit,
        idleMs: deps.idleMs ?? IDLE_MS,
        resizeDebounceMs: deps.resizeDebounceMs ?? RESIZE_DEBOUNCE_MS,
        on(target, type, handler, options) {
            if (
                typeof target?.addEventListener !== 'function' ||
                typeof target.removeEventListener !== 'function'
            ) {
                return;
            }

            const listener = (event: Event): void => {
                try {
                    handler(event);
                } catch (error) {
                    // A signal that fails must never break the host page.
                    console.error(error);
                }
            };
            target.addEventListener(type, listener, options);
            cleanups.push(() =>
                target.removeEventListener?.(type, listener, options),
            );
        },
        every(ms, tick) {
            let handle: number | null = null;
            const schedule = (): void => {
                handle = deps.env.timers.setTimeout(() => {
                    handle = null;

                    if (stopped) {
                        return;
                    }

                    try {
                        tick();
                    } catch (error) {
                        console.error(error);
                    }

                    schedule();
                }, ms);
            };
            schedule();
            cleanups.push(() => {
                if (handle !== null) {
                    deps.env.timers.clearTimeout(handle);
                    handle = null;
                }
            });
        },
        onStop(cleanup) {
            cleanups.push(cleanup);
        },
    };

    for (const start of [
        startAttention,
        startWindow,
        startScreen,
        startFullscreen,
        startKeys,
        startClipboard,
        startInput,
        startNet,
        startPage,
    ]) {
        start(context);
    }

    return () => {
        if (stopped) {
            return;
        }

        stopped = true;

        for (const cleanup of cleanups.splice(0)) {
            cleanup();
        }
    };
}

/** True inside a frame; a cross-origin `top` that throws counts as a frame. */
function inIframe(win: PageLike['win']): boolean {
    try {
        return win.top !== win;
    } catch {
        return true;
    }
}

/**
 * The facts `session.environment` carries, read with no permission prompt:
 * no clock skew (there is no source for it, author's call 13) and no Window
 * Management. `extra` holds the SDK version and the device labels, which are
 * readable once capture is granted. Task 15 emits it once.
 */
export function environmentSnapshot(
    page: PageLike,
    extra: Record<string, unknown>,
): Record<string, unknown> {
    const { win, nav } = page;
    const screen = win.screen;

    return {
        ua: nav?.userAgent ?? null,
        languages: [...(nav?.languages ?? [])],
        screen: {
            width: screen?.width ?? null,
            height: screen?.height ?? null,
            dpr: win.devicePixelRatio ?? 1,
            ...(typeof screen?.isExtended === 'boolean'
                ? { extended: screen.isExtended }
                : {}),
        },
        viewport: { width: win.innerWidth, height: win.innerHeight },
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        in_iframe: inIframe(win),
        touch_points: nav?.maxTouchPoints ?? 0,
        network_type: nav?.connection?.effectiveType ?? null,
        ...extra,
    };
}
