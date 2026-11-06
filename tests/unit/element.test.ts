import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the element and hosted modules import in Node without a DOM', async () => {
    const ui = await import('../../src/ui.ts');
    const hosted = await import('../../src/hosted.ts');

    assert.equal(typeof ui.defineFittRecorder, 'function');
    assert.equal(typeof hosted.defineFittRecorder, 'function');
    assert.equal(typeof hosted.FittVideo.session, 'function');
});

test('when the session cap stops the take first, the countdown and the bar end at the cap', async () => {
    const { takeClock } = await import('../../src/ui/element.ts');
    // A monitor take: max equals the cap, and the take starts 300 s into the session.
    const limits = {
        countdown_ms: 3000,
        min_duration_ms: 0,
        max_duration_ms: 7_200_000,
        extension_ms: 0,
        warning_before_end_ms: 60_000,
    };
    const capStopAfter = 7_200_000 - 1000 - 300_000;

    assert.equal(takeClock(limits, 0, capStopAfter).remainingMs, 6_899_000);
    assert.equal(
        takeClock(limits, capStopAfter / 2, capStopAfter).fillPercent,
        50,
    );
    assert.equal(
        takeClock(limits, capStopAfter - 60_000, capStopAfter).stage,
        'warning',
    );
    assert.equal(
        takeClock(limits, capStopAfter - 60_000, capStopAfter).warningPercent,
        ((capStopAfter - 60_000) / capStopAfter) * 100,
    );
    assert.deepEqual(
        {
            remaining: takeClock(limits, capStopAfter, capStopAfter)
                .remainingMs,
            fill: takeClock(limits, capStopAfter, capStopAfter).fillPercent,
        },
        { remaining: 0, fill: 100 },
    );
});

test('when the take limit comes first, the countdown runs to the maximum and then through the extension', async () => {
    const { takeClock } = await import('../../src/ui/element.ts');
    const limits = {
        countdown_ms: 3000,
        min_duration_ms: 15_000,
        max_duration_ms: 60_000,
        extension_ms: 10_000,
        warning_before_end_ms: 0,
    };

    assert.deepEqual(takeClock(limits, 30_000, Infinity), {
        remainingMs: 30_000,
        stage: 'normal',
        fillPercent: 50,
        minPercent: 25,
        warningPercent: 100,
    });
    assert.deepEqual(
        {
            remaining: takeClock(limits, 65_000, Infinity).remainingMs,
            stage: takeClock(limits, 65_000, Infinity).stage,
            fill: takeClock(limits, 65_000, Infinity).fillPercent,
        },
        { remaining: 5000, stage: 'grace', fill: 100 },
    );
});

test('a cap that lands inside the extension shortens the grace countdown', async () => {
    const { takeClock } = await import('../../src/ui/element.ts');
    const limits = {
        countdown_ms: 3000,
        min_duration_ms: 0,
        max_duration_ms: 60_000,
        extension_ms: 10_000,
        warning_before_end_ms: 0,
    };

    assert.deepEqual(
        {
            remaining: takeClock(limits, 62_000, 65_000).remainingMs,
            stage: takeClock(limits, 62_000, 65_000).stage,
        },
        { remaining: 3000, stage: 'grace' },
    );
});
