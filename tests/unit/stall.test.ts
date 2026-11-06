import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import { createStallWatch } from '../../src/recorder/stall.ts';
import { fakeEnvironment } from '../support/fake-env.ts';

test('no frame for 2 s raises recorder.stalled once, and never while the page is hidden', async () => {
    const env = fakeEnvironment();
    let frame: () => void = () => {};
    const video = {
        requestVideoFrameCallback: (callback: () => void) => {
            frame = callback;
            return 1;
        },
        cancelVideoFrameCallback: () => {},
    };
    const doc = Object.assign(new EventTarget(), {
        visibilityState: 'visible',
    });
    const events: string[] = [];
    const watch = createStallWatch({
        env,
        clock: createClock(env),
        video,
        frameRate: 30,
        doc,
        emit: (type) => events.push(type),
    });
    watch.start();

    frame();
    await env.advance(1000);
    frame();
    await env.advance(1999);
    assert.deepEqual(events, []);
    await env.advance(1);
    assert.deepEqual(events, ['recorder.stalled']);
    await env.advance(5000);
    assert.deepEqual(events, ['recorder.stalled']);

    frame();
    doc.visibilityState = 'hidden';
    await env.advance(5000);
    assert.deepEqual(events, ['recorder.stalled']);
    watch.stop();
});

test('fewer than half the target frames over 5 s is recorder.fps_drop, once until it recovers', async () => {
    const env = fakeEnvironment();
    let frame: () => void = () => {};
    const video = {
        requestVideoFrameCallback: (callback: () => void) => {
            frame = callback;
            return 1;
        },
        cancelVideoFrameCallback: () => {},
    };
    const doc = Object.assign(new EventTarget(), {
        visibilityState: 'visible',
    });
    const events: [string, Record<string, unknown>][] = [];
    const watch = createStallWatch({
        env,
        clock: createClock(env),
        video,
        frameRate: 30,
        doc,
        emit: (type, payload) => events.push([type, payload]),
    });
    watch.start();

    for (let i = 0; i < 100; i++) {
        frame();
        await env.advance(100); // 10 frames a second against a target of 30
    }

    assert.deepEqual(events, [
        ['recorder.fps_drop', { track: 'camera', fps: 10, target: 30 }],
    ]);
    watch.stop();
});
