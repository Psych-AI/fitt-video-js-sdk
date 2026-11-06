/**
 * The one seam to the browser's globals. Every module reads time, timers,
 * randomness, fetch and the network state through an Environment, so tests
 * inject their own.
 */
export interface Timers {
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(handle: number): void;
}

export interface Environment {
    perfNow(): number;
    readonly timeOrigin: number;
    dateNow(): number;
    readonly timers: Timers;
    random(): number;
    randomBytes(length: number): Uint8Array;
    fetch(url: string, init: RequestInit): Promise<Response>;
    online(): boolean;
    /** Fires 'online' and 'offline' (the window in a browser). */
    readonly onlineTarget: EventTarget | null;
}

/** The only members a host may override (the playground's faults, author's call 14). */
export type EnvironmentOverrides = {
    fetch?: Environment['fetch'];
    online?: Environment['online'];
    onlineTarget?: EventTarget | null;
};

/** getRandomValues refuses more than this many bytes in one call. */
const RANDOM_STEP = 65_536;

/** The browser's globals, read when called, never at import. Overrides win. */
export function browserEnvironment(
    overrides: EnvironmentOverrides = {},
): Environment {
    const timers: Timers = {
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (handle) => window.clearTimeout(handle),
    };

    return {
        perfNow: () => performance.now(),
        get timeOrigin(): number {
            return performance.timeOrigin;
        },
        dateNow: () => Date.now(),
        timers,
        random: () => Math.random(),
        randomBytes(length: number): Uint8Array {
            const bytes = new Uint8Array(length);

            for (let offset = 0; offset < length; offset += RANDOM_STEP) {
                crypto.getRandomValues(
                    bytes.subarray(
                        offset,
                        Math.min(offset + RANDOM_STEP, length),
                    ),
                );
            }

            return bytes;
        },
        fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
        online: overrides.online ?? (() => navigator.onLine),
        get onlineTarget(): EventTarget | null {
            if ('onlineTarget' in overrides) {
                return overrides.onlineTarget ?? null;
            }

            return typeof window === 'undefined' ? null : window;
        },
    };
}
