import type { WireAnswer } from './http.ts';

/**
 * What the SDK does with one answer from the API. Read against
 * `App\Enums\Video\ContractCode` (the status of each code),
 * `SegmentController` and `ErrorEnvelope` on the server, not against the
 * spec's 7.2 table. Codes are matched on `error.code`, never on `message`.
 */
export type Verdict =
    | { kind: 'ok'; code: string }
    | { kind: 'retry'; code: string; waitMs?: number }
    | { kind: 'refresh'; code: 'token_expired'; recoverable: boolean }
    | { kind: 'terminal'; code: string; status: number }
    | { kind: 'blocked'; code: 'origin_not_allowed' }
    | { kind: 'step_down'; reason: 'method' | 'proxy' };

/** Codes that are worth sending again as they are: the bytes or the server may do better next time. */
const RETRY_CODES = new Set([
    'hash_mismatch',
    'size_mismatch',
    'join_in_progress',
    'server_error',
]);

type Envelope = { code: string } & Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `{error: {code}}` envelope of the Fitt API, or null for any other body. */
function envelopeOf(body: unknown): Envelope | null {
    if (!isObject(body) || !isObject(body.error)) {
        return null;
    }

    return typeof body.error.code === 'string'
        ? (body.error as Envelope)
        : null;
}

export function classify(answer: WireAnswer): Verdict {
    const { status, body } = answer;

    if (answer.networkError || status === 0) {
        return { kind: 'retry', code: answer.timedOut ? 'timeout' : 'network' };
    }

    if (
        status >= 200 &&
        status < 300 &&
        isObject(body) &&
        typeof body.code === 'string'
    ) {
        return { kind: 'ok', code: body.code };
    }

    const envelope = envelopeOf(body);
    const code = envelope?.code;

    if (envelope !== null) {
        if (code === 'track_sealed' && envelope.stored === true) {
            return { kind: 'ok', code: 'track_sealed' };
        }

        if (RETRY_CODES.has(envelope.code)) {
            return { kind: 'retry', code: envelope.code };
        }

        if (code === 'rate_limited') {
            const retryAfter = envelope.retry_after;

            return typeof retryAfter === 'number' &&
                Number.isFinite(retryAfter) &&
                retryAfter >= 0
                ? { kind: 'retry', code, waitMs: retryAfter * 1000 }
                : { kind: 'retry', code };
        }

        if (code === 'token_expired') {
            return {
                kind: 'refresh',
                code,
                recoverable: envelope.recoverable === true,
            };
        }

        if (code === 'origin_not_allowed') {
            return { kind: 'blocked', code };
        }
    }

    if (status === 405) {
        return { kind: 'step_down', reason: 'method' };
    }

    if (status === 403 && envelope === null) {
        return { kind: 'step_down', reason: 'proxy' };
    }

    if (status >= 500 && status < 600) {
        return { kind: 'retry', code: code ?? `http_${status}` };
    }

    if (status >= 400 && status < 500) {
        // Every 4xx of the Fitt API is enveloped, so one without an envelope
        // came from an edge: it is retried, and the age rule decides.
        return envelope === null
            ? { kind: 'retry', code: `http_${status}` }
            : { kind: 'terminal', code: envelope.code, status };
    }

    return { kind: 'retry', code: `http_${status}` };
}
