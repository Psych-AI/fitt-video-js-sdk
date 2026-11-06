import type { Environment } from './env.ts';
import type { WireRequest } from './wire.ts';

/** What one request came back with. Status 0 means no answer reached the page. */
export interface WireAnswer {
    status: number;
    body: unknown;
    networkError: boolean;
    timedOut: boolean;
}

const TIMEOUT_MS = 30_000;

/**
 * The body as JSON when the Content-Type says so and it parses, else the
 * text, or null when there is none or it cannot be read to the end.
 */
async function readBody(response: Response): Promise<unknown> {
    let text: string;

    try {
        text = await response.text();
    } catch {
        return null;
    }

    if (text === '') {
        return null;
    }

    if (/\bjson\b/i.test(response.headers.get('Content-Type') ?? '')) {
        try {
            return JSON.parse(text) as unknown;
        } catch {
            return text;
        }
    }

    return text;
}

/**
 * Sends one request and never throws. Cookies are never sent (the token is
 * the only credential), and the request is aborted after 30 s unless the
 * caller gives another limit. A refused origin, a blocked preflight and an
 * offline network all look the same here: status 0 with `networkError`.
 */
export async function send(
    env: Environment,
    request: WireRequest,
    timeoutMs?: number,
): Promise<WireAnswer> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = env.timers.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs ?? TIMEOUT_MS);

    try {
        let response: Response;

        try {
            response = await env.fetch(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                keepalive: request.keepalive ?? false,
                credentials: 'omit',
                referrerPolicy: 'strict-origin-when-cross-origin',
                signal: controller.signal,
            });
        } catch {
            return { status: 0, body: null, networkError: true, timedOut };
        }

        return {
            status: response.status,
            body: await readBody(response),
            networkError: false,
            timedOut: false,
        };
    } finally {
        env.timers.clearTimeout(timer);
    }
}
