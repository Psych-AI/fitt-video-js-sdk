/**
 * WebCrypto helpers for the segment hashes and the signed POST. Node 24 has
 * the same API on `globalThis.crypto`, so the unit tests run them as they
 * are. Nothing is read at import: the IIFE loads with no Web APIs.
 */

/** The signed fields of a segment POST, as they are sent in the query. */
export interface SignedFields {
    /** The request path, for example /api/v1/sessions/{id}/tracks/camera/segments/3. */
    path: string;
    ts: string;
    take: string;
    run: string;
    part?: string | null;
    sha256: string;
    part_sha256?: string | null;
}

/**
 * The page's WebCrypto, or a plain-English error when the page has none.
 * Outside a secure context (plain http on an address other than localhost)
 * `crypto.subtle` is undefined.
 */
function subtle(): SubtleCrypto {
    if (globalThis.crypto?.subtle === undefined) {
        throw new Error(
            'This browser has no WebCrypto on this page. It needs a secure context, such as https or localhost.',
        );
    }

    return globalThis.crypto.subtle;
}

function hex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
}

/**
 * The lower-case hex SHA-256 of some bytes. Throws when the page has no
 * WebCrypto.
 */
export async function sha256Hex(
    data: ArrayBuffer | Uint8Array,
): Promise<string> {
    return hex(await subtle().digest('SHA-256', data as BufferSource));
}

/**
 * The lower-case hex HMAC-SHA256 of a message with a secret, as PHP's
 * `hash_hmac('sha256', $message, $secret)` computes it. Throws when the page
 * has no WebCrypto.
 */
export async function hmacHex(
    secret: string,
    message: string,
): Promise<string> {
    const encoder = new TextEncoder();
    const webCrypto = subtle();
    const key = await webCrypto.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );

    return hex(await webCrypto.sign('HMAC', key, encoder.encode(message)));
}

/**
 * The canonical string of a signed POST, built exactly as
 * `App\Video\Upload\UploadSignature::canonical()` builds it:
 *
 *     POST \n path \n ts \n take \n lower(run) \n seq \n part \n lower(sha256) \n lower(part_sha256)
 *
 * A missing field is the empty string. The seq is the last segment of the
 * path, as the server reads it. Values are trimmed, because the server reads
 * them after Laravel's TrimStrings middleware. The shared vectors in
 * tests/vectors/signed-post.json pin it to the server.
 */
export function canonicalString(fields: SignedFields): string {
    const value = (field: string | null | undefined): string =>
        (field ?? '').trim();

    return [
        'POST',
        fields.path,
        value(fields.ts),
        value(fields.take),
        value(fields.run).toLowerCase(),
        fields.path.slice(fields.path.lastIndexOf('/') + 1),
        value(fields.part),
        value(fields.sha256).toLowerCase(),
        value(fields.part_sha256).toLowerCase(),
    ].join('\n');
}
