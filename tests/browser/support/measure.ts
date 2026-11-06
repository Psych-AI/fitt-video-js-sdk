import type { Page, TestInfo } from '@playwright/test';

/**
 * True for WebKit, where a spec records what it saw instead of asserting it (author's call 3).
 * Linux WebKit is WebKitGTK with a synthetic stream, so its media output says nothing about Safari.
 */
export function measured(testInfo: TestInfo, browserName: string): boolean {
    if (browserName !== 'webkit') {
        return false;
    }

    testInfo.annotations.push({
        type: 'measured',
        description: 'Linux WebKit: recorded, not asserted',
    });

    return true;
}

/**
 * True for Firefox, where an assertion that needs a running AudioContext is recorded instead
 * (owner decision 1): Sail and CI have no audio device, so Firefox's context stays suspended.
 * The caller then accepts `suspended` as well as `running`. Chromium and WebKit still assert.
 */
export function audioMeasured(
    testInfo: TestInfo,
    browserName: string,
    state: string,
): boolean {
    if (browserName !== 'firefox') {
        return false;
    }

    testInfo.annotations.push({
        type: 'measured',
        description: `Firefox AudioContext: ${state} (no audio device)`,
    });

    return true;
}

/** Opens a harness page, waits for `window.internals` and returns a live list of the page's errors. */
export async function openHarness(
    page: Page,
    file = '/tests/browser/harness/index.html',
): Promise<string[]> {
    const errors: string[] = [];

    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(file);
    await page.waitForFunction(() => window.internals !== undefined);

    return errors;
}
