import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createLadder,
    type Attempt,
    type FailureKind,
    type Ladder,
} from '../../src/core/ladder.ts';
import type { Transport } from '../../src/core/store.ts';

let tick = 0;

/** A failure of a request sent on the current rung after the last one failed: a separate attempt. */
function fail(
    ladder: Ladder,
    kind: FailureKind,
    online = true,
    over: Partial<Attempt> = {},
): boolean {
    tick += 10;

    return ladder.failure(kind, online, {
        startedAtMs: tick,
        endedAtMs: tick + 5,
        rung: ladder.rung(),
        ...over,
    });
}

function rig(
    options: {
        rung?: Transport;
        everSucceeded?: boolean;
        forcePost?: boolean;
    } = {},
) {
    const persisted: [Transport, boolean][] = [];
    const events: [string, Record<string, unknown>][] = [];
    let blockedCalls = 0;
    const ladder = createLadder({
        rung: options.rung ?? 'put',
        everSucceeded: options.everSucceeded ?? false,
        forcePost: options.forcePost,
        persist: async (rung, ever) => {
            persisted.push([rung, ever]);
        },
        emit: (type, payload) => events.push([type, payload]),
        onBlocked: () => {
            blockedCalls += 1;
        },
    });

    return { ladder, persisted, events, blockedCalls: () => blockedCalls };
}

test('two network errors in a row while online step down to the signed POST, once, persisted', () => {
    const { ladder, persisted, events } = rig();
    assert.equal(fail(ladder, 'network'), false);
    assert.equal(ladder.rung(), 'put');
    assert.equal(fail(ladder, 'network'), true);

    assert.equal(ladder.rung(), 'post');
    assert.deepEqual(events, [
        [
            'upload.transport_fallback',
            { from: 'put', to: 'post', reason: 'network' },
        ],
    ]);
    assert.deepEqual(persisted.at(-1), ['post', false]);
});

test('errors while offline do not count, and a success between errors resets the count', () => {
    const { ladder } = rig();
    fail(ladder, 'network', false);
    fail(ladder, 'network', false);
    fail(ladder, 'network', false);
    fail(ladder, 'network');
    ladder.success();
    fail(ladder, 'network');

    assert.equal(ladder.rung(), 'put');
});

test('the POST rung is kept after successes and after a reload, and never steps back up', () => {
    const { ladder } = rig();
    fail(ladder, 'network');
    fail(ladder, 'network');

    for (let i = 0; i < 10; i++) {
        ladder.success();
    }

    assert.equal(ladder.rung(), 'post');
    assert.equal(rig({ rung: 'post' }).ladder.rung(), 'post');
});

test('upload.transport post starts on the POST rung', () => {
    assert.equal(rig({ forcePost: true }).ladder.rung(), 'post');
});

test('a 405, or a 403 from a proxy, steps down at once', () => {
    const method = rig();
    assert.equal(fail(method.ladder, 'method'), true);
    const proxy = rig();
    fail(proxy.ladder, 'proxy');

    assert.deepEqual(
        [method.ladder.rung(), proxy.ladder.rung()],
        ['post', 'post'],
    );
    assert.deepEqual(method.events[0], [
        'upload.transport_fallback',
        { from: 'put', to: 'post', reason: 'method' },
    ]);
});

test('both rungs failing before anything ever succeeded is network_blocked, which is not terminal', () => {
    const { ladder, blockedCalls } = rig();

    for (let i = 0; i < 4; i++) {
        fail(ladder, 'network');
    }

    assert.equal(ladder.rung(), 'post');
    assert.equal(ladder.blocked(), true);
    assert.equal(blockedCalls(), 1);
    ladder.success();
    assert.equal(ladder.blocked(), false);
});

test('a 2xx from another API call counts as a success for network_blocked, without resetting the failure count', () => {
    const { ladder } = rig();
    ladder.markSucceeded();

    for (let i = 0; i < 4; i++) {
        fail(ladder, 'network');
    }

    assert.deepEqual([ladder.rung(), ladder.blocked()], ['post', false]);
});

test('once anything succeeded, failures on both rungs are only retries', () => {
    const { ladder } = rig({ everSucceeded: true });

    for (let i = 0; i < 6; i++) {
        fail(ladder, 'network');
    }

    assert.equal(ladder.blocked(), false);
});

test('a readable 403 origin_not_allowed is network_blocked at once', () => {
    const { ladder } = rig({ everSucceeded: true });
    fail(ladder, 'blocked');

    assert.equal(ladder.blocked(), true);
    assert.equal(ladder.rung(), 'put');
});

test('four simultaneous network failures count as one', () => {
    const { ladder } = rig();

    for (let i = 0; i < 4; i++) {
        ladder.failure('network', true, {
            startedAtMs: 0,
            endedAtMs: 5,
            rung: 'put',
        });
    }

    assert.equal(ladder.rung(), 'put');
});

test('a PUT that fails after the step down does not count on the POST rung', () => {
    const { ladder } = rig();
    fail(ladder, 'network');
    fail(ladder, 'network');
    assert.equal(fail(ladder, 'network', true, { rung: 'put' }), false);
    fail(ladder, 'network');

    assert.deepEqual([ladder.rung(), ladder.blocked()], ['post', false]);
});

test('a timeout never steps down', () => {
    const { ladder } = rig();

    for (let i = 0; i < 4; i++) {
        fail(ladder, 'network', true, { timedOut: true });
    }

    assert.deepEqual([ladder.rung(), ladder.blocked()], ['put', false]);
});

test('on the POST rung a 405 or a proxy 403 changes nothing and returns false', () => {
    const { ladder, events } = rig({ rung: 'post', everSucceeded: true });

    assert.equal(fail(ladder, 'method'), false);
    assert.equal(fail(ladder, 'proxy'), false);
    assert.deepEqual(
        [ladder.rung(), ladder.blocked(), events],
        ['post', false, []],
    );
});
