import { test, type Page, type TestInfo } from '@playwright/test';

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

/** Linux WebKit may ship without MediaRecorder, or refuse to record: skip, and say so in the report. */
export async function skipWithoutRecorder(page: Page): Promise<void> {
    // A throwaway stream that never touches navigator.mediaDevices, so the stub's AudioContext is still made after a click.
    const result = await page.evaluate(() => {
        if (typeof MediaRecorder === 'undefined') {
            return 'missing';
        }

        const context = new AudioContext();
        const stream = new MediaStream([
            ...document
                .createElement('canvas')
                .captureStream(30)
                .getVideoTracks(),
            ...context.createMediaStreamDestination().stream.getAudioTracks(),
        ]);

        try {
            const recorder = new MediaRecorder(stream);
            recorder.start(1000);
            recorder.stop();

            return 'present';
        } catch (error) {
            return 'refused: ' + (error as Error).name;
        } finally {
            stream.getTracks().forEach((track) => track.stop());
            void context.close();
        }
    });
    test.info().annotations.push({
        type: 'media-recorder',
        description: result,
    });
    test.skip(
        result !== 'present',
        'MediaRecorder cannot record in this engine: ' + result,
    );
}

/**
 * Owner decision 2: Linux WebKit has no MediaRecorder at all, so a spec that records asserts the
 * recorder_unsupported path there instead of skipping. True (with a `media-recorder` annotation)
 * when this engine has no MediaRecorder; false where it has one, and the spec records as written.
 */
export async function assertsUnsupported(page: Page): Promise<boolean> {
    const missing = await page.evaluate(
        () => typeof MediaRecorder === 'undefined',
    );

    if (missing) {
        test.info().annotations.push({
            type: 'media-recorder',
            description: 'missing: the recorder_unsupported path is asserted',
        });
    }

    return missing;
}
