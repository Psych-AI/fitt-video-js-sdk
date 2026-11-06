import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalString, hmacHex } from '../../src/core/crypto.ts';
import {
    eventsRequest,
    segmentPost,
    segmentPut,
    type SegmentMeta,
} from '../../src/core/wire.ts';

const TOKEN = {
    id: '01jbz8q4w6x0k3m5n7p9r2t4bb',
    secret: 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f',
};
const URL_BASE =
    'http://127.0.0.1:8123/api/v1/sessions/01jbz8q4w6x0k3m5n7p9r2t4aa/tracks/camera/segments';
const RUN = '01jbz8q4w6x0k3m5n7p9r2t4v6';
const MEDIA: SegmentMeta = {
    take: 1,
    run: RUN,
    seq: 3,
    kind: 'media',
    startMs: 15_012,
    durationMs: 5026,
    recordedAt: 1_762_400_015_012,
    sha256: 'ab'.repeat(32),
};
const VECTORS = JSON.parse(
    readFileSync(
        new URL('../vectors/signed-post.json', import.meta.url),
        'utf8',
    ),
).vectors as {
    name: string;
    path: string;
    query: Record<string, string>;
    secret: string;
    canonical: string;
    sig: string;
}[];

test('a media PUT carries exactly the headers SegmentHeaders reads', () => {
    const body = new ArrayBuffer(300);
    const request = segmentPut(URL_BASE, TOKEN, MEDIA, body);

    assert.equal(request.method, 'PUT');
    assert.equal(request.url, `${URL_BASE}/3`);
    assert.equal(request.body, body);
    assert.deepEqual(request.headers, {
        Authorization: `Bearer fvt_${TOKEN.id}.${TOKEN.secret}`,
        'Content-Type': 'application/octet-stream',
        'X-Fitt-Take': '1',
        'X-Fitt-Run': RUN,
        'X-Fitt-Kind': 'media',
        'X-Fitt-Start-Ms': '15012',
        'X-Fitt-Duration-Ms': '5026',
        'X-Fitt-Recorded-At': '1762400015012',
        'X-Fitt-Sha256': 'ab'.repeat(32),
    });
});

test('every part of seq 0 carries the init fields', () => {
    const request = segmentPut(
        URL_BASE,
        TOKEN,
        {
            ...MEDIA,
            seq: 0,
            kind: 'init',
            startMs: 12,
            durationMs: 0,
            part: { index: 1, count: 2, sha256: 'cd'.repeat(32) },
            init: {
                anchorMs: 12,
                anchorSource: 'performance',
                mime: 'video/webm;codecs=vp8,opus',
                startedMs: 10,
            },
        },
        new ArrayBuffer(10),
    );

    assert.equal(request.url, `${URL_BASE}/0`);
    assert.deepEqual(
        [
            request.headers['X-Fitt-Part'],
            request.headers['X-Fitt-Part-Sha256'],
            request.headers['X-Fitt-Anchor-Ms'],
            request.headers['X-Fitt-Anchor-Source'],
            request.headers['X-Fitt-Mime'],
            request.headers['X-Fitt-Started-Ms'],
        ],
        [
            '1/2',
            'cd'.repeat(32),
            '12',
            'performance',
            'video/webm;codecs=vp8,opus',
            '10',
        ],
    );
});

test('a file segment sends no timing headers', () => {
    const request = segmentPut(
        URL_BASE,
        TOKEN,
        { take: 1, run: RUN, seq: 0, kind: 'media', sha256: 'ab'.repeat(32) },
        new ArrayBuffer(1),
    );

    assert.deepEqual(
        Object.keys(request.headers)
            .filter((name) => name.startsWith('X-Fitt-'))
            .sort(),
        ['X-Fitt-Kind', 'X-Fitt-Run', 'X-Fitt-Sha256', 'X-Fitt-Take'],
    );
});

test('the frozen event batch is sent byte for byte as JSON, with keepalive when asked', () => {
    const request = eventsRequest(
        'http://127.0.0.1:8123/api/v1/sessions/01jbz8q4w6x0k3m5n7p9r2t4aa/events',
        TOKEN,
        '{"take":1}',
        true,
    );

    assert.deepEqual(
        [
            request.method,
            request.body,
            request.keepalive,
            request.headers['Content-Type'],
            request.headers.Accept,
            request.headers.Authorization,
        ],
        [
            'POST',
            '{"take":1}',
            true,
            'application/json',
            'application/json',
            `Bearer fvt_${TOKEN.id}.${TOKEN.secret}`,
        ],
    );
});

test('the signed POST is text/plain with no Authorization, and the metadata and the signature in the query', async () => {
    const request = await segmentPost(
        URL_BASE,
        TOKEN,
        { ...MEDIA, part: { index: 1, count: 3, sha256: 'cd'.repeat(32) } },
        new ArrayBuffer(300),
        1_762_400_005_000,
    );
    const url = new URL(request.url);

    assert.equal(request.method, 'POST');
    assert.deepEqual(request.headers, {
        'Content-Type': 'text/plain;charset=UTF-8',
    });
    assert.equal(`${url.origin}${url.pathname}`, `${URL_BASE}/3`);
    assert.deepEqual([...url.searchParams.keys()].sort(), [
        'duration_ms',
        'kind',
        'part',
        'part_sha256',
        'recorded_at',
        'run',
        'sha256',
        'sig',
        'start_ms',
        'take',
        'token_id',
        'ts',
    ]);
    assert.equal(url.searchParams.get('token_id'), TOKEN.id);
    assert.equal(url.searchParams.get('ts'), '1762400005000');
    assert.equal(
        url.searchParams.get('sig'),
        await hmacHex(
            TOKEN.secret,
            canonicalString({
                path: url.pathname,
                ts: '1762400005000',
                take: '1',
                run: RUN,
                part: '1/3',
                sha256: 'ab'.repeat(32),
                part_sha256: 'cd'.repeat(32),
            }),
        ),
    );
    assert.ok(!request.url.includes(TOKEN.secret));
});

test('the shared vectors give the same canonical string and signature as the server', async () => {
    for (const vector of VECTORS) {
        assert.equal(
            canonicalString({
                path: vector.path,
                ...vector.query,
            } as Parameters<typeof canonicalString>[0]),
            vector.canonical,
            vector.name,
        );
        assert.equal(
            await hmacHex(vector.secret, vector.canonical),
            vector.sig,
            vector.name,
        );
    }
});
