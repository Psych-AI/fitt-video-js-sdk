import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readDescriptor, type Descriptor } from '../../src/core/descriptor.ts';
import { createDirectSlots, type DirectSlot } from '../../src/core/direct.ts';
import { classifyDirect } from '../../src/core/responses.ts';
import { createTokenKeeper } from '../../src/core/token.ts';
import { directPut, segmentConfirm } from '../../src/core/wire.ts';
import { fakeEnvironment, json, settle } from '../support/fake-env.ts';
import { add, rig, STORED } from '../support/uploader-rig.ts';

const BUCKET = 'https://fitt-video.s3.test/';
const SHA = 'ab'.repeat(32);

function fixture(name: string): Descriptor {
    const result = readDescriptor(
        JSON.parse(
            readFileSync(
                new URL(`../fixtures/descriptor-${name}.json`, import.meta.url),
                'utf8',
            ),
        ),
    );
    assert.ok(result.ok);

    return result.descriptor;
}

test('a window hands each segment one slot and is renewed when its take moves, its slots run out, or it nears its expiry', () => {
    let now = 1_000_000;
    const d = fixture('answer-s3');
    const slots = createDirectSlots({
        tracks: () => d.tracks,
        dateNow: () => now,
        receivedAt: () => 1_000_000,
        fresh: () => true,
    });

    assert.equal((slots.slotFor('camera', 'a', 1, SHA) as DirectSlot).slot, 0);
    assert.equal((slots.slotFor('camera', 'a', 1, SHA) as DirectSlot).slot, 0);
    assert.equal(slots.slotFor('camera', 'x', 2, SHA), 'renew');

    for (const key of ['b', 'c', 'd']) {
        slots.slotFor('camera', key, 1, SHA);
    }

    assert.equal(slots.slotFor('camera', 'e', 1, SHA), 'renew');
    assert.equal(slots.slotFor('screen', 'z', 1, SHA), 'none');
    now = 1_000_000 + (960 - 60) * 1000;
    assert.equal(slots.slotFor('camera', 'a', 1, SHA), 'renew');
});

test('a window this page did not receive is renewed before its first slot', () => {
    const d = fixture('answer-s3');
    const stored = d.tracks[0].upload.direct!.attempt;
    const slots = createDirectSlots({
        tracks: () => d.tracks,
        dateNow: () => 0,
        receivedAt: () => 0,
        fresh: (attempt) => attempt !== stored,
    });

    assert.equal(slots.slotFor('camera', 'a', 1, SHA), 'renew');
    assert.equal((slots.slotFor('audio', 'b', 1, SHA) as DirectSlot).slot, 0);
});

test('a cloudfront window builds each slot URL from its base and query, and adds the content hash when asked', () => {
    const d = fixture('answer-cloudfront');
    const direct = d.tracks[0].upload.direct!;
    direct.content_sha256 = true;
    const slot = createDirectSlots({
        tracks: () => d.tracks,
        dateNow: () => 0,
        receivedAt: () => 0,
        fresh: () => true,
    }).slotFor('camera', 'a', 1, SHA) as DirectSlot;

    assert.equal(
        slot.url,
        `${direct.base}${direct.attempt}-0000.bin?${direct.query}`,
    );
    assert.equal(slot.headers['x-amz-content-sha256'], SHA);
    assert.equal(slot.headers['If-None-Match'], '*');
});

test('the bucket PUT carries only its own headers, and the bucket answers read as direct verdicts', () => {
    const headers = {
        'Content-Type': 'application/octet-stream',
        'If-None-Match': '*',
    };
    const put = directPut(
        `${BUCKET}videos/k.bin?X-Amz-Signature=c0`,
        headers,
        new ArrayBuffer(3),
    );
    const answer = (status: number, networkError = false) => ({
        status,
        body: null,
        networkError,
        timedOut: false,
    });

    assert.equal(put.method, 'PUT');
    assert.deepEqual(put.headers, headers);
    assert.deepEqual(classifyDirect(answer(200)), {
        kind: 'ok',
        code: 'uploaded',
    });
    assert.deepEqual(classifyDirect(answer(412)), {
        kind: 'ok',
        code: 'already_uploaded',
    });
    assert.deepEqual(classifyDirect(answer(403)), {
        kind: 'step_down',
        reason: 'proxy',
    });
    assert.deepEqual(classifyDirect(answer(405)), {
        kind: 'step_down',
        reason: 'method',
    });
    assert.deepEqual(classifyDirect(answer(0, true)), {
        kind: 'retry',
        code: 'network',
    });
    assert.deepEqual(classifyDirect(answer(500)), {
        kind: 'retry',
        code: 'http_500',
    });
});

test('the confirm names the slot and the bytes, and an uploaded segment keeps its slot across a renewal', () => {
    const d = fixture('answer-s3');
    const camera = d.tracks[0].upload;
    const slots = createDirectSlots({
        tracks: () => d.tracks,
        dateNow: () => 0,
        receivedAt: () => 0,
        fresh: () => true,
    });
    const first = slots.slotFor('camera', 'a', 1, SHA) as DirectSlot;
    const meta = {
        take: 1,
        run: '01jbz8q4w6x0k3m5n7p9r2t4ff',
        seq: 7,
        kind: 'media' as const,
        startMs: 0,
        durationMs: 5000,
        sha256: SHA,
    };
    const confirm = segmentConfirm(
        camera.confirm_url!,
        { id: 't', secret: 's' },
        meta,
        { attempt: first.attempt, slot: first.slot, bytes: 42 },
    );

    assert.equal(confirm.method, 'POST');
    assert.equal(confirm.url, camera.confirm_url!.replace('{seq}', '7'));
    assert.match(confirm.headers.Authorization, /^Bearer fvt_t\.s$/);
    assert.deepEqual(JSON.parse(String(confirm.body)), {
        take: '1',
        run: meta.run,
        kind: 'media',
        start_ms: '0',
        duration_ms: '5000',
        sha256: SHA,
        bytes: 42,
        attempt: first.attempt,
        slot: 0,
    });

    slots.markUploaded('a');
    camera.direct = {
        ...camera.direct!,
        attempt: '01jbz8q4w6x0k3m5n7p9r2t4zz',
    };
    assert.deepEqual(
        {
            attempt: (slots.slotFor('camera', 'a', 1, SHA) as DirectSlot)
                .attempt,
            slot: (slots.slotFor('camera', 'a', 1, SHA) as DirectSlot).slot,
        },
        { attempt: first.attempt, slot: 0 },
    );

    slots.markNotUploaded('a');
    const again = slots.slotFor('camera', 'a', 1, SHA) as DirectSlot;
    assert.equal(again.attempt, '01jbz8q4w6x0k3m5n7p9r2t4zz');
    assert.equal(again.url, camera.direct.slots![0]);
});

test('a segment the confirm refused is PUT again to a fresh slot of the same window, never to the slot that holds the refused object', () => {
    const d = fixture('answer-s3');
    const slots = createDirectSlots({
        tracks: () => d.tracks,
        dateNow: () => 0,
        receivedAt: () => 0,
        fresh: () => true,
    });
    const first = slots.slotFor('camera', 'a', 1, SHA) as DirectSlot;

    slots.markUploaded('a');
    slots.markNotUploaded('a');

    assert.equal(slots.uploaded('a'), false);
    const again = slots.slotFor('camera', 'a', 1, SHA) as DirectSlot;
    assert.equal(again.attempt, first.attempt);
    assert.notEqual(again.slot, first.slot);
    assert.equal(again.slot, 1);
    assert.equal(
        (slots.slotFor('camera', 'a', 1, SHA) as DirectSlot).slot,
        again.slot,
    );
});

/** A refreshed answer-s3 descriptor whose camera window has a new attempt and new slots. */
function renewedS3(): Descriptor {
    const renewed = fixture('answer-s3');
    const fresh = '01jbz8q4w6x0k3m5n7p9r2t4df';
    renewed.token.id = '01jbz8q4w6x0k3m5n7p9r2t4bc';
    renewed.tracks[0].upload.direct!.attempt = fresh;
    renewed.tracks[0].upload.direct!.slots = [0, 1, 2, 3].map(
        (i) =>
            `${BUCKET}videos/01jbz8q4w6x0k3m5n7p9r2t4aa/camera/take-1/direct/${fresh}-000${i}.bin?X-Amz-Signature=r${i}`,
    );

    return renewed;
}

test('on the direct rung a segment is PUT to its slot with no token, then confirmed with the token', async () => {
    const d = fixture('answer-s3');
    const r = rig({ rung: 'direct', descriptor: d });
    r.env.respond((call) =>
        call.url.startsWith(BUCKET) ? json(200) : STORED(),
    );
    const record = await add(r, { seq: 1 });
    r.uploader.start();
    await r.uploader.idle();

    const camera = d.tracks[0].upload;
    const [put, confirm] = r.env.calls;
    const body = JSON.parse(String(confirm.body));

    assert.equal(r.env.calls.length, 2);
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, camera.direct?.slots?.[0]);
    assert.equal(put.headers.Authorization, undefined);
    assert.equal(put.headers['Content-Type'], 'application/octet-stream');
    assert.equal(put.headers['If-None-Match'], '*');
    assert.equal(confirm.method, 'POST');
    assert.equal(confirm.url, `${camera.url}/1/confirm`);
    assert.match(confirm.headers.Authorization, /^Bearer fvt_/);
    assert.equal(body.attempt, camera.direct?.attempt);
    assert.equal(body.slot, 0);
    assert.equal(body.bytes, record.bytes);
    assert.equal(body.sha256, record.sha256);
    assert.equal(body.take, '1');
    assert.equal(
        r.events.find(([type]) => type === 'upload.chunk_sent')?.[1].transport,
        'direct',
    );
});

test('a 412 from the bucket means the object is there, so the segment is confirmed and not sent again', async () => {
    const r = rig({ rung: 'direct', descriptor: fixture('answer-s3') });
    r.env.respond((call) =>
        call.url.startsWith(BUCKET) ? json(412) : STORED(),
    );
    await add(r, { seq: 1 });
    r.uploader.start();
    await r.uploader.idle();

    assert.deepEqual(
        r.env.calls.map((call) => call.method),
        ['PUT', 'POST'],
    );
});

test('a failed confirm is sent again without a second PUT', async () => {
    const r = rig({ rung: 'direct', descriptor: fixture('answer-s3') });
    let confirms = 0;
    r.env.respond((call) => {
        if (call.url.startsWith(BUCKET)) {
            return json(200);
        }

        confirms += 1;

        return confirms === 1
            ? json(503, { error: { code: 'server_error', message: 'x' } })
            : STORED();
    });
    await add(r, { seq: 1 });
    r.uploader.start();

    for (let i = 0; i < 40 && r.env.calls.length < 3; i++) {
        await r.env.advance(1_000);
        await settle();
    }

    await r.uploader.idle();
    assert.deepEqual(
        r.env.calls.map((call) => call.method),
        ['PUT', 'POST', 'POST'],
    );
});

test('a 403 from the bucket steps down to the passthrough PUT and reports it', async () => {
    const d = fixture('answer-s3');
    const r = rig({ rung: 'direct', descriptor: d });
    r.env.respond((call) =>
        call.url.startsWith(BUCKET) ? json(403) : STORED(),
    );
    const record = await add(r, { seq: 1 });
    r.uploader.start();
    await r.uploader.idle();

    const passthrough = r.env.calls[1];

    assert.equal(passthrough.method, 'PUT');
    assert.equal(passthrough.url, `${d.tracks[0].upload.fallback_url}/1`);
    assert.equal(passthrough.headers['X-Fitt-Sha256'], record.sha256);
    assert.deepEqual(r.ladderEvents, [
        [
            'upload.transport_fallback',
            { from: 'direct', to: 'put', reason: 'proxy' },
        ],
    ]);
    assert.equal(
        r.events.find(([type]) => type === 'upload.chunk_sent')?.[1].transport,
        'put',
    );
});

test('used-up slots renew the descriptor once before more are sent', async () => {
    const d = fixture('answer-s3');
    const original = [...(d.tracks[0].upload.direct?.slots ?? [])];
    const renewed = renewedS3();
    const env = fakeEnvironment();
    let refreshes = 0;
    const token = createTokenKeeper({
        env,
        descriptor: d,
        refresh: async () => {
            refreshes += 1;

            return {
                status: 201,
                body: { descriptor: JSON.parse(JSON.stringify(renewed)) },
                networkError: false,
                timedOut: false,
            };
        },
        onDescriptor: (next) => {
            d.tracks = next.tracks;
        },
        emit: () => {},
        setError: () => {},
    });
    const r = rig({ env, token, rung: 'direct', descriptor: d });
    r.env.respond((call) =>
        call.url.startsWith(BUCKET) ? json(200) : STORED(),
    );

    for (const seq of [1, 2, 3, 4, 5]) {
        await add(r, { seq });
    }

    r.uploader.start();

    for (
        let i = 0;
        i < 40 &&
        r.env.calls.filter((call) => call.method === 'PUT').length < 5;
        i++
    ) {
        await r.env.advance(1_000);
        await settle();
    }

    await r.uploader.idle();
    const puts = r.env.calls
        .filter((call) => call.method === 'PUT')
        .map((call) => call.url);

    assert.equal(refreshes, 1);
    assert.deepEqual(puts.slice(0, 4), original);
    assert.equal(puts[4], renewed.tracks[0].upload.direct!.slots![0]);
});

test('a resumed session renews its window before its first direct PUT, and never reuses a slot of the stored attempt', async () => {
    const d = fixture('answer-s3');
    const stored = [
        d.tracks[0].upload.direct!.attempt,
        d.tracks[1].upload.direct!.attempt,
    ];
    const renewed = renewedS3();
    const env = fakeEnvironment();
    const order: string[] = [];
    const token = createTokenKeeper({
        env,
        descriptor: d,
        refresh: async () => {
            order.push('refresh');

            return {
                status: 201,
                body: { descriptor: JSON.parse(JSON.stringify(renewed)) },
                networkError: false,
                timedOut: false,
            };
        },
        onDescriptor: (next) => {
            d.tracks = next.tracks;
        },
        emit: () => {},
        setError: () => {},
    });
    const r = rig({
        env,
        token,
        rung: 'direct',
        descriptor: d,
        staleAttempts: stored,
    });
    r.env.respond((call) => {
        order.push(call.method);

        return call.url.startsWith(BUCKET) ? json(200) : STORED();
    });
    await add(r, { seq: 1 });
    r.uploader.start();

    for (
        let i = 0;
        i < 40 && !r.env.calls.some((call) => call.method === 'PUT');
        i++
    ) {
        await r.env.advance(1_000);
        await settle();
    }

    await r.uploader.idle();
    const puts = r.env.calls
        .filter((call) => call.method === 'PUT')
        .map((call) => call.url);

    assert.equal(order[0], 'refresh');
    assert.equal(puts[0], renewed.tracks[0].upload.direct!.slots![0]);
    assert.equal(
        puts.some((url) => url.includes(`/direct/${stored[0]}-`)),
        false,
    );
});

test('on the direct rung a track with no direct window sends its segment on the passthrough PUT and reports put', async () => {
    const d = fixture('answer-s3');
    delete d.tracks[0].upload.direct;
    delete d.tracks[0].upload.confirm_url;
    const r = rig({ rung: 'direct', descriptor: d });
    r.env.respond(() => STORED());
    const record = await add(r, { seq: 1 });
    r.uploader.start();
    await r.uploader.idle();

    assert.equal(r.env.calls.length, 1);
    assert.equal(r.env.calls[0].method, 'PUT');
    assert.equal(r.env.calls[0].url, `${d.tracks[0].upload.fallback_url}/1`);
    assert.equal(r.env.calls[0].headers['X-Fitt-Sha256'], record.sha256);
    assert.deepEqual(r.ladderEvents, []);
    assert.equal(
        r.events.find(([type]) => type === 'upload.chunk_sent')?.[1].transport,
        'put',
    );
});

test('a segment of a take older than its received window goes on the passthrough PUT, so stale_take reaches it with no renewal', async () => {
    const d = fixture('answer-s3');
    d.tracks[0].upload.direct!.take = 2;
    const r = rig({ rung: 'direct', descriptor: d });
    r.env.respond((call) =>
        call.url.startsWith(BUCKET)
            ? json(200)
            : json(409, {
                  error: { code: 'stale_take', message: 'x', current_take: 2 },
              }),
    );
    await add(r, { seq: 1 });
    r.uploader.start();

    for (let i = 0; i < 40 && r.behind.length === 0; i++) {
        await r.env.advance(1_000);
        await settle();
    }

    assert.equal(r.env.calls[0].method, 'PUT');
    assert.equal(r.env.calls[0].url, `${d.tracks[0].upload.fallback_url}/1`);
    assert.equal(
        r.env.calls.some((call) => call.url.startsWith(BUCKET)),
        false,
    );
    assert.deepEqual(r.behind, [2]);
});
