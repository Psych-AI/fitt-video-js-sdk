import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../../src/core/crypto.ts';
import { partCount } from '../../src/core/parts.ts';
import { createTokenKeeper } from '../../src/core/token.ts';
import { fakeEnvironment, json, settle, until } from '../support/fake-env.ts';
import { descriptorFixture, SID } from '../support/records.ts';
import { add, rig, seqOf, STORED, trackOf } from '../support/uploader-rig.ts';

const NEW_ID = '01jbz8q4w6x0k3m5n7p9r2t4bc';

test('a segment is split only when it is larger than part_size', () => {
    assert.deepEqual(
        [
            partCount(5_242_880, 5_242_880),
            partCount(5_242_881, 5_242_880),
            partCount(24_117_248, 5_242_880),
            partCount(0, 5_242_880),
        ],
        [1, 2, 5, 1],
    );
});

test('one track sends in seq order with at most 2 in flight, and tracks run independently', async () => {
    const r = rig();
    const open: (() => void)[] = [];
    const inFlight: Record<string, number> = {};
    const peak: Record<string, number> = {};
    r.env.respond(
        (call) =>
            new Promise((resolve) => {
                const track = trackOf(call);
                inFlight[track] = (inFlight[track] ?? 0) + 1;
                peak[track] = Math.max(peak[track] ?? 0, inFlight[track]);
                open.push(() => {
                    inFlight[track] -= 1;
                    resolve(STORED());
                });
            }),
    );

    for (const seq of [0, 1, 2, 3, 4]) {
        await add(r, { seq });
    }

    await add(r, { seq: 0, track: 'audio' });
    r.uploader.start();
    await until(() => r.env.calls.length === 3);

    for (
        let i = 0;
        i < 200 && (r.env.calls.length < 6 || open.length > 0);
        i++
    ) {
        open.shift()?.();
        await settle();
    }

    await r.uploader.idle();
    assert.deepEqual(
        r.env.calls.filter((call) => trackOf(call) === 'camera').map(seqOf),
        [0, 1, 2, 3, 4],
    );
    assert.deepEqual(peak, { camera: 2, audio: 1 });
    assert.deepEqual(
        (await r.store.listSegments(SID)).map((s) => [s.state, s.data]),
        Array(6).fill(['delivered', null]),
    );
});

test('fifty failures in a row never abandon a segment', async () => {
    const r = rig({ env: fakeEnvironment({ random: 0 }) });
    r.env.respond(() =>
        json(500, { error: { code: 'server_error', message: 'x' } }),
    );
    await add(r, { seq: 1 });
    r.uploader.start();

    for (let i = 1; i <= 50; i++) {
        await until(() => r.env.calls.length === i);
        await r.env.advance(1);
    }

    const [record] = await r.store.listSegments(SID);
    assert.equal(record.state, 'pending');
    assert.ok(record.failures >= 50);
    assert.deepEqual(r.abandoned, []);
});

test('nothing is sent while offline, and the online event sends at once', async () => {
    const r = rig();
    r.env.respond(STORED);
    r.env.setOnline(false);
    await add(r, { seq: 1 });
    r.uploader.start();
    await r.env.advance(60_000);
    assert.equal(r.env.calls.length, 0);

    r.env.setOnline(true);
    await until(() => r.env.calls.length === 1);
});

test('a request that hangs is aborted at 30 s and tried again', async () => {
    const r = rig({ env: fakeEnvironment({ random: 0 }) });
    let first = true;
    r.env.respond(() => {
        if (first) {
            first = false;

            return new Promise<Response>(() => {});
        }

        return STORED();
    });
    await add(r, { seq: 1 });
    r.uploader.start();
    await until(() => r.env.calls.length === 1);
    await r.env.advance(29_999);
    assert.equal(r.env.calls.length, 1);

    await r.env.advance(1);
    await until(() => r.env.calls.length === 2);
    assert.ok(
        r.events.some(
            ([type, payload]) =>
                type === 'upload.chunk_failed' && payload.code === 'timeout',
        ),
    );
});

test('a 429 waits for retry_after from the body, and a 503 join_in_progress is tried again', async () => {
    const r = rig();
    const answers = [
        json(429, {
            error: { code: 'rate_limited', message: 'x', retry_after: 7 },
        }),
        json(503, { error: { code: 'join_in_progress', message: 'x' } }),
        STORED(),
    ];
    r.env.respond(() => answers.shift()!);
    await add(r, { seq: 1 });
    r.uploader.start();
    await until(() => r.env.calls.length === 1);
    await r.env.advance(6_999);
    assert.equal(r.env.calls.length, 1);

    await r.env.advance(1);
    await until(() => r.env.calls.length === 2);
    await r.env.advance(30_000);
    await until(() => r.env.calls.length === 3);
    await r.uploader.idle();
});

test('a 409 stale_take for an old take deletes the segment, raises upload.segment_rejected, and never re-posts a manifest', async () => {
    const r = rig({ currentTake: 2 });
    r.env.respond(() =>
        json(409, {
            error: { code: 'stale_take', message: 'x', current_take: 2 },
        }),
    );
    await add(r, { seq: 1, take: 1 });
    r.uploader.start();
    await until(() =>
        r.events.some(([type]) => type === 'upload.segment_rejected'),
    );

    assert.deepEqual(
        r.events.find(([type]) => type === 'upload.segment_rejected')![1],
        { track: 'camera', seq: 1, code: 'stale_take' },
    );
    assert.deepEqual(await r.store.listSegments(SID), []);
    assert.deepEqual(r.abandoned, []);
    assert.ok(!r.env.calls.some((call) => call.url.endsWith('/manifest')));
});

test('a stale_take for the current local take reports the take behind and keeps the bytes', async () => {
    const r = rig({ currentTake: 1 });
    r.env.respond(() =>
        json(409, {
            error: { code: 'stale_take', message: 'x', current_take: 2 },
        }),
    );
    await add(r, { seq: 1, take: 1 });
    await add(r, { seq: 2, take: 1 });
    await add(r, { seq: 3, take: 1 });
    r.uploader.start();
    await until(() => r.behind.length === 1);
    await r.env.advance(5000);

    // seq 1 and seq 2 were both in flight (2 per lane) before the first 409 came back; seq 3 never starts.
    assert.deepEqual(r.behind, [2]);
    assert.deepEqual(r.env.calls.map(seqOf), [1, 2]);
    assert.deepEqual(
        (await r.store.listSegments(SID)).map((s) => [
            s.seq,
            s.state,
            s.data !== null,
        ]),
        [
            [1, 'pending', true],
            [2, 'pending', true],
            [3, 'pending', true],
        ],
    );
});

test('a proxy 403 on the POST rung backs off instead of looping', async () => {
    const r = rig({ forcePost: true });
    r.env.respond(
        () =>
            new Response('<html>Forbidden</html>', {
                status: 403,
                headers: { 'Content-Type': 'text/html' },
            }),
    );
    await add(r, { seq: 1 });
    r.uploader.start();

    for (let i = 0; i < 20; i++) {
        await r.env.advance(500);
        await settle();
    }

    assert.ok(r.env.calls.length <= 10, `${r.env.calls.length} calls in 10 s`);
    assert.ok(r.env.calls.every((call) => call.method === 'POST'));
});

test('an answer that arrives after the sweep abandoned its record writes nothing back', async () => {
    const r = rig({ abandonAfterMs: 20_000 });
    const pending: { answer?: (response: Response) => void } = {};
    r.env.respond(
        () =>
            new Promise<Response>((resolve) => {
                pending.answer = resolve;
            }),
    );
    await add(r, { seq: 1 });
    r.uploader.start();
    await until(() => pending.answer !== undefined);
    await r.env.advance(22_000); // past the age limit, before the 30 s request timeout: the sweep abandons it
    pending.answer!(
        json(500, { error: { code: 'server_error', message: 'x' } }),
    );
    await r.env.advance(60_000);
    const [record] = await r.store.listSegments(SID);

    assert.deepEqual(
        [record.state, record.data, record.failures],
        ['abandoned', null, 0],
    );
    assert.equal(r.env.calls.length, 1);
    assert.deepEqual(
        r.events.filter(([type]) => type === 'upload.chunk_failed'),
        [],
    );
});

test('a seq 0 whose stored bytes no longer match its hash is rejected as local_corrupt, and the lane goes on', async () => {
    const r = rig();
    r.env.respond((call) =>
        seqOf(call) === 0
            ? json(400, { error: { code: 'hash_mismatch', message: 'x' } })
            : STORED(),
    );
    const init = await add(r, { seq: 0 });
    new Uint8Array(init.data!).fill(9); // the stored copy changed after it was hashed
    await add(r, { seq: 1 });
    await add(r, { seq: 2 });
    r.uploader.start();
    await r.uploader.idle();

    assert.equal(r.env.calls.filter((call) => seqOf(call) === 0).length, 1);
    assert.deepEqual(
        (await r.store.listSegments(SID)).map((s) => [s.seq, s.state, s.data]),
        [
            [0, 'rejected', null],
            [1, 'delivered', null],
            [2, 'delivered', null],
        ],
    );
    assert.ok(
        r.events.some(
            ([type, payload]) =>
                type === 'upload.segment_rejected' &&
                payload.code === 'local_corrupt',
        ),
    );
    assert.deepEqual(r.abandoned, ['camera']);
});

test('a hash_mismatch whose local bytes still verify is retried', async () => {
    const r = rig();
    const answers = [
        json(400, { error: { code: 'hash_mismatch', message: 'x' } }),
        STORED(),
    ];
    r.env.respond(() => answers.shift() ?? STORED());
    await add(r, { seq: 0 });
    r.uploader.start();
    await until(() =>
        r.events.some(([type]) => type === 'upload.chunk_failed'),
    );
    await r.env.advance(1000);
    await r.uploader.idle();

    assert.equal(r.env.calls.length, 2);
    assert.equal((await r.store.listSegments(SID))[0].state, 'delivered');
});

test('dropNext leaves that seq unsent and keeps its bytes count and hash on the record', async () => {
    const r = rig();
    r.env.respond(STORED);
    const dropped = await add(r, { seq: 1 });
    await add(r, { seq: 2 });
    r.uploader.dropNext('camera');
    r.uploader.start();
    await r.uploader.idle();
    const records = await r.store.listSegments(SID);

    assert.deepEqual(r.env.calls.map(seqOf), [2]);
    assert.deepEqual(
        [
            records[0].state,
            records[0].data,
            records[0].bytes,
            records[0].sha256,
        ],
        ['dropped', null, 300, dropped.sha256],
    );
});

test('upload.transport post never issues a PUT', async () => {
    const r = rig({ forcePost: true });
    r.env.respond(STORED);

    for (const seq of [0, 1, 2]) {
        await add(r, { seq });
    }

    r.uploader.start();
    await until(() => r.env.calls.length === 3);

    assert.deepEqual(
        r.env.calls.map((call) => [
            call.method,
            call.headers['Content-Type'],
            'Authorization' in call.headers,
        ]),
        Array(3).fill(['POST', 'text/plain;charset=UTF-8', false]),
    );
});

test('a terminal answer frees the bytes and keeps the record, listed abandoned', async () => {
    const r = rig();
    r.env.respond(() =>
        json(409, { error: { code: 'segment_conflict', message: 'x' } }),
    );
    await add(r, { seq: 2 });
    r.uploader.start();
    await until(() =>
        r.events.some(([type]) => type === 'upload.segment_rejected'),
    );
    await r.uploader.idle();

    assert.deepEqual(
        (await r.store.listSegments(SID)).map((s) => [s.seq, s.state, s.data]),
        [[2, 'rejected', null]],
    );
});

test('a segment above part_size goes as parts 0/5 to 4/5, in order, each with its own hash', async () => {
    const r = rig();
    r.env.respond((call) =>
        json(201, {
            code:
                call.headers['X-Fitt-Part'] === '4/5'
                    ? 'stored'
                    : 'part_stored',
            segment: {},
        }),
    );
    const record = await add(r, { seq: 1, bytes: 24_117_248 });
    r.uploader.start();
    await until(() => r.env.calls.length === 5);
    await r.uploader.idle();

    assert.deepEqual(
        r.env.calls.map((call) => call.headers['X-Fitt-Part']),
        ['0/5', '1/5', '2/5', '3/5', '4/5'],
    );
    assert.deepEqual(
        r.env.calls.map((call) => (call.body as ArrayBuffer).byteLength),
        [5_242_880, 5_242_880, 5_242_880, 5_242_880, 3_145_728],
    );
    assert.ok(
        r.env.calls.every(
            (call) => call.headers['X-Fitt-Sha256'] === record.sha256,
        ),
    );
    assert.equal(
        r.env.calls[0].headers['X-Fitt-Part-Sha256'],
        await sha256Hex(new Uint8Array(5_242_880).fill(2)),
    );
});

test('the upload events report a send, a failure with its retry delay, and the backlog at most once a second', async () => {
    const r = rig();
    let calls = 0;
    r.env.respond(() =>
        ++calls === 1
            ? json(500, { error: { code: 'server_error', message: 'x' } })
            : STORED(),
    );

    for (const seq of [1, 2, 3]) {
        await add(r, { seq });
    }

    r.uploader.start();
    await r.env.advance(2000);
    await r.uploader.idle();
    const types = r.events.map(([type]) => type);

    assert.deepEqual(
        r.events.find(([type]) => type === 'upload.chunk_failed')![1],
        {
            track: 'camera',
            seq: 1,
            attempt: 1,
            retry_in_ms: 500,
            code: 'server_error',
        },
    );
    assert.equal(
        types.filter((type) => type === 'upload.chunk_sent').length,
        3,
    );
    assert.ok(types.filter((type) => type === 'upload.backlog').length <= 3);
});

test('a segment past abandon_after_ms is abandoned by the sweep, and the track is reported', async () => {
    const r = rig();
    r.env.respond(() =>
        json(500, { error: { code: 'server_error', message: 'x' } }),
    );
    await add(r, { seq: 1, created_ms: 0 });
    r.uploader.start();
    await r.env.advance(601_000);

    assert.deepEqual(r.abandoned, ['camera']);
    assert.equal((await r.store.listSegments(SID))[0].state, 'abandoned');
});

test('stop() aborts the requests in flight and no store write follows', async () => {
    const r = rig();
    r.env.respond(() => new Promise<Response>(() => {}));
    await add(r, { seq: 1 });
    await add(r, { seq: 2 });
    r.uploader.start();
    await until(() => r.env.calls.length === 2);
    await r.uploader.stop();
    await r.store.deleteSession(SID);
    await r.env.advance(60_000);

    assert.deepEqual(await r.store.listSegments(SID), []);
    assert.equal(
        r.events.filter(([type]) => type === 'upload.chunk_failed').length,
        0,
    );
});

test('a token_expired with no newer token pauses without losing the segment, and a new token sends it', async () => {
    const env = fakeEnvironment();
    const errors: (string | null)[] = [];
    const keeper = createTokenKeeper({
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
        setError: (code) => errors.push(code),
    });
    const r = rig({ env, token: keeper });
    r.env.respond((call) =>
        call.headers.Authorization.includes(NEW_ID)
            ? STORED()
            : json(401, {
                  error: {
                      code: 'token_expired',
                      message: 'x',
                      recoverable: true,
                  },
              }),
    );
    await add(r, { seq: 1 });
    r.uploader.start();
    await until(() => r.env.calls.length === 1);
    await r.env.advance(60_000);
    assert.equal(r.env.calls.length, 1);

    const renewed = descriptorFixture();
    renewed.token = { ...renewed.token, id: NEW_ID };
    keeper.set(renewed);
    await until(() => r.env.calls.length === 2);
    await r.uploader.idle();

    assert.equal((await r.store.listSegments(SID))[0].state, 'delivered');
    assert.deepEqual(errors, ['token_expired', null]);
});

test('a 405 on the PUT rung steps down and sends the same segment again at once as a signed POST', async () => {
    const r = rig();
    r.env.respond((call) =>
        call.method === 'PUT'
            ? json(405, { error: { code: 'method_not_allowed', message: 'x' } })
            : STORED(),
    );
    await add(r, { seq: 1 });
    r.uploader.start();
    await until(() => r.env.calls.length === 2);
    await r.uploader.idle();

    assert.deepEqual(
        r.env.calls.map((call) => [call.method, seqOf(call)]),
        [
            ['PUT', 1],
            ['POST', 1],
        ],
    );
    assert.equal((await r.store.listSegments(SID))[0].failures, 0);
    assert.deepEqual(
        r.events.find(([type]) => type === 'upload.chunk_sent')![1],
        { track: 'camera', seq: 1, bytes: 300, transport: 'post', ms: 0 },
    );
});

test('dropTakesBelow takes an earlier take out of the lanes, so it is never sent, and idle() resolves', async () => {
    const r = rig({ currentTake: 2 });
    r.env.respond(STORED);
    await add(r, { seq: 1, take: 1 });
    await add(r, { seq: 2, take: 1 });
    await add(r, { seq: 1, take: 2 });
    r.uploader.dropTakesBelow(2);
    await add(r, { seq: 3, take: 1 });
    r.uploader.start();
    await r.uploader.idle();

    assert.deepEqual(
        r.env.calls.map((call) => call.headers['X-Fitt-Take']),
        ['2'],
    );
    assert.deepEqual(r.uploader.stats(), {
        bytesSent: 300,
        bytesTotal: 900,
        backlog: 0,
    });
});

test('stats() counts what was enqueued, what was delivered and what is pending', async () => {
    const r = rig();
    r.env.respond((call) =>
        seqOf(call) === 2 ? new Promise<Response>(() => {}) : STORED(),
    );
    await add(r, { seq: 1, bytes: 100 });
    await add(r, { seq: 2, bytes: 200 });
    r.uploader.start();
    await r.uploader.idle('audio');
    await until(() => r.uploader.stats().bytesSent === 100);

    assert.deepEqual(r.uploader.stats(), {
        bytesSent: 100,
        bytesTotal: 300,
        backlog: 1,
    });
    await r.uploader.stop();
});

/** The answer descriptor with a 100 byte part_size on the camera track, so a 500 byte segment goes as 5 parts. */
function smallParts() {
    const descriptor = descriptorFixture();
    descriptor.tracks = descriptor.tracks.map((track) =>
        track.track === 'camera'
            ? { ...track, segments: { ...track.segments, part_size: 100 } }
            : track,
    );

    return descriptor;
}

/** A 200 answer to a part the server already holds, while the segment still lacks some parts. */
function partHeld(present: number): Response {
    return json(200, {
        code: 'already_present',
        segment: {
            track: 'camera',
            seq: 1,
            status: 'expected',
            parts_present: present,
            part_count: 5,
        },
    });
}

test('a part answered already_present while later parts are missing goes on to the next part', async () => {
    const r = rig({
        descriptor: smallParts(),
        env: fakeEnvironment({ random: 0 }),
    });
    let failedOnce = false;
    r.env.respond((call) => {
        const part = call.headers['X-Fitt-Part'];

        if (part === '1/5' && !failedOnce) {
            // The server stored the part, but its answer never came back.
            failedOnce = true;

            return json(500, { error: { code: 'server_error', message: 'x' } });
        }

        if (part === '1/5') {
            return partHeld(2);
        }

        return json(201, {
            code: part === '4/5' ? 'stored' : 'part_stored',
            segment: {},
        });
    });
    await add(r, { seq: 1, bytes: 500 });
    r.uploader.start();
    await until(() => failedOnce);
    await r.env.advance(1000);
    await r.uploader.idle();

    assert.deepEqual(
        r.env.calls.map((call) => call.headers['X-Fitt-Part']),
        ['0/5', '1/5', '1/5', '2/5', '3/5', '4/5'],
    );
    assert.equal((await r.store.listSegments(SID))[0].state, 'delivered');
});

test('after parts_missing the resend goes past the parts the server already holds', async () => {
    const r = rig({
        descriptor: smallParts(),
        env: fakeEnvironment({ random: 0 }),
    });
    let lastSends = 0;
    r.env.respond((call) => {
        const part = call.headers['X-Fitt-Part'];

        if (part === '4/5') {
            lastSends += 1;

            // The first time the server says it still lacks a part (it lost part 2); the second time the segment is whole.
            return json(201, {
                code: lastSends === 1 ? 'part_stored' : 'stored',
                segment: {},
            });
        }

        // Every part reaches the server the first time; the second time only part 2 is missing.
        return lastSends === 0 || part === '2/5'
            ? json(201, { code: 'part_stored', segment: {} })
            : partHeld(3);
    });
    await add(r, { seq: 1, bytes: 500 });
    r.uploader.start();
    await until(() => lastSends === 1);
    await r.env.advance(1000);
    await r.uploader.idle();

    assert.deepEqual(
        r.env.calls.map((call) => call.headers['X-Fitt-Part']),
        ['0/5', '1/5', '2/5', '3/5', '4/5', '0/5', '1/5', '2/5', '3/5', '4/5'],
    );
    assert.equal((await r.store.listSegments(SID))[0].state, 'delivered');
});

test('an already_present that shows the segment whole delivers it from any part', async () => {
    const r = rig({ descriptor: smallParts() });
    r.env.respond(() =>
        json(200, {
            code: 'already_present',
            segment: {
                track: 'camera',
                seq: 1,
                status: 'present',
                parts_present: 5,
                part_count: 5,
            },
        }),
    );
    await add(r, { seq: 1, bytes: 500 });
    r.uploader.start();
    await r.uploader.idle();

    assert.deepEqual(
        r.env.calls.map((call) => call.headers['X-Fitt-Part']),
        ['0/5'],
    );
    assert.equal((await r.store.listSegments(SID))[0].state, 'delivered');
});

test('stop() while a hash_mismatch is re-hashing the local copy writes nothing after it resolves', async () => {
    const r = rig();
    r.env.respond(() =>
        json(400, { error: { code: 'hash_mismatch', message: 'x' } }),
    );
    await add(r, { seq: 1, bytes: 4_194_304 });
    const writes: string[] = [];
    let stopped = false;
    let stopping: Promise<void> | null = null;
    let reads = 0;
    const update = r.store.updateSegment.bind(r.store);
    const read = r.store.getSegment.bind(r.store);
    r.store.updateSegment = (key, change) => {
        writes.push(stopped ? 'after stop' : 'before stop');

        return update(key, change);
    };
    r.store.getSegment = (key) => {
        reads += 1;

        if (reads === 2) {
            // The read-back after the answer: stop() lands while the 4 MB copy is hashed.
            setImmediate(() => {
                stopping = r.uploader.stop().then(() => {
                    stopped = true;
                });
            });
        }

        return read(key);
    };
    r.uploader.start();
    await until(() => stopping !== null);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(writes, []);
    assert.deepEqual(
        r.events.filter(([type]) => type === 'upload.chunk_failed'),
        [],
    );
});
