import { expect, test } from '@playwright/test';
import { measured, openHarness } from './support/measure.ts';

test('going offline and back raises net events in order, and fullscreen outside a gesture is refused without an error', async ({
    page,
    browserName,
}, testInfo) => {
    test.setTimeout(30_000);
    const errors = await openHarness(page);
    await page.evaluate(() => window.internals.startSignalsProbe());
    await page.context().setOffline(true);
    await page.waitForTimeout(500);
    await page.context().setOffline(false);
    await page.waitForTimeout(500);
    const events = await page.evaluate(() => window.internals.signalEvents());
    const fullscreen = await page.evaluate(() =>
        window.internals.fullscreenOutsideGesture(),
    );
    testInfo.annotations.push({
        type: 'signals',
        description: JSON.stringify({ events, fullscreen }),
    });

    expect(errors).toEqual([]);
    expect(fullscreen.ok).toBe(false);

    if (measured(testInfo, browserName)) {
        return;
    }

    expect(events.indexOf('net.offline')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('net.offline')).toBeLessThan(
        events.indexOf('net.online'),
    );
});
