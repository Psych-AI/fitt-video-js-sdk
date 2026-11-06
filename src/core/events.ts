import type { Clock } from './clock.ts';
import type { Environment } from './env.ts';
import { groupOf, hostType } from './event-types.ts';
import { ulid } from './ulid.ts';

/**
 * The event bus (author's call 11): every event gets a ULID and a session
 * time on the one clock, passes the group table, is made well-formed and
 * measured as the server measures it, reaches the listeners and is then
 * queued for upload.
 */
export interface SdkEvent {
    id: string;
    t_ms: number;
    duration_ms?: number;
    type: string;
    source: 'browser' | 'host';
    confidence?: number;
    payload?: Record<string, unknown> | unknown[];
}

export interface EventBus {
    /** An SDK event; null when its group is off. Listeners run before it is queued for upload. */
    emit(
        type: string,
        payload?: Record<string, unknown>,
        extra?: { duration_ms?: number; confidence?: number },
    ): SdkEvent | null;
    /** session.event(): false when the type would be refused. */
    host(type: string, payload?: Record<string, unknown> | unknown[]): boolean;
    on(listener: (event: SdkEvent) => void): () => void;
}

/** A payload larger than this (as PHP counts it) is replaced by its size: a margin under the server's 16,384. */
export const PAYLOAD_MAX_BYTES = 16_000;

type Payload = Record<string, unknown> | unknown[];

/** NUL and lone surrogates become U+FFFD; a valid surrogate pair stays. */
const ILL_FORMED = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]|\u0000/g;

/** PHP writes each of these as a 6-byte escape; JSON.stringify writes the 3 UTF-8 bytes. */
const LINE_TERMINATORS = /[\u2028\u2029]/g;

function wellFormedString(text: string): string {
    return text.replace(ILL_FORMED, (match) =>
        match.length === 2 ? match : '\uFFFD',
    );
}

function wellFormedValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return wellFormedString(value);
    }

    if (Array.isArray(value)) {
        return value.map(wellFormedValue);
    }

    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};

        for (const [key, inner] of Object.entries(value)) {
            out[wellFormedString(key)] = wellFormedValue(inner);
        }

        return out;
    }

    return value;
}

/**
 * undefined for undefined or null; otherwise an object or a list with no
 * NUL and no lone surrogate in any string or key. The value goes through
 * JSON first, as it will on the wire, so a Date becomes its string and a
 * function or undefined member disappears. A value JSON cannot write (a
 * cycle, a BigInt) throws.
 */
export function wellFormedPayload(value: unknown): Payload | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    const text = JSON.stringify(value) as string | undefined;

    if (text === undefined) {
        return undefined;
    }

    const parsed = JSON.parse(text) as unknown;
    const wrapped =
        typeof parsed === 'object' && parsed !== null
            ? parsed
            : { value: parsed };

    return wellFormedValue(wrapped) as Payload;
}

/**
 * The bytes PHP's json_encode (JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
 * writes for value, as JsonByteSize counts them after Laravel's input
 * transforms: the UTF-8 bytes of JSON.stringify, plus 3 for each U+2028 or
 * U+2029, plus 2 for each number written with an exponent (`1.0e-7`), plus
 * 2 for each "" and 1 for each " " (TrimStrings and
 * ConvertEmptyStringsToNull make both a 4-byte null).
 */
export function phpJsonBytes(value: unknown): number {
    let extra = 0;
    const text = JSON.stringify(value, (_key, inner: unknown) => {
        if (typeof inner === 'number' && String(inner).includes('e')) {
            extra += 2;
        } else if (inner === '') {
            extra += 2;
        } else if (inner === ' ') {
            extra += 1;
        }

        return inner;
    }) as string | undefined;

    if (text === undefined) {
        return 0;
    }

    const terminators = text.match(LINE_TERMINATORS)?.length ?? 0;

    return new TextEncoder().encode(text).byteLength + terminators * 3 + extra;
}

/** The payload as it is queued: well-formed, and replaced by its size when it is too large. */
function measuredPayload(value: unknown): Payload | undefined {
    const payload = wellFormedPayload(value);

    if (payload === undefined) {
        return undefined;
    }

    const bytes = phpJsonBytes(payload);

    return bytes > PAYLOAD_MAX_BYTES ? { truncated: true, bytes } : payload;
}

export function createEventBus(deps: {
    env: Environment;
    clock: Clock;
    groups: readonly string[];
    onQueued(event: SdkEvent): void;
}): EventBus {
    const listeners = new Set<(event: SdkEvent) => void>();

    const build = (
        type: string,
        source: SdkEvent['source'],
        payload: Payload | undefined,
        extra: { duration_ms?: number; confidence?: number } = {},
    ): SdkEvent => ({
        id: ulid(deps.env),
        t_ms: deps.clock.now(),
        ...(extra.duration_ms === undefined
            ? {}
            : { duration_ms: Math.max(0, Math.floor(extra.duration_ms)) }),
        type,
        source,
        ...(extra.confidence === undefined
            ? {}
            : { confidence: extra.confidence }),
        ...(payload === undefined ? {} : { payload }),
    });

    const deliver = (event: SdkEvent): void => {
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch (error) {
                // One host listener that throws must never cost the event.
                console.error(error);
            }
        }

        deps.onQueued(event);
    };

    return {
        emit(type, payload, extra): SdkEvent | null {
            const group = groupOf(type);

            if (group !== 'always' && !deps.groups.includes(group)) {
                return null;
            }

            const event = build(
                type,
                'browser',
                measuredPayload(payload),
                extra,
            );
            deliver(event);

            return event;
        },
        host(type, payload): boolean {
            const sent = hostType(type);

            if (sent === null) {
                return false;
            }

            let measured: Payload | undefined;

            try {
                measured = measuredPayload(payload);
            } catch {
                // A payload JSON cannot write would fail the whole batch.
                return false;
            }

            deliver(build(sent, 'host', measured));

            return true;
        },
        on(listener): () => void {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    };
}
