import { sha256Hex } from '../../src/core/crypto.ts';
import type { Descriptor, TrackName } from '../../src/core/descriptor.ts';
import type { Environment } from '../../src/core/env.ts';
import { createLadder } from '../../src/core/ladder.ts';
import { createQueue } from '../../src/core/queue.ts';
import type { SegmentRecord } from '../../src/core/store.ts';
import { MemoryQueueStore } from '../../src/core/store.ts';
import type { TokenKeeper } from '../../src/core/token.ts';
import { createTokenKeeper } from '../../src/core/token.ts';
import { createUploader } from '../../src/core/uploader.ts';
import type { FakeEnvironment, FetchCall } from './fake-env.ts';
import { fakeEnvironment, json } from './fake-env.ts';
import { descriptorFixture, segmentRecord } from './records.ts';

/** The answer to a whole segment the server stored. */
export function STORED(): Response {
    return json(201, { code: 'stored', segment: {} });
}

/** The track a segment request was sent for, read from its URL. */
export function trackOf(call: FetchCall): string {
    const match = /\/tracks\/(\w+)\//.exec(call.url);

    if (match === null) {
        throw new Error(`No track in ${call.url}`);
    }

    return match[1];
}

/** The seq a segment request was sent for, read from its URL. */
export function seqOf(call: FetchCall): number {
    const match = /\/segments\/(\d+)/.exec(call.url);

    if (match === null) {
        throw new Error(`No seq in ${call.url}`);
    }

    return Number(match[1]);
}

/** A keeper whose refresh answers 409 session_closed, so it stops for good. */
export function quietKeeper(env: Environment): TokenKeeper {
    return createTokenKeeper({
        env,
        descriptor: descriptorFixture(),
        refresh: async () => ({
            status: 409,
            body: { error: { code: 'session_closed', message: 'x' } },
            networkError: false,
            timedOut: false,
        }),
        onDescriptor: () => {},
        emit: () => {},
        setError: () => {},
    });
}

export interface RigOptions {
    env?: FakeEnvironment;
    token?: TokenKeeper;
    forcePost?: boolean;
    descriptor?: Descriptor;
    currentTake?: number;
    abandonAfterMs?: number;
}

/** An uploader over a memory store and a fake environment, with everything it reports collected. */
export function rig(options: RigOptions = {}) {
    const env = options.env ?? fakeEnvironment();
    const descriptor = options.descriptor ?? descriptorFixture();
    const store = new MemoryQueueStore();
    const queue = createQueue(store, {
        abandonAfterMs: options.abandonAfterMs ?? 600_000,
        budgetBytes: 209_715_200,
        perfNow: () => env.perfNow(),
    });
    const ladder = createLadder({
        rung: 'put',
        everSucceeded: false,
        forcePost: options.forcePost,
        persist: async () => {},
        emit: () => {},
    });
    const events: [string, Record<string, unknown>][] = [];
    const abandoned: TrackName[] = [];
    const behind: number[] = [];
    const warnings: string[] = [];
    const uploader = createUploader({
        env,
        store,
        queue,
        now: () => Math.floor(env.perfNow()),
        tracks: () => descriptor.tracks,
        token: options.token ?? quietKeeper(env),
        ladder,
        emit: (type, payload) => events.push([type, payload]),
        onAbandon: (track) => abandoned.push(track),
        currentTake: () => options.currentTake ?? 1,
        onTakeBehind: (take) => behind.push(take),
        warn: (message) => warnings.push(message),
    });

    return { env, store, queue, uploader, events, abandoned, behind, warnings };
}

export type Rig = ReturnType<typeof rig>;

/** Stores a segment whose bytes are all seq + 1, hashed for real, and hands it to the uploader. */
export async function add(
    r: Rig,
    overrides: Partial<SegmentRecord>,
): Promise<SegmentRecord> {
    const bytes = overrides.bytes ?? 300;
    const data = new Uint8Array(bytes).fill((overrides.seq ?? 1) + 1).buffer;
    const record = segmentRecord({
        ...overrides,
        bytes,
        data,
        sha256: await sha256Hex(data),
    });
    await r.queue.add(record);
    r.uploader.enqueue(record);

    return record;
}
