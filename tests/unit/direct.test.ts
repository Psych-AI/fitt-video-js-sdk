import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readDescriptor, type Descriptor } from '../../src/core/descriptor.ts';
import { createDirectSlots, type DirectSlot } from '../../src/core/direct.ts';
import { classifyDirect } from '../../src/core/responses.ts';
import { directPut, segmentConfirm } from '../../src/core/wire.ts';

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
