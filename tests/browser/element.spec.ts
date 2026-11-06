import { expect, test } from '@playwright/test';
import { openHarness } from './support/measure.ts';
import { installMedia } from './support/media.ts';

test.beforeEach(({ browserName }) => {
    test.skip(
        browserName !== 'chromium',
        'the element is the same code in every engine; Chromium draws it',
    );
});

const SHORT = {
    countdown_ms: 1000,
    min_duration_ms: 2000,
    max_duration_ms: 60_000,
    extension_ms: 0,
    warning_before_end_ms: 0,
};
/** A minimum far from any polling delay, so the disabled check never races the threshold. */
const LONG_MIN = { ...SHORT, min_duration_ms: 10_000 };

test('data-phase walks the take, and stop is disabled until the minimum', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName);
    await openHarness(page, '/tests/browser/harness/element.html');
    await page.evaluate(
        (recording) => window.mount({ recording, controls: 'full' }),
        LONG_MIN,
    );
    const recorder = page.locator('fitt-recorder');
    await expect(recorder).toHaveAttribute('data-phase', 'ready');

    await recorder.locator('[part=record]').click();
    await expect(recorder).toHaveAttribute('data-phase', 'recording');
    await expect(recorder.locator('[part=stop]')).toBeDisabled();
    await expect(recorder.locator('[part=stop]')).toBeEnabled({
        timeout: 12_000,
    });
    await recorder.locator('[part=stop]').click();
    await expect(recorder).toHaveAttribute('data-phase', 'stopped');

    const phases = await page.evaluate(() => window.__phases);
    const changes = phases.filter((phase, i) => phase !== phases[i - 1]);
    expect(changes.slice(changes.indexOf('ready'))).toEqual([
        'ready',
        'countdown',
        'recording',
        'stopping',
        'stopped',
    ]);
});

test('the view is mirrored by default and not with mirror="false"', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName);
    await openHarness(page, '/tests/browser/harness/element.html');
    await page.evaluate(() => window.mount({ controls: 'none' }));
    await page.evaluate(() =>
        window.mount({ controls: 'none', mirror: 'false' }),
    );
    const transforms = await page
        .locator('fitt-recorder')
        .evaluateAll((elements) =>
            elements.map(
                (el) =>
                    getComputedStyle(
                        el.shadowRoot!.querySelector('[part=view]')!,
                    ).transform,
            ),
        );

    expect(transforms).toEqual(['matrix(-1, 0, 0, 1, 0, 0)', 'none']);
});

test('controls none, minimal and full draw the parts the boards show, and only digits, colons and spaces', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName);
    await openHarness(page, '/tests/browser/harness/element.html');

    for (const controls of ['none', 'minimal', 'full']) {
        await page.evaluate((c) => window.mount({ controls: c }), controls);
    }

    await page
        .locator('fitt-recorder')
        .nth(2)
        .locator('[part=picker-toggle]')
        .click();
    const parts = await page
        .locator('fitt-recorder')
        .evaluateAll((elements) =>
            elements.map((el) =>
                [
                    ...new Set(
                        [...el.shadowRoot!.querySelectorAll('[part]')].map(
                            (node) => node.getAttribute('part'),
                        ),
                    ),
                ].sort(),
            ),
        );
    // The device labels in the picker come from the browser, not the SDK, so the picker is left out of the text check.
    const text = await page.locator('fitt-recorder').evaluateAll((elements) =>
        elements
            .map((el) =>
                [...el.shadowRoot!.childNodes]
                    .filter((node) => node.nodeName !== 'STYLE')
                    .map((node) => {
                        const copy = node.cloneNode(true) as Element;
                        copy.querySelectorAll?.('[part=picker]').forEach(
                            (picker) => picker.remove(),
                        );

                        return copy.matches?.('[part=picker]')
                            ? ''
                            : (copy.textContent ?? '');
                    })
                    .join(''),
            )
            .join(''),
    );
    const formFields = await page
        .locator('fitt-recorder')
        .nth(2)
        .evaluate(
            (el) =>
                el.shadowRoot!.querySelectorAll('input, select, textarea')
                    .length,
        );

    expect(parts).toEqual([
        ['view'],
        ['record', 'stop', 'timer', 'view'],
        [
            'countdown',
            'marker-min',
            'marker-warning',
            'meter',
            'picker',
            'picker-list',
            'picker-option',
            'picker-toggle',
            'progress',
            'record',
            'remaining',
            'stop',
            'timer',
            'view',
        ],
    ]);
    expect(text).toMatch(/^[0-9: ]*$/);
    expect(formFields).toBe(0);
    expect(await page.evaluate(() => window.__audioElements)).toBe(0);
});

test('the meter and the dead microphone detector work in ready after the first click on the page', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    await openHarness(page, '/tests/browser/harness/element.html');
    await page.evaluate(() => window.mount({ controls: 'full' }));
    const recorder = page.locator('fitt-recorder');
    await page.click('#gesture'); // a click away from the recorder's controls
    await page.waitForTimeout(6000);
    await expect(recorder).toHaveAttribute('data-audio', 'ok'); // the tone was read for longer than noAudioMs (5000)

    await page.evaluate(() => window.__fakeMicGain?.(0));
    await expect(recorder).toHaveAttribute('data-audio', 'silent', {
        timeout: 6500,
    });
    await expect(recorder).toHaveAttribute('data-phase', 'ready');
});

test('start-label follows the countdown digits and the six slots take their children', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName);
    await openHarness(page, '/tests/browser/harness/element.html');
    const slots = [
        'instructions',
        'error',
        'checking',
        'controls',
        'no-audio',
        'rejected',
    ];
    await page.evaluate(
        ({ recording, slots }) =>
            window.mount({
                recording,
                controls: 'full',
                startLabel: 'Go',
                slots,
            }),
        { recording: SHORT, slots },
    );
    const recorder = page.locator('fitt-recorder');
    await recorder.locator('[part=record]').click();

    await expect(recorder.locator('[part=countdown]')).toHaveText('1');
    await expect(recorder.locator('[part=countdown]')).toHaveText('Go');
    expect(
        await recorder.evaluate(
            (el, names) =>
                names.map(
                    (name) =>
                        el
                            .shadowRoot!.querySelector<HTMLSlotElement>(
                                `slot[name=${name}]`,
                            )!
                            .assignedNodes()[0]?.textContent,
                ),
            slots,
        ),
    ).toEqual(slots);
});

test('a maximum below the minimum is fitt-error config_invalid and data-error, not a throw', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName);
    const errors = await openHarness(
        page,
        '/tests/browser/harness/element.html',
    );
    await page.evaluate(() =>
        window.mount({
            recording: {
                countdown_ms: 0,
                min_duration_ms: 2000,
                max_duration_ms: 1000,
                extension_ms: 0,
                warning_before_end_ms: 0,
            },
        }),
    );

    await expect(page.locator('fitt-recorder')).toHaveAttribute(
        'data-error',
        'config_invalid',
    );
    expect(
        await page.evaluate(() =>
            window.__events
                .filter((e) => e.type === 'fitt-error')
                .map((e) => e.detail.code),
        ),
    ).toEqual(['config_invalid']);
    expect(errors).toEqual([]);
});

test('the six fitt events carry the core payloads', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName);
    await openHarness(page, '/tests/browser/harness/element.html');
    const done = {
        session: { id: 'x', status: 'finalising', take: 1, end_ms: null },
        tracks: [],
        checks: { status: 'done', verdict: 'accept', take: 1, reasons: [] },
        upload: { bytes_received: 0 },
        playback: { camera: { url: 'https://media.example/camera.webm' } },
    };
    await page.evaluate(
        ({ recording, statusBody }) =>
            window.mount({ recording, controls: 'full', statusBody }),
        { recording: SHORT, statusBody: done },
    );
    const recorder = page.locator('fitt-recorder');
    await recorder.locator('[part=record]').click();
    await page.waitForTimeout(3500);
    await recorder.locator('[part=stop]').click();
    await expect(recorder).toHaveAttribute('data-phase', 'stopped');
    await expect(recorder).toHaveAttribute('data-upload', 'active');
    await page.evaluate(async () => {
        const element = document.querySelector(
            'fitt-recorder',
        ) as HTMLElement & {
            session: {
                waitForChecks(): Promise<unknown>;
                waitForReady(o: { track: string }): Promise<unknown>;
                finalise(): Promise<void>;
            };
        };
        await element.session.waitForChecks();
        await element.session.waitForReady({ track: 'camera' });
        await element.session.finalise();
    });
    await expect(recorder).toHaveAttribute('data-checks', 'done');
    await expect(recorder).toHaveAttribute('data-upload', 'done');
    const uploads = await page.evaluate(() => window.__uploads);
    expect(uploads.indexOf('active')).toBeGreaterThanOrEqual(0);
    expect(uploads.indexOf('active')).toBeLessThan(uploads.lastIndexOf('done'));
    const events = await page.evaluate(() => window.__events);
    const first = (type: string) => events.find((e) => e.type === type)?.detail;

    expect(first('fitt-state')).toEqual(
        expect.objectContaining({
            phase: expect.any(String),
            upload: expect.any(Object),
        }),
    );
    expect(first('fitt-event')).toEqual(
        expect.objectContaining({
            id: expect.stringMatching(/^[0-9a-hjkmnp-tv-z]{26}$/),
            type: expect.any(String),
        }),
    );
    expect(first('fitt-milestone')).toEqual(
        expect.objectContaining({ name: 'countdown_last' }),
    );
    expect(first('fitt-checks')).toEqual({
        status: 'done',
        verdict: 'accept',
        take: 1,
        reasons: [],
    });
    expect(first('fitt-ready')).toEqual({
        track: 'camera',
        url: 'https://media.example/camera.webm',
    });
});

test('removing the element mid-take hands the stall watch back to the session', async ({
    page,
    browserName,
}) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    await openHarness(page, '/tests/browser/harness/element.html');
    await page.click('#gesture');
    await page.evaluate(
        (recording) => window.mount({ recording, controls: 'full' }),
        LONG_MIN,
    );
    const recorder = page.locator('fitt-recorder');
    await recorder.locator('[part=record]').click();
    await expect(recorder).toHaveAttribute('data-phase', 'recording');
    await page.evaluate(() => {
        const element = document.querySelector(
            'fitt-recorder',
        ) as HTMLElement & {
            session: {
                onEvent(
                    listener: (event: { type: string }) => void,
                ): () => void;
            };
        };
        const stalls: string[] = [];
        (window as unknown as { __stalls: string[] }).__stalls = stalls;
        element.session.onEvent(
            (event) =>
                event.type === 'recorder.stalled' && stalls.push(event.type),
        );
        element.remove();
    });
    await page.waitForTimeout(3000);
    expect(
        await page.evaluate(
            () => (window as unknown as { __stalls: string[] }).__stalls.length,
        ),
    ).toBe(0);

    await page.evaluate(() => window.__fakeFreezeCamera?.(true));
    await page.waitForTimeout(4000);
    expect(
        await page.evaluate(
            () => (window as unknown as { __stalls: string[] }).__stalls.length,
        ),
    ).toBe(1);
});
