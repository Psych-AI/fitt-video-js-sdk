import { backoffMs } from './backoff.ts';
import type { Descriptor, TrackName } from './descriptor.ts';
import type { Environment } from './env.ts';
import { FittVideoError } from './errors.ts';
import type { WireAnswer } from './http.ts';
import { send } from './http.ts';
import type { ManifestBody } from './manifest.ts';
import { classify } from './responses.ts';
import type { TokenKeeper } from './token.ts';
import type { TokenRef } from './wire.ts';
import { eventsRequest, jsonRequest } from './wire.ts';

/**
 * The session's JSON calls. Each method sends one request and never throws;
 * callWithRetry() decides whether to send it again.
 */
export interface SessionApi {
    postManifest(track: TrackName, body: ManifestBody): Promise<WireAnswer>;
    finalise(endMs: number): Promise<WireAnswer>;
    reset(take: number): Promise<WireAnswer>;
    discard(): Promise<WireAnswer>;
    status(): Promise<WireAnswer>;
    refresh(token: TokenRef): Promise<WireAnswer>;
    events(body: string, keepalive: boolean): Promise<WireAnswer>;
    transcript(body: TranscriptBody): Promise<WireAnswer>;
}

export interface TranscriptUpload {
    timing: 'exact' | 'approximate' | 'none';
    offset_ms?: number;
    language?: string;
    segments: {
        start_ms?: number;
        end_ms?: number;
        text: string;
        speaker?: string;
        role?: 'candidate' | 'other';
    }[];
}

export type TranscriptBody = TranscriptUpload;

/** How often a wait for the network looks again, for an online() override that fires no event. */
const ONLINE_POLL_MS = 1_000;

/**
 * Every URL is built from `endpoints.api` and the session id, read on each
 * call, never from an upload URL (Plan 8's direct mode moves those).
 */
export function createSessionApi(
    env: Environment,
    descriptor: () => Descriptor,
    token: () => TokenRef,
): SessionApi {
    const url = (path: string): string => {
        const current = descriptor();

        return `${current.endpoints.api}/sessions/${current.session_id}/${path}`;
    };
    const call = (
        path: string,
        method: 'GET' | 'POST',
        body?: unknown,
    ): Promise<WireAnswer> =>
        send(env, jsonRequest(url(path), token(), method, body));

    return {
        postManifest: (track, body) =>
            call(`tracks/${track}/manifest`, 'POST', body),
        finalise: (endMs) => call('finalise', 'POST', { end_ms: endMs }),
        reset: (take) => call('reset', 'POST', { take }),
        discard: () => call('discard', 'POST'),
        status: () => call('status', 'GET'),
        refresh: (used) =>
            send(env, jsonRequest(url('refresh-upload'), used, 'POST')),
        events: (body, keepalive) =>
            send(env, eventsRequest(url('events'), token(), body, keepalive)),
        // Plan 5's route (spec 6.8): a 404 until it ships.
        transcript: (body) => call('transcript', 'POST', body),
    };
}

function sleep(env: Environment, ms: number): Promise<void> {
    return new Promise((resolve) => {
        env.timers.setTimeout(resolve, Math.max(0, ms));
    });
}

/** Resolves on the `online` event, or on the next look that finds the network back. */
function untilOnline(env: Environment): Promise<void> {
    return new Promise((resolve) => {
        const target = env.onlineTarget;
        let timer: number | null = null;
        const done = (): void => {
            target?.removeEventListener('online', done);

            if (timer !== null) {
                env.timers.clearTimeout(timer);
            }

            resolve();
        };
        const look = (): void => {
            timer = null;

            if (env.online()) {
                done();
            } else {
                timer = env.timers.setTimeout(look, ONLINE_POLL_MS);
            }
        };

        target?.addEventListener('online', done);
        timer = env.timers.setTimeout(look, ONLINE_POLL_MS);
    });
}

/**
 * Calls until a final answer: waits while offline, backoffMs() on retry verdicts, error.retry_after on a 429,
 * token.ready() after a token_expired. A 2xx and the final refusals (409 stale_take, track_sealed, session_closed,
 * discarded, any other terminal 4xx) are returned. Used for manifests, reset, discard and finalise. onSuccess runs on every 2xx (the ladder's markSucceeded()).
 *
 * The `call` reads the keeper's current token itself; the id read here
 * before each call is the one a token_expired answer is laid against.
 * `blocked` and `step_down` verdicts are returned too: the caller decides.
 */
export async function callWithRetry(
    deps: {
        env: Environment;
        token: Pick<TokenKeeper, 'current' | 'expired' | 'ready'>;
        onSuccess?(): void;
    },
    call: () => Promise<WireAnswer>,
): Promise<WireAnswer> {
    const { env, token } = deps;
    let attempt = 0;

    for (;;) {
        while (!env.online()) {
            await untilOnline(env);
        }

        const usedId = token.current().id;
        const answer = await call();

        // These JSON answers carry no `code`, so a 2xx is always final here.
        if (answer.status >= 200 && answer.status < 300) {
            deps.onSuccess?.();

            return answer;
        }

        const verdict = classify(answer);

        if (verdict.kind === 'retry') {
            attempt += 1;
            await sleep(
                env,
                verdict.waitMs ?? backoffMs(attempt, env.random()),
            );

            continue;
        }

        if (verdict.kind === 'refresh') {
            if (token.expired(usedId) === 'paused') {
                await token.ready();
            }

            continue;
        }

        return answer;
    }
}

/** Throws FittVideoError('config_invalid') when offset_ms is missing for timed text; drops offset_ms for 'none'. */
export function transcriptBody(upload: TranscriptUpload): TranscriptBody {
    if (upload.timing === 'none') {
        const body: TranscriptBody = { ...upload };
        delete body.offset_ms;

        return body;
    }

    const offset = upload.offset_ms;

    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        throw new FittVideoError('config_invalid', { path: 'offset_ms' });
    }

    return { ...upload };
}
