import type { AnchorSource } from './clock.ts';
import { canonicalString, hmacHex } from './crypto.ts';

/**
 * The requests the SDK sends, built and never sent here (`http.ts` sends
 * them). Request values are not re-checked: the server answers a malformed
 * one with `422 validation_failed`, which `classify()` treats as terminal.
 */

export interface TokenRef {
    id: string;
    secret: string;
}

export interface SegmentMeta {
    take: number;
    run: string;
    seq: number;
    kind: 'init' | 'media';
    startMs?: number;
    durationMs?: number;
    recordedAt?: number;
    sha256: string;
    part?: { index: number; count: number; sha256: string };
    init?: {
        anchorMs: number;
        anchorSource: AnchorSource;
        mime: string;
        startedMs: number;
    };
}

export interface WireRequest {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    body?: ArrayBuffer | string;
    keepalive?: boolean;
}

/** The most parts a segment may be split into (`video.upload.max_parts`); the uploader and the playground panel share it. */
export const MAX_PARTS = 100;

/**
 * The header each canonical field is sent in on a PUT: exactly
 * `App\Video\Upload\SegmentHeaders::PUT_HEADERS`. The signed POST sends the
 * same canonical names in its query (`run`, not `run_id`; `mime`, not
 * `mime_type`).
 */
const PUT_HEADERS = {
    take: 'X-Fitt-Take',
    run: 'X-Fitt-Run',
    kind: 'X-Fitt-Kind',
    start_ms: 'X-Fitt-Start-Ms',
    duration_ms: 'X-Fitt-Duration-Ms',
    recorded_at: 'X-Fitt-Recorded-At',
    sha256: 'X-Fitt-Sha256',
    part: 'X-Fitt-Part',
    part_sha256: 'X-Fitt-Part-Sha256',
    anchor_ms: 'X-Fitt-Anchor-Ms',
    anchor_source: 'X-Fitt-Anchor-Source',
    mime: 'X-Fitt-Mime',
    started_ms: 'X-Fitt-Started-Ms',
} as const;

type Field = keyof typeof PUT_HEADERS;

/** The browser's bearer for an upload token. */
export function bearer(token: TokenRef): string {
    return `Bearer fvt_${token.id}.${token.secret}`;
}

/** A whole number in decimal with no leading zeros. */
function decimal(value: number): string {
    return String(value);
}

/** The canonical fields of one write, in PUT_HEADERS order, leaving out what the meta does not carry. */
function fields(meta: SegmentMeta): [Field, string][] {
    const values: Record<Field, string | undefined> = {
        take: decimal(meta.take),
        run: meta.run,
        kind: meta.kind,
        start_ms:
            meta.startMs === undefined ? undefined : decimal(meta.startMs),
        duration_ms:
            meta.durationMs === undefined
                ? undefined
                : decimal(meta.durationMs),
        recorded_at:
            meta.recordedAt === undefined
                ? undefined
                : decimal(meta.recordedAt),
        sha256: meta.sha256,
        part:
            meta.part === undefined
                ? undefined
                : `${decimal(meta.part.index)}/${decimal(meta.part.count)}`,
        part_sha256: meta.part?.sha256,
        anchor_ms:
            meta.init === undefined ? undefined : decimal(meta.init.anchorMs),
        anchor_source: meta.init?.anchorSource,
        mime: meta.init?.mime,
        started_ms:
            meta.init === undefined ? undefined : decimal(meta.init.startedMs),
    };
    const out: [Field, string][] = [];

    for (const field of Object.keys(PUT_HEADERS) as Field[]) {
        const value = values[field];

        if (value !== undefined) {
            out.push([field, value]);
        }
    }

    return out;
}

/** `${uploadUrl}/${seq}` with the X-Fitt-* headers. */
export function segmentPut(
    uploadUrl: string,
    token: TokenRef,
    meta: SegmentMeta,
    body: ArrayBuffer,
): WireRequest {
    const headers: Record<string, string> = {
        Authorization: bearer(token),
        'Content-Type': 'application/octet-stream',
    };

    for (const [field, value] of fields(meta)) {
        headers[PUT_HEADERS[field]] = value;
    }

    return {
        method: 'PUT',
        url: `${uploadUrl}/${decimal(meta.seq)}`,
        headers,
        body,
    };
}

/** The preflight-free form: text/plain, no Authorization, the metadata, token_id, ts and sig in the query. */
export async function segmentPost(
    uploadUrl: string,
    token: TokenRef,
    meta: SegmentMeta,
    body: ArrayBuffer,
    ts: number,
): Promise<WireRequest> {
    const url = `${uploadUrl}/${decimal(meta.seq)}`;
    const written = fields(meta);
    const value = (field: Field): string | undefined =>
        written.find(([name]) => name === field)?.[1];
    const stamp = decimal(ts);
    const sig = await hmacHex(
        token.secret,
        canonicalString({
            path: new URL(url).pathname,
            ts: stamp,
            take: value('take') ?? '',
            run: value('run') ?? '',
            part: value('part'),
            sha256: value('sha256') ?? '',
            part_sha256: value('part_sha256'),
        }),
    );
    const query = new URLSearchParams({ token_id: token.id, ts: stamp, sig });

    for (const [field, fieldValue] of written) {
        query.set(field, fieldValue);
    }

    return {
        method: 'POST',
        url: `${url}?${query.toString()}`,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body,
    };
}

/**
 * The direct rung's PUT straight to a slot in the bucket (Plan 8): exactly the
 * slot's headers, so no Authorization and no X-Fitt-* header ever reaches the
 * bucket. The token goes only to the confirm.
 */
export function directPut(
    url: string,
    headers: Record<string, string>,
    body: ArrayBuffer,
): WireRequest {
    return { method: 'PUT', url, headers: { ...headers }, body };
}

/**
 * The confirm of one direct PUT: `confirmUrl` with `{seq}` replaced, the
 * canonical fields as strings (whole segments only, so never a part), plus
 * the object's `bytes` and the `attempt` and `slot` it was PUT to. The server
 * rebuilds the key from them (author's call 1).
 */
export function segmentConfirm(
    confirmUrl: string,
    token: TokenRef,
    meta: SegmentMeta,
    direct: { attempt: string; slot: number; bytes: number },
): WireRequest {
    const body: Record<string, string | number> = Object.fromEntries(
        fields(meta),
    );

    body.bytes = direct.bytes;
    body.attempt = direct.attempt;
    body.slot = direct.slot;

    return jsonRequest(
        confirmUrl.replace('{seq}', decimal(meta.seq)),
        token,
        'POST',
        body,
    );
}

/** A JSON call with the bearer: Accept always, Content-Type and the JSON body when a body is given. */
export function jsonRequest(
    url: string,
    token: TokenRef,
    method: 'GET' | 'POST',
    body?: unknown,
): WireRequest {
    const headers: Record<string, string> = {
        Authorization: bearer(token),
        Accept: 'application/json',
    };

    if (body === undefined) {
        return { method, url, headers };
    }

    headers['Content-Type'] = 'application/json';

    return { method, url, headers, body: JSON.stringify(body) };
}

/** The frozen event batch: the body string sent unchanged, with Authorization, Accept and Content-Type: application/json. */
export function eventsRequest(
    url: string,
    token: TokenRef,
    body: string,
    keepalive: boolean,
): WireRequest {
    return {
        method: 'POST',
        url,
        headers: {
            Authorization: bearer(token),
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body,
        keepalive,
    };
}
