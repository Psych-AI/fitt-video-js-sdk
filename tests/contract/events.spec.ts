import { expect, test } from '@playwright/test';
import { openHarness } from '../browser/support/measure.ts';
import { createSession } from './support.ts';

test('event batches land once, a replay is a no-op, and the numbering survives a reload', async ({
    page,
    request,
}) => {
    const { descriptor } = await createSession(request);
    await openHarness(page);

    const first = await page.evaluate(
        (d) =>
            window.internals.runBatches({
                descriptor: d,
                batches: [['net.offline'], ['net.online']],
                replayFirstWith: ['browser.idle'],
            }),
        descriptor,
    );
    await page.reload();
    await page.waitForFunction(() => 'internals' in window);
    const second = await page.evaluate(
        (d) =>
            window.internals.runBatches({
                descriptor: d,
                batches: [['device.no_audio']],
            }),
        descriptor,
    );

    expect(first.statuses).toEqual([204, 204, 204]);
    expect(first.batchSeqs).toEqual([0, 1, 0]);
    expect(second.statuses).toEqual([204]);
    expect(second.batchSeqs).toEqual([2]);
    expect(second.status).toBe(200);
});
