import type { Descriptor } from '../../src/core/descriptor.ts';
import type { SessionOptions } from '../../src/core/options.ts';
import type { SessionSeams } from '../../src/core/session.ts';
import { createSession } from '../../src/core/session.ts';
import { MemoryQueueStore } from '../../src/core/store.ts';
import type { FakeEnvironment, FetchCall } from './fake-env.ts';
import { fakeEnvironment, json } from './fake-env.ts';
import { fakeMedia } from './fake-media.ts';
import { fakePage } from './fake-page.ts';
import { readSet } from './fixtures.ts';
import { descriptorFixture } from './records.ts';

/** A GET /status body with these checks. */
export function statusBody(
    checks: Record<string, unknown>,
    extra: Record<string, unknown> = {},
) {
    return {
        session: { id: 'x', status: 'open', take: 1, end_ms: null },
        tracks: [],
        checks,
        upload: { bytes_received: 0 },
        ...extra,
    };
}

export type Answer = (call: FetchCall) => Response | Promise<Response>;

/** The API's usual answers; the first override whose key the URL contains wins. */
export function router(overrides: Record<string, Answer> = {}): Answer {
    return (call) => {
        for (const [key, answer] of Object.entries(overrides)) {
            if (call.url.includes(key)) {
                return answer(call);
            }
        }

        if (call.url.includes('/segments/')) {
            return json(201, { code: 'stored', segment: {} });
        }

        if (call.url.endsWith('/manifest')) {
            return json(200, {
                track: {
                    sealed: true,
                    segments: {
                        expected: 0,
                        present: 1,
                        missing: 0,
                        abandoned: 0,
                    },
                },
                late_window_s: 0,
            });
        }

        if (call.url.includes('/events')) {
            return json(204);
        }

        if (call.url.includes('/reset')) {
            return json(200, { take: 2 });
        }

        if (call.url.includes('/discard') || call.url.includes('/finalise')) {
            return json(200, { session: { id: 'x', status: 'finalising' } });
        }

        if (call.url.includes('/status')) {
            return json(
                200,
                statusBody({
                    status: 'pending',
                    verdict: null,
                    take: 1,
                    reasons: [],
                }),
            );
        }

        return json(404, { error: { code: 'not_found', message: 'x' } });
    };
}

type Locks = NonNullable<SessionSeams['locks']>;
type ChannelFactory = NonNullable<SessionSeams['channel']>;
type LockCallback = (
    lock: { name: string; mode: 'exclusive' } | null,
) => unknown;

/**
 * Web Locks for one origin. Names in `heldElsewhere` are held for good by
 * another tab. A free name is granted at once and released when the
 * promise its callback returns settles; the next waiting request for it is
 * then granted. A held name with ifAvailable runs callback(null) at once;
 * without it the request waits.
 */
export function fakeLocks(heldElsewhere: string[] = []): Locks {
    const held = new Set<string>(heldElsewhere);
    const waiting = new Map<string, (() => void)[]>();

    const run = (name: string, callback: LockCallback): Promise<unknown> => {
        held.add(name);
        let outcome: Promise<unknown>;

        try {
            outcome = Promise.resolve(callback({ name, mode: 'exclusive' }));
        } catch (error) {
            outcome = Promise.reject(error);
        }

        const release = (): void => {
            held.delete(name);
            waiting.get(name)?.shift()?.();
        };
        outcome.then(release, release);

        return outcome;
    };

    const locks = {
        request(
            name: string,
            optionsOrCallback: { ifAvailable?: boolean } | LockCallback,
            maybeCallback?: LockCallback,
        ): Promise<unknown> {
            const callback =
                typeof optionsOrCallback === 'function'
                    ? optionsOrCallback
                    : (maybeCallback as LockCallback);
            const options =
                typeof optionsOrCallback === 'function'
                    ? {}
                    : optionsOrCallback;

            if (!held.has(name)) {
                return run(name, callback);
            }

            if (options.ifAvailable === true) {
                try {
                    return Promise.resolve(callback(null));
                } catch (error) {
                    return Promise.reject(error);
                }
            }

            return new Promise((resolve, reject) => {
                const queue = waiting.get(name) ?? [];
                waiting.set(name, queue);
                queue.push(() => {
                    run(name, callback).then(resolve, reject);
                });
            });
        },
        query: async () => ({
            held: [...held].map((name) => ({ name, mode: 'exclusive' })),
            pending: [],
        }),
    };

    return locks as unknown as Locks;
}

/**
 * A Lock API that is there but refuses: request() and query() reject with a
 * SecurityError before any callback runs, as in a sandboxed or opaque-origin
 * frame.
 */
export function rejectingLocks(): Locks {
    const refuse = (): Promise<never> =>
        Promise.reject(
            new DOMException('The request was denied.', 'SecurityError'),
        );

    return { request: refuse, query: refuse } as unknown as Locks;
}

/**
 * One in-memory BroadcastChannel bus shared by every channel it makes.
 * postMessage(data) delivers {data} on a later microtask to the message
 * listeners of every other open channel of the same name; close() stops a
 * channel sending and receiving.
 */
export function fakeChannels(): { channel: ChannelFactory } {
    interface FakeChannel {
        name: string;
        closed: boolean;
        listeners: Set<(event: { data: unknown }) => void>;
    }

    const open = new Set<FakeChannel>();

    const channel = (name: string) => {
        const self: FakeChannel = { name, closed: false, listeners: new Set() };
        open.add(self);

        return {
            postMessage(data: unknown): void {
                if (self.closed) {
                    return;
                }

                for (const other of open) {
                    if (other === self || other.name !== name) {
                        continue;
                    }

                    const copy = structuredClone(data);
                    queueMicrotask(() => {
                        if (!other.closed) {
                            for (const listener of [...other.listeners]) {
                                listener({ data: copy });
                            }
                        }
                    });
                }
            },
            addEventListener(
                type: string,
                listener: (event: { data: unknown }) => void,
            ): void {
                if (type === 'message') {
                    self.listeners.add(listener);
                }
            },
            close(): void {
                self.closed = true;
                open.delete(self);
            },
        };
    };

    return { channel: channel as unknown as ChannelFactory };
}

/** The session's seams over a fake environment, a memory store, fake media and a fake page. */
export function rigSeams(
    env: FakeEnvironment,
    store: MemoryQueueStore,
    media: ReturnType<typeof fakeMedia>,
    storage = new Map<string, string>(),
    locks: SessionSeams['locks'] = null,
    channel: SessionSeams['channel'] = null,
): SessionSeams {
    return {
        env,
        media,
        recorderFactory: media.recorderFactory,
        makeStream: media.makeStream,
        isTypeSupported: () => true,
        permissions: undefined,
        page: fakePage(),
        createAudioContext: null,
        storage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => {
                storage.set(key, value);
            },
            removeItem: (key) => {
                storage.delete(key);
            },
        },
        indexedDB: undefined,
        store,
        locks,
        channel,
    };
}

/** A session over the rig seams; the fake env reaches it through the seams, never options.environment. */
export function sessionRig(
    options: {
        recipe?: string;
        descriptor?: Descriptor;
        store?: MemoryQueueStore;
        env?: FakeEnvironment;
        refuse?: string;
        chunks?: boolean;
        options?: SessionOptions;
        locks?: SessionSeams['locks'];
        channel?: SessionSeams['channel'];
    } = {},
) {
    const env = options.env ?? fakeEnvironment();
    const store = options.store ?? new MemoryQueueStore();
    const storage = new Map<string, string>();
    const media = fakeMedia(env, {
        chunks: options.chunks
            ? readSet('chrome-vp8-kf').blobs.slice(0, 4)
            : [],
    });

    if (options.refuse !== undefined) {
        media.refuse(options.refuse);
    }

    const descriptor =
        options.descriptor ?? descriptorFixture(options.recipe ?? 'monitor');
    env.respond(router());
    const seams = rigSeams(
        env,
        store,
        media,
        storage,
        options.locks ?? null,
        options.channel ?? null,
    );
    const session = createSession(descriptor, options.options ?? {}, seams);
    const calls = (pattern: RegExp): FetchCall[] =>
        env.calls.filter((call) => pattern.test(call.url));

    return {
        env,
        store,
        storage,
        media,
        descriptor,
        session,
        /** The fake page the session listens on. */
        page: seams.page!,
        respond(overrides: Record<string, Answer>): void {
            env.respond(router(overrides));
        },
        calls,
        bodies(): {
            batch_seq: number;
            clock_epoch_ms: number;
            events: { type: string; t_ms: number; payload?: unknown }[];
        }[] {
            return calls(/\/events$/).map((call) =>
                JSON.parse(String(call.body)),
            );
        },
        manifestCalls: (): FetchCall[] => calls(/\/manifest$/),
        segmentCalls: (): FetchCall[] => calls(/\/segments\//),
    };
}

export type SessionRig = ReturnType<typeof sessionRig>;

/** prepare(), start(), the countdown, `recordMs` of recording, then stop() and its answers. */
export async function recordTake(
    r: SessionRig,
    recordMs: number,
): Promise<void> {
    await r.session.prepare();
    const starting = r.session.start();
    await r.env.advance(r.descriptor.recording?.countdown_ms ?? 0);
    await starting;
    await r.env.advance(recordMs);
    const stopping = r.session.stop();
    await r.env.advance(10);
    await stopping;
}
