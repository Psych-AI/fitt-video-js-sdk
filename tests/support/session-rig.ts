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

/** The session's seams over a fake environment, a memory store, fake media and a fake page. */
export function rigSeams(
    env: FakeEnvironment,
    store: MemoryQueueStore,
    media: ReturnType<typeof fakeMedia>,
    storage = new Map<string, string>(),
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
    const seams = rigSeams(env, store, media, storage);
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
