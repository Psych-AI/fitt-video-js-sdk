import { expect, test } from '@playwright/test';
import { STORE_CASES } from '../shared/store-suite.ts';
import { openHarness } from './support/measure.ts';

for (const storeCase of STORE_CASES) {
    test(`IndexedDB store: ${storeCase.name}`, async ({ page }) => {
        await openHarness(page);

        expect(
            await page.evaluate(
                (name) => window.internals.runStoreCase(name),
                storeCase.name,
            ),
        ).toBeNull();
    });
}

test('IndexedDB records survive a reload', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => window.internals.writeReloadProbe());
    await page.reload();
    await page.waitForFunction(() => 'internals' in window);

    expect(
        await page.evaluate(() => window.internals.readReloadProbe()),
    ).toEqual({ sessions: 1, runs: 1, segments: 1, batches: 1 });
});

test('storedBytes() after a reopen counts only the bytes still held', async ({
    page,
}) => {
    await openHarness(page);

    expect(await page.evaluate(() => window.internals.reopenBytesProbe())).toBe(
        5,
    );
});

test('a request that fails inside a transaction rejects with its own error, by name', async ({
    page,
}) => {
    await openHarness(page);

    expect(
        await page.evaluate(() => window.internals.requestErrorProbe()),
    ).toBe('ConstraintError');
});
