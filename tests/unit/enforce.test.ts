import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import { createStayOnPage, readEnforce } from '../../src/core/enforce.ts';
import { fakeEnvironment } from '../support/fake-env.ts';
import { fakePage } from '../support/fake-page.ts';

function rig() {
    const env = fakeEnvironment();
    const clock = createClock(env);
    const page = fakePage();
    const events: [string, number, Record<string, unknown> | undefined][] = [];
    const forced: number[] = [];
    const guard = createStayOnPage({
        page,
        env,
        clock,
        graceMs: 10_000,
        emit: (type, payload) => {
            events.push([type, clock.now(), payload]);

            return null;
        },
        forceStop: () => forced.push(clock.now()),
    });
    guard.arm();
    const hide = (): void => {
        page.doc.visibilityState = 'hidden';
        page.doc.dispatchEvent(new Event('visibilitychange'));
    };
    const show = (): void => {
        page.doc.visibilityState = 'visible';
        page.doc.dispatchEvent(new Event('visibilitychange'));
    };
    const ticks = (): unknown[] =>
        events
            .filter(([type]) => type === 'enforce.leave_tick')
            .map(([, , payload]) => payload?.remaining_ms);

    return { env, page, events, forced, guard, hide, show, ticks };
}

test('hidden: a leave_tick each second from 9000 down to 1000, then left_page and the forced stop at 10 s', async () => {
    const r = rig();
    r.hide();
    await r.env.advance(10_000);

    assert.deepEqual(
        r.ticks(),
        [9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000],
    );
    assert.deepEqual(r.events.at(-1), [
        'enforce.left_page',
        10_000,
        { grace_ms: 10_000 },
    ]);
    assert.deepEqual(r.forced, [10_000]);
});

test('visible again at 4 s cancels', async () => {
    const r = rig();
    r.hide();
    await r.env.advance(4000);
    r.show();
    await r.env.advance(20_000);

    assert.deepEqual(r.ticks(), [9000, 8000, 7000, 6000]);
    assert.deepEqual(r.forced, []);
});

test('a blur while visible counts, and focus resets the grace', async () => {
    const r = rig();
    // A real blur also leaves document.hasFocus() false, and a focus makes it true.
    Object.assign(r.page.doc, { hasFocus: () => false });
    r.page.win.dispatchEvent(new Event('blur'));
    await r.env.advance(3000);
    Object.assign(r.page.doc, { hasFocus: () => true });
    r.page.win.dispatchEvent(new Event('focus'));
    await r.env.advance(3000);
    Object.assign(r.page.doc, { hasFocus: () => false });
    r.page.win.dispatchEvent(new Event('blur'));
    await r.env.advance(1000);

    assert.deepEqual(r.ticks(), [9000, 8000, 7000, 9000]);
});

test('a blur into a child frame, with hasFocus() still true, is not away', async () => {
    const r = rig();
    r.page.win.dispatchEvent(new Event('blur'));
    await r.env.advance(20_000);

    assert.deepEqual(r.ticks(), []);
    assert.deepEqual(r.forced, []);
});

test('a return to focus that raised no focus event is found by hasFocus() and cancels', async () => {
    const r = rig();
    Object.assign(r.page.doc, { hasFocus: () => false });
    r.page.win.dispatchEvent(new Event('blur'));
    await r.env.advance(2500);
    Object.assign(r.page.doc, { hasFocus: () => true });
    await r.env.advance(20_000);

    assert.deepEqual(r.ticks(), [9000, 8000]);
    assert.deepEqual(r.forced, []);

    Object.assign(r.page.doc, { hasFocus: () => false });
    r.page.win.dispatchEvent(new Event('blur'));
    await r.env.advance(1000);
    r.hide();
    await r.env.advance(1000);
    Object.assign(r.page.doc, { hasFocus: () => true });
    r.show();
    await r.env.advance(20_000);

    assert.deepEqual(r.ticks(), [9000, 8000, 9000, 8000]);
    assert.deepEqual(r.forced, []);
});

test('a throttled timer reports the remaining grace from the real elapsed time', async () => {
    const r = rig();
    r.hide();
    r.env.stall(4000);
    await r.env.advance(1000);

    assert.deepEqual(r.ticks(), [6000, 5000]);
});

test('only stay_on_page is read; other enforce keys are ignored with a warning', () => {
    const warnings: string[] = [];

    assert.deepEqual(
        readEnforce(
            { stay_on_page: { grace_ms: 10_000 }, block_clipboard: true },
            (message) => warnings.push(message),
        ),
        { stayOnPage: { graceMs: 10_000 } },
    );
    assert.deepEqual(warnings, [
        'Fitt Video ignores enforce.block_clipboard in this version.',
    ]);
    assert.deepEqual(
        readEnforce({}, () => {}),
        { stayOnPage: null },
    );
});

test('the forced stop comes once, and the guard disarms itself after it', async () => {
    const r = rig();
    r.hide();
    await r.env.advance(10_000);
    r.show();
    r.hide();
    await r.env.advance(20_000);

    assert.deepEqual(r.forced, [10_000]);
    assert.equal(
        r.events.filter(([type]) => type === 'enforce.left_page').length,
        1,
    );
});

test('a grace that is not whole seconds ends on time, and disarm cancels', async () => {
    const env = fakeEnvironment();
    const clock = createClock(env);
    const page = fakePage();
    const events: [string, number, Record<string, unknown> | undefined][] = [];
    const forced: number[] = [];
    const guard = createStayOnPage({
        page,
        env,
        clock,
        graceMs: 2500,
        emit: (type, payload) => (
            events.push([type, clock.now(), payload]),
            null
        ),
        forceStop: () => forced.push(clock.now()),
    });
    guard.arm();
    page.doc.visibilityState = 'hidden';
    page.doc.dispatchEvent(new Event('visibilitychange'));
    await env.advance(5000);

    assert.deepEqual(events, [
        ['enforce.leave_tick', 1000, { remaining_ms: 1500 }],
        ['enforce.leave_tick', 2000, { remaining_ms: 500 }],
        ['enforce.left_page', 2500, { grace_ms: 2500 }],
    ]);
    assert.deepEqual(forced, [2500]);

    const second = createStayOnPage({
        page,
        env,
        clock,
        graceMs: 2500,
        emit: () => null,
        forceStop: () => forced.push(clock.now()),
    });
    second.arm();
    await env.advance(1000);
    second.disarm();
    await env.advance(5000);
    assert.deepEqual(forced, [2500]);
});

test('stay_on_page without a usable grace takes the default', () => {
    assert.deepEqual(
        readEnforce({ stay_on_page: true }, () => {}),
        { stayOnPage: { graceMs: 10_000 } },
    );
    assert.deepEqual(
        readEnforce({ stay_on_page: { grace_ms: 'soon' } }, () => {}),
        { stayOnPage: { graceMs: 10_000 } },
    );
    assert.deepEqual(
        readEnforce({ stay_on_page: false }, () => {}),
        { stayOnPage: null },
    );
});
