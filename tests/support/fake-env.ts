import type { Environment, Timers } from '../../src/core/env.ts';

export interface FetchCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: ArrayBuffer | string | undefined;
    keepalive: boolean;
    /** performance.now() when the request was made. */
    at: number;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

export interface FakeEnvironment extends Environment {
    /** Moves both clocks by `ms`, running every timer that falls due, in due order. */
    advance(ms: number): Promise<void>;
    /** Moves both clocks without running timers: a throttled or frozen tab. */
    stall(ms: number): void;
    /** Moves only Date.now(). */
    shiftWall(ms: number): void;
    setOnline(online: boolean): void;
    respond(handler: FetchHandler): void;
    readonly calls: FetchCall[];
}

export interface FakeEnvironmentOptions {
    timeOrigin?: number;
    perf?: number;
    date?: number;
    random?: number;
}

interface PendingTimer {
    id: number;
    due: number;
    callback: () => void;
}

/** A Response with no body when `body` is undefined, else the JSON string. */
export function json(status: number, body?: unknown): Response {
    if (body === undefined) {
        return new Response(null, { status });
    }

    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Five setImmediate turns, then one setTimeout(0), so pending promises, WebCrypto included, run. */
export async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Polls on setImmediate until the predicate holds, measured in real time. */
export async function until(
    predicate: () => boolean,
    timeoutMs = 10_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }

        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (!predicate()) {
        throw new Error('The condition never became true.');
    }
}

function copyHeaders(headers: HeadersInit | undefined): Record<string, string> {
    if (headers === undefined) {
        return {};
    }

    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }

    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }

    return { ...headers };
}

function copyBody(
    body: BodyInit | null | undefined,
): ArrayBuffer | string | undefined {
    if (typeof body === 'string' || body instanceof ArrayBuffer) {
        return body;
    }

    if (ArrayBuffer.isView(body)) {
        return new Uint8Array(
            body.buffer,
            body.byteOffset,
            body.byteLength,
        ).slice().buffer;
    }

    return undefined;
}

/** An Environment whose clocks, timers, network state and fetch the test drives. */
export function fakeEnvironment(
    options: FakeEnvironmentOptions = {},
): FakeEnvironment {
    const timeOrigin = options.timeOrigin ?? 1_762_400_000_000;
    let perf = options.perf ?? 0;
    let date = options.date ?? timeOrigin + perf;
    let isOnline = true;
    let nextId = 1;
    let pending: PendingTimer[] = [];
    let handler: FetchHandler = () => json(500);
    const calls: FetchCall[] = [];
    const onlineTarget = new EventTarget();

    const move = (ms: number): void => {
        perf += ms;
        date += ms;
    };

    const timers: Timers = {
        setTimeout(callback: () => void, ms: number): number {
            const id = nextId++;
            pending.push({ id, due: perf + Math.max(0, ms), callback });

            return id;
        },
        clearTimeout(handle: number): void {
            pending = pending.filter((timer) => timer.id !== handle);
        },
    };

    const nextDue = (end: number): PendingTimer | undefined =>
        pending
            .filter((timer) => timer.due <= end)
            .sort((a, b) => a.due - b.due || a.id - b.id)[0];

    return {
        perfNow: () => perf,
        timeOrigin,
        dateNow: () => date,
        timers,
        frames: {
            request: (callback: (timeMs: number) => void): number =>
                timers.setTimeout(() => callback(perf), 16),
            cancel: (handle: number): void => timers.clearTimeout(handle),
        },
        random: () => options.random ?? 0.5,
        randomBytes: (length: number) =>
            crypto.getRandomValues(new Uint8Array(length)),
        fetch(url: string, init: RequestInit): Promise<Response> {
            const call: FetchCall = {
                url,
                method: init.method ?? 'GET',
                headers: copyHeaders(init.headers),
                body: copyBody(init.body),
                keepalive: init.keepalive === true,
                at: perf,
            };
            calls.push(call);
            const signal = init.signal ?? null;

            return new Promise<Response>((resolve, reject) => {
                const abort = (): void =>
                    reject(
                        new DOMException(
                            'The operation was aborted.',
                            'AbortError',
                        ),
                    );

                if (signal?.aborted) {
                    abort();

                    return;
                }

                signal?.addEventListener('abort', abort, { once: true });
                Promise.resolve()
                    .then(() => handler(call))
                    .then(resolve, reject)
                    .finally(() => signal?.removeEventListener('abort', abort));
            });
        },
        online: () => isOnline,
        onlineTarget,
        async advance(ms: number): Promise<void> {
            await settle();
            const end = perf + ms;

            for (
                let timer = nextDue(end);
                timer !== undefined;
                timer = nextDue(end)
            ) {
                pending = pending.filter((other) => other !== timer);
                move(Math.max(perf, timer.due) - perf);
                timer.callback();
                await settle();
            }

            move(Math.max(perf, end) - perf);
            await settle();
        },
        stall(ms: number): void {
            move(ms);
        },
        shiftWall(ms: number): void {
            date += ms;
        },
        setOnline(online: boolean): void {
            isOnline = online;
            onlineTarget.dispatchEvent(
                new Event(online ? 'online' : 'offline'),
            );
        },
        respond(next: FetchHandler): void {
            handler = next;
        },
        calls,
    };
}
