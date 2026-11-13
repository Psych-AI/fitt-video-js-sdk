import { expect, test } from '@playwright/test';
import { createCutter } from '../../src/cut/select.ts';
import type { CutSegment } from '../../src/cut/types.ts';
import { readSet } from '../support/fixtures.ts';
import { openHarness } from './support/measure.ts';
import { installMedia } from './support/media.ts';

const base64 = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString('base64');

/** A fixture set cut as a run cuts it, as the page receives it. */
function cut(name: string) {
    const set = readSet(name);
    const cutter = createCutter(
        set.mimeType,
        { targetMs: 5000, maxMs: 30_000 },
        () => undefined,
    );
    const segments: CutSegment[] = [];
    set.blobs.forEach((blob, index) =>
        segments.push(...cutter.push(blob, index * 5000)),
    );
    segments.push(...cutter.end(set.blobs.length * 5000));
    const [init, ...media] = segments;

    return {
        mime: set.mimeType,
        init: base64(init.bytes),
        media: media.map((segment) => ({
            base64: base64(segment.bytes),
            startMs: segment.startMs,
            durationMs: segment.durationMs,
        })),
    };
}

const CASES = [
    { set: 'chrome-vp8-kf', endMs: 60_004 },
    { set: 'chrome-vp9-kf', endMs: 59_989 },
    { set: 'chrome-vp8-nokf', endMs: 60_005 },
    { set: 'firefox-vp8', endMs: 60_006 },
    { set: 'webkit-mp4', endMs: 60_043 },
];

/** Forward, back, near the end and near the start, each mid-second as the playback gate seeks. */
const SEEKS = [30.5, 10.5, 55.5, 2.5];

for (const { set, endMs } of CASES) {
    test(`a local copy of ${set} has its duration and seeks to every frame asked for`, async ({
        page,
        browserName,
    }, testInfo) => {
        // On Linux the WebKit engine is WebKitGTK, which fails to play these WebM sets even
        // uncut. FITT_REVIEW_WEBKIT_ALL=1 runs them anyway (on a Mac, where WebKit is close to Safari).
        const owed =
            browserName === 'webkit' &&
            process.env.FITT_REVIEW_WEBKIT_ALL !== '1';
        test.fixme(
            owed &&
                ['chrome-vp8-kf', 'chrome-vp9-kf', 'chrome-vp8-nokf'].includes(
                    set,
                ),
            `webkit seeks a local copy of ${set} but fails to play it ("Could not demultiplex stream."), as it does the uncut recording: the owner decides, https://github.com/Psych-AI/fitt-video/pull/18#issuecomment-6818077890`,
        );
        test.fixme(
            owed && set === 'firefox-vp8',
            'webkit loads a local copy of firefox-vp8 only some of the time, as it does the uncut recording: the owner decides, https://github.com/Psych-AI/fitt-video/pull/18#issuecomment-6818187709',
        );
        if (browserName === 'webkit') {
            testInfo.annotations.push({
                type: 'engine',
                description:
                    process.platform === 'darwin'
                        ? 'WebKit on macOS, the engine Safari uses'
                        : 'WebKitGTK on Linux, not Safari',
            });
        }

        const fixture = cut(set);
        await openHarness(page);
        const support = await page.evaluate(
            (type) => document.createElement('video').canPlayType(type),
            fixture.mime,
        );
        test.skip(
            support === '',
            `${browserName} on this runner cannot play ${fixture.mime}`,
        );

        const result = await page.evaluate(
            (options) => window.internals.reviewFixture(options),
            { ...fixture, seeks: SEEKS },
        );

        expect(result.error).toBeNull();
        expect(result.src.startsWith('blob:')).toBe(true);
        expect(
            Math.abs(result.duration - endMs / 1000),
            `duration ${result.duration} against ${endMs / 1000}`,
        ).toBeLessThanOrEqual(0.15);
        expect(result.seeks.map((seek) => seek.at)).toEqual(SEEKS);

        for (const seek of result.seeks) {
            expect(
                Math.abs(seek.currentTime - seek.at),
                `landed at ${seek.currentTime} for ${seek.at}`,
            ).toBeLessThanOrEqual(0.25);
            expect(seek.luma, `a frame at ${seek.at}`).toBeGreaterThanOrEqual(
                30,
            );
        }

        expect(result.played).toBeGreaterThanOrEqual(0.3);
    });
}

const SHORT = {
    countdown_ms: 1000,
    min_duration_ms: 2000,
    max_duration_ms: 60_000,
    extension_ms: 0,
    warning_before_end_ms: 0,
};

test('with review, data-review follows the playback source, the recorded take seeks, and reset hides the review', async ({
    page,
    browserName,
}) => {
    test.skip(
        browserName === 'webkit',
        'Linux WebKit has no MediaRecorder (Plan 3 owner decision 2)',
    );
    await installMedia(page, browserName);
    await openHarness(page, '/tests/browser/harness/element.html');
    await page.evaluate(
        (recording) =>
            window.mount({
                recording,
                controls: 'full',
                review: true,
                slots: ['review'],
            }),
        SHORT,
    );
    const recorder = page.locator('fitt-recorder');
    await expect(recorder).toHaveAttribute('data-phase', 'ready');
    await expect(recorder).not.toHaveAttribute('data-review', /.*/);

    await recorder.locator('[part=record]').click();
    await expect(recorder).toHaveAttribute('data-phase', 'recording');
    await page.waitForTimeout(6000);
    await recorder.locator('[part=stop]').click();
    await expect(recorder).toHaveAttribute('data-review', 'local', {
        timeout: 15_000,
    });

    const shown = await recorder.evaluate((el) => {
        const root = el.shadowRoot!;
        const display = (selector: string) =>
            getComputedStyle(root.querySelector(selector)!).display;

        return {
            view: display('[part=view]'),
            review: display('[part=review]'),
            slot: display('.slot-review'),
            src: (root.querySelector('[part=review]') as HTMLVideoElement).src,
            controls: (root.querySelector('[part=review]') as HTMLVideoElement)
                .controls,
            record: display('[part=record]'),
            timer: display('[part=timer]'),
        };
    });
    // The stopped-phase record button and timer step aside for the browser's control bar.
    expect(shown.record).toBe('none');
    expect(shown.timer).toBe('none');
    const barHit = await recorder.evaluate((el) => {
        const root = el.shadowRoot!;
        const video = root.querySelector('[part=review]')!;
        const box = video.getBoundingClientRect();

        return (
            root.elementFromPoint(box.left + box.width / 2, box.bottom - 12) ===
            video
        );
    });
    expect(barHit).toBe(true);
    expect(shown.view).toBe('none');
    expect(shown.review).not.toBe('none');
    expect(shown.slot).not.toBe('none');
    expect(shown.src.startsWith('blob:')).toBe(true);
    expect(shown.controls).toBe(true);

    const sources = (await page.evaluate(() => window.__events))
        .filter((event) => event.type === 'fitt-state')
        .map((event) => event.detail.playback.source);
    expect(sources).toContain('preparing');
    expect(sources.at(-1)).toBe('local');

    const review = await recorder.evaluate(async (el) => {
        const video = el.shadowRoot!.querySelector(
            '[part=review]',
        ) as HTMLVideoElement;

        if (video.readyState < 1) {
            await new Promise((resolve) =>
                video.addEventListener('loadedmetadata', resolve, {
                    once: true,
                }),
            );
        }

        const duration = video.duration;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('seek timed out')),
                8000,
            );
            video.addEventListener(
                'seeked',
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
            video.currentTime = 2;
        });

        return { duration, currentTime: video.currentTime };
    });
    expect(Number.isFinite(review.duration)).toBe(true);
    expect(review.duration).toBeGreaterThan(4);
    expect(review.duration).toBeLessThan(9);
    expect(Math.abs(review.currentTime - 2)).toBeLessThanOrEqual(0.25);

    await page.evaluate(async () => {
        const element = document.querySelector(
            'fitt-recorder',
        ) as HTMLElement & {
            session: { reset(): Promise<void> };
        };
        await element.session.reset();
    });
    await expect(recorder).toHaveAttribute('data-phase', 'ready');
    await expect(recorder).not.toHaveAttribute('data-review', /.*/);
    expect(
        await recorder.evaluate((el) =>
            el.shadowRoot!.querySelector('[part=review]')!.getAttribute('src'),
        ),
    ).toBeNull();
});

for (const controls of ['full', 'none']) {
    test(`with review and no local copy, controls="${controls}" shows the preparing state as the board draws it`, async ({
        page,
        browserName,
    }) => {
        test.skip(
            browserName !== 'chromium',
            'the layout is the same in every engine; Chromium records fastest',
        );
        await installMedia(page, browserName);
        await openHarness(page, '/tests/browser/harness/element.html');
        await page.evaluate(
            async (options) => {
                const base = await (
                    await fetch('/tests/fixtures/descriptor-answer.json')
                ).json();
                window.mount({
                    recording: options.recording,
                    playback: { local: false, in_status: true },
                    // Status playback is on and the server file is not ready yet.
                    statusBody: {
                        session: {
                            id: base.session_id,
                            status: 'finalising',
                            take: 1,
                            end_ms: null,
                        },
                        tracks: [],
                        checks: {
                            status: 'pending',
                            verdict: null,
                            take: 1,
                            reasons: [],
                        },
                        upload: { bytes_received: 0 },
                        playback: {},
                    },
                    controls: options.controls,
                    review: true,
                    slots: ['review'],
                });
            },
            { recording: SHORT, controls },
        );
        const recorder = page.locator('fitt-recorder');
        await expect(recorder).toHaveAttribute('data-phase', 'ready');

        type Driven = HTMLElement & {
            session: { start(): Promise<void>; stop(): Promise<void> };
        };
        await page.evaluate(() =>
            (document.querySelector('fitt-recorder') as Driven).session.start(),
        );
        await expect(recorder).toHaveAttribute('data-phase', 'recording', {
            timeout: 10_000,
        });
        await page.waitForTimeout(3000);
        await page.evaluate(() =>
            (document.querySelector('fitt-recorder') as Driven).session.stop(),
        );
        await expect(recorder).toHaveAttribute('data-phase', 'stopped', {
            timeout: 15_000,
        });

        // With controls="none" the element binds no player, so the source stays where the session left it.
        await expect(recorder).toHaveAttribute(
            'data-review',
            controls === 'none' ? 'none' : 'preparing',
        );

        const shown = await recorder.evaluate((el) => {
            const root = el.shadowRoot!;
            const display = (selector: string) =>
                getComputedStyle(root.querySelector(selector)!).display;

            return {
                view: display('[part=view]'),
                review: display('[part=review]'),
                skeleton: display('.review-skeleton'),
                slot: display('.slot-review'),
                src: root.querySelector('[part=review]')!.getAttribute('src'),
            };
        });
        expect(shown.review).toBe('none');
        expect(shown.slot).not.toBe('none');
        expect(shown.src).toBeNull();
        expect(shown.view).toBe(controls === 'none' ? 'block' : 'none');
        expect(shown.skeleton).toBe(controls === 'none' ? 'none' : 'block');
    });
}

for (const leave of ['swap the session', 'remove the review attribute']) {
    test(`after review ends (${leave}), the earlier player never reaches the element's review video`, async ({
        page,
        browserName,
    }) => {
        test.skip(
            browserName !== 'chromium',
            'the element logic is the same in every engine; Chromium records fastest',
        );
        await installMedia(page, browserName);
        await openHarness(page, '/tests/browser/harness/element.html');
        const waiting = await page.evaluate(async () => {
            const base = await (
                await fetch('/tests/fixtures/descriptor-answer.json')
            ).json();

            return {
                session: {
                    id: base.session_id,
                    status: 'finalising',
                    take: 1,
                    end_ms: null,
                },
                tracks: [],
                checks: {
                    status: 'pending',
                    verdict: null,
                    take: 1,
                    reasons: [],
                },
                upload: { bytes_received: 0 },
                playback: {},
            };
        });
        await page.evaluate(
            (options) =>
                window.mount({
                    recording: options.recording,
                    playback: { local: false, in_status: true },
                    // Status playback is on and the server file is not ready yet.
                    statusBody: options.waiting,
                    controls: 'full',
                    review: true,
                    slots: ['review'],
                }),
            { recording: SHORT, waiting },
        );
        const recorder = page.locator('fitt-recorder');
        await expect(recorder).toHaveAttribute('data-phase', 'ready');

        type Driven = HTMLElement & {
            session: {
                start(): Promise<void>;
                stop(): Promise<void>;
                state: { playback: { source: string } };
            };
        };
        await page.evaluate(() =>
            (document.querySelector('fitt-recorder') as Driven).session.start(),
        );
        await expect(recorder).toHaveAttribute('data-phase', 'recording', {
            timeout: 10_000,
        });
        await page.waitForTimeout(3000);
        await page.evaluate(() =>
            (document.querySelector('fitt-recorder') as Driven).session.stop(),
        );
        await expect(recorder).toHaveAttribute('data-review', 'preparing', {
            timeout: 15_000,
        });

        await page.evaluate((how) => {
            const element = document.querySelector('fitt-recorder') as Driven;
            (window as unknown as { __earlier: unknown }).__earlier =
                element.session;

            if (how === 'swap the session') {
                (element as unknown as { session: unknown }).session =
                    window.otherSession();
            } else {
                element.removeAttribute('review');
            }
        }, leave);
        await expect(recorder).not.toHaveAttribute('data-review', /.*/);

        // The earlier session's server file is ready now: its player switches to it.
        await page.evaluate((body) => {
            window.__statusOverride = {
                ...body,
                session: { ...body.session, status: 'ready' },
                playback: {
                    camera: { url: '/tests/fixtures/earlier-take.webm' },
                },
            };
        }, waiting);
        await expect
            .poll(
                () =>
                    page.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __earlier: Driven['session'];
                                }
                            ).__earlier.state.playback.source,
                    ),
                { timeout: 10_000 },
            )
            .toBe('server');

        const src = await recorder.evaluate((el) =>
            el.shadowRoot!.querySelector('[part=review]')!.getAttribute('src'),
        );
        expect(src).toBeNull();
        expect(
            await recorder.evaluate(
                (el) => el.shadowRoot!.querySelectorAll('[part=review]').length,
            ),
        ).toBe(1);
    });
}

test('switching controls to none during a review unbinds the element player, so the host binds the only one', async ({
    page,
    browserName,
}) => {
    test.skip(
        browserName !== 'chromium',
        'the element logic is the same in every engine; Chromium records fastest',
    );
    await installMedia(page, browserName);
    await openHarness(page, '/tests/browser/harness/element.html');
    await page.evaluate(
        (recording) =>
            window.mount({
                recording,
                controls: 'full',
                review: true,
                slots: ['review'],
            }),
        SHORT,
    );
    const recorder = page.locator('fitt-recorder');
    await expect(recorder).toHaveAttribute('data-phase', 'ready');
    await recorder.locator('[part=record]').click();
    await expect(recorder).toHaveAttribute('data-phase', 'recording');
    await page.waitForTimeout(3000);
    await recorder.locator('[part=stop]').click();
    await expect(recorder).toHaveAttribute('data-review', 'local', {
        timeout: 15_000,
    });
    expect(
        await recorder.evaluate((el) =>
            el
                .shadowRoot!.querySelector('[part=review]')!
                .getAttribute('src')
                ?.startsWith('blob:'),
        ),
    ).toBe(true);

    await recorder.evaluate((el) => el.setAttribute('controls', 'none'));

    expect(
        await recorder.evaluate((el) => {
            const videos = el.shadowRoot!.querySelectorAll('[part=review]');

            return {
                count: videos.length,
                src: videos[0].getAttribute('src'),
                display: getComputedStyle(
                    el.shadowRoot!.querySelector('[part=view]')!,
                ).display,
            };
        }),
    ).toEqual({ count: 1, src: null, display: 'block' });
});
