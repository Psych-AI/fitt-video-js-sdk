import { expect, test } from '@playwright/test';
import { audioMeasured, measured, openHarness } from './support/measure.ts';
import { installMedia } from './support/media.ts';

test('with no attachPreview, the session watches its own element and a frozen camera is recorder.stalled', async ({
    page,
    browserName,
}, testInfo) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    await openHarness(page);
    await page.click('#gesture');
    const events = await page.evaluate(() => window.internals.stallProbe());
    testInfo.annotations.push({
        type: 'events',
        description: JSON.stringify(events),
    });

    if (measured(testInfo, browserName)) {
        return;
    }

    expect(events).toContain('recorder.stalled');
});

test('the session wires the meter to the dead microphone detector in ready', async ({
    page,
    browserName,
}, testInfo) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    await openHarness(page);
    await page.click('#gesture');
    const probe = await page.evaluate(() => window.internals.silenceProbe());
    testInfo.annotations.push({
        type: 'silence',
        description: JSON.stringify(probe),
    });

    // Owner decision 1: Firefox has no audio device here, so its AudioContext never runs and the meter reads 0.
    if (
        audioMeasured(
            testInfo,
            browserName,
            probe.level > 0
                ? `running (meter level ${probe.level})`
                : 'suspended (meter level 0)',
        )
    ) {
        return;
    }

    expect(probe.level).toBeGreaterThan(0.01);
    expect([probe.before, probe.after]).toEqual(['ok', 'silent']);
    expect(probe.events).toContain('device.no_audio');
});
