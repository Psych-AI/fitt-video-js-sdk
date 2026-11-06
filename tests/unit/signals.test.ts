import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import { environmentSnapshot, startSignals } from '../../src/signals/index.ts';
import { fakeEnvironment } from '../support/fake-env.ts';
import { fakePage } from '../support/fake-page.ts';

function rig(page = fakePage()) {
    const env = fakeEnvironment();
    const clock = createClock(env);
    const events: [string, number, Record<string, unknown> | undefined][] = [];
    const stop = startSignals({
        page,
        env,
        clock,
        emit: (type, payload) => {
            events.push([type, clock.now(), payload]);

            return null;
        },
    });

    return { env, page, events, stop };
}

test('three resizes give one browser.resize, 300 ms after the last', async () => {
    const r = rig();

    for (const width of [1000, 1100, 1200]) {
        r.page.win.innerWidth = width;
        r.page.win.dispatchEvent(new Event('resize'));
        await r.env.advance(100);
    }

    await r.env.advance(300);
    assert.deepEqual(
        r.events.filter(([type]) => type === 'browser.resize'),
        [
            [
                'browser.resize',
                500,
                {
                    width: 1200,
                    height: 800,
                    outer_width: 1280,
                    outer_height: 880,
                },
            ],
        ],
    );
    r.stop();
});

test('a focus change the window events missed is found by the 1 s hasFocus poll, and freeze is browser.page_hidden', async () => {
    const r = rig();
    Object.assign(r.page.doc, { hasFocus: () => false });
    await r.env.advance(1000);
    await r.env.advance(2000);
    Object.assign(r.page.doc, { hasFocus: () => true });
    await r.env.advance(1000);
    r.page.win.dispatchEvent(new Event('blur'));
    Object.assign(r.page.doc, { hasFocus: () => false });
    await r.env.advance(1000);
    r.page.doc.dispatchEvent(new Event('freeze'));

    assert.deepEqual(
        r.events.map(([type, t, payload]) => [type, t, payload]),
        [
            ['browser.blur', 1000, {}],
            ['browser.focus', 4000, {}],
            ['browser.blur', 4000, {}],
            ['browser.page_hidden', 5000, { reason: 'freeze' }],
        ],
    );
    r.stop();
});

test('a connection type change is net.connection_changed', () => {
    const r = rig();
    const connection = r.page.nav!.connection!;
    Object.assign(connection, { type: 'cellular', effectiveType: '3g' });
    connection.dispatchEvent!(new Event('change'));

    assert.deepEqual(
        r.events.map(([type, , payload]) => [type, payload]),
        [
            [
                'net.connection_changed',
                { type: 'cellular', effective_type: '3g' },
            ],
        ],
    );
    r.stop();
});

test('copy and paste report lengths only, never text', async () => {
    const r = rig();
    r.page.doc.dispatchEvent(new Event('copy'));
    const paste = new Event('paste');
    Object.defineProperty(paste, 'clipboardData', {
        value: { getData: () => 'secret words' },
    });
    r.page.doc.dispatchEvent(paste);

    assert.deepEqual(
        r.events.map(([type, , payload]) => [type, payload]),
        [
            ['browser.copy', { length: 5, target: null }],
            ['browser.paste', { length: 12, target: null }],
        ],
    );
    assert.ok(
        !JSON.stringify(r.events).includes('hello') &&
            !JSON.stringify(r.events).includes('secret'),
    );
    r.stop();
});

test('30 s with no input is one browser.idle, and input starts the count again', async () => {
    const r = rig();
    await r.env.advance(29_999);
    assert.equal(
        r.events.filter(([type]) => type === 'browser.idle').length,
        0,
    );

    await r.env.advance(1);
    await r.env.advance(60_000);
    assert.deepEqual(
        r.events
            .filter(([type]) => type === 'browser.idle')
            .map(([, t, payload]) => [t, payload]),
        [[30_000, { idle_ms: 30_000 }]],
    );

    r.page.doc.dispatchEvent(new Event('keydown'));
    await r.env.advance(30_000);
    assert.equal(
        r.events.filter(([type]) => type === 'browser.idle').length,
        2,
    );
    r.stop();
});

test('visibility and the network raise their events', () => {
    const r = rig();
    r.page.doc.visibilityState = 'hidden';
    r.page.doc.dispatchEvent(new Event('visibilitychange'));
    r.page.doc.visibilityState = 'visible';
    r.page.doc.dispatchEvent(new Event('visibilitychange'));
    r.page.win.dispatchEvent(new Event('offline'));
    r.page.win.dispatchEvent(new Event('online'));

    assert.deepEqual(
        r.events.map(([type]) => type),
        ['browser.hidden', 'browser.visible', 'net.offline', 'net.online'],
    );
    r.stop();
});

test('PrintScreen and the named combinations are reported, never other keys or text', () => {
    const r = rig();

    for (const init of [
        { key: 'PrintScreen' },
        { key: 'c', ctrlKey: true },
        { key: 'I', ctrlKey: true, shiftKey: true },
        { key: 'v', metaKey: true },
        { key: 'a' },
        { key: 'q', metaKey: true },
    ]) {
        r.page.doc.dispatchEvent(
            Object.assign(new Event('keydown'), {
                ctrlKey: false,
                metaKey: false,
                shiftKey: false,
                ...init,
            }),
        );
    }

    assert.deepEqual(
        r.events.map(([type, , payload]) => [type, payload]),
        [
            ['browser.print_screen', {}],
            ['browser.key_combo', { combo: 'Ctrl+C' }],
            ['browser.key_combo', { combo: 'Ctrl+Shift+I' }],
            ['browser.key_combo', { combo: 'Meta+V' }],
        ],
    );
    r.stop();
});

test('screen.isExtended gives browser.multiple_screens, and a pixel ratio change is browser.screen_changed', async () => {
    const r = rig(fakePage({ extended: true }));
    r.page.win.devicePixelRatio = 1;
    r.page.win.dispatchEvent(new Event('resize'));
    await r.env.advance(2000);

    assert.deepEqual(
        r.events
            .filter(
                ([type]) =>
                    type === 'browser.multiple_screens' ||
                    type === 'browser.screen_changed',
            )
            .map(([type, , payload]) => [type, payload]),
        [
            ['browser.multiple_screens', { extended: true }],
            ['browser.screen_changed', { width: 1920, height: 1080, dpr: 1 }],
        ],
    );
    r.stop();
});

test('cut, drag and drop are reported without their content', () => {
    const r = rig();
    r.page.doc.dispatchEvent(new Event('cut'));
    r.page.doc.dispatchEvent(new Event('dragstart'));
    r.page.doc.dispatchEvent(new Event('drop'));

    assert.deepEqual(
        r.events.map(([type, , payload]) => [type, payload]),
        [
            ['browser.cut', { length: 5, target: null }],
            ['browser.drag_start', {}],
            ['browser.drop', {}],
        ],
    );
    r.stop();
});

test('the pointer leaving the page is browser.pointer_left, at most once a second', async () => {
    const r = rig();
    const leave = (): boolean =>
        r.page.doc.documentElement!.dispatchEvent(new Event('pointerleave'));
    leave();
    leave();
    await r.env.advance(1000);
    leave();

    assert.equal(
        r.events.filter(([type]) => type === 'browser.pointer_left').length,
        2,
    );
    r.stop();
});

test('beforeunload is page.leave_attempt and never asks the candidate to stay', () => {
    const r = rig();
    const event = new Event('beforeunload', { cancelable: true });
    r.page.win.dispatchEvent(event);

    assert.deepEqual(
        r.events.map(([type]) => type),
        ['page.leave_attempt'],
    );
    assert.equal(event.defaultPrevented, false);
    r.stop();
});

test('the environment snapshot holds the permission-free facts', () => {
    const snapshot = environmentSnapshot(fakePage({ extended: false }), {
        sdk_version: '1.0.0',
        cameras: ['Integrated Camera'],
        microphones: ['Microphone'],
    });

    assert.deepEqual(snapshot, {
        ua: 'test',
        languages: ['en'],
        screen: { width: 1920, height: 1080, dpr: 2, extended: false },
        viewport: { width: 1280, height: 800 },
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        in_iframe: false,
        touch_points: 0,
        network_type: '4g',
        sdk_version: '1.0.0',
        cameras: ['Integrated Camera'],
        microphones: ['Microphone'],
    });
});

test('stop removes every listener and timer', async () => {
    const r = rig();
    r.stop();
    r.page.doc.visibilityState = 'hidden';
    r.page.doc.dispatchEvent(new Event('visibilitychange'));
    r.page.doc.dispatchEvent(new Event('copy'));
    r.page.win.dispatchEvent(new Event('resize'));
    r.page.win.dispatchEvent(new Event('offline'));
    r.page.nav!.connection!.dispatchEvent!(new Event('change'));
    Object.assign(r.page.doc, { hasFocus: () => false });
    await r.env.advance(60_000);

    assert.deepEqual(r.events, []);
});

test('a copy in a text field reports the length of its own selection, and AltGr is never a combination', () => {
    const r = rig();
    const copy = new Event('copy');
    Object.defineProperty(copy, 'target', {
        value: { tagName: 'TEXTAREA', selectionStart: 2, selectionEnd: 9 },
    });
    r.page.doc.dispatchEvent(copy);
    r.page.doc.dispatchEvent(
        Object.assign(new Event('keydown'), {
            key: 'c',
            ctrlKey: true,
            altKey: true,
            metaKey: false,
            shiftKey: false,
        }),
    );

    assert.deepEqual(
        r.events.map(([type, , payload]) => [type, payload]),
        [['browser.copy', { length: 7, target: 'textarea' }]],
    );
    r.stop();
});
