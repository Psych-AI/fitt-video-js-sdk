import { expect, test } from '@playwright/test';
import { firstVideoBlockIsKey } from '../support/ebml-inspect.ts';
import {
    assertsUnsupported,
    measured,
    openHarness,
    skipWithoutRecorder,
} from './support/measure.ts';
import { installMedia } from './support/media.ts';

const bytes = (base64: string): Uint8Array =>
    new Uint8Array(Buffer.from(base64, 'base64'));

test('a 12 s take cuts keyframe-aligned segments', async ({
    page,
    browserName,
}, testInfo) => {
    await installMedia(page, browserName);
    const errors = await openHarness(page);

    if (await assertsUnsupported(page)) {
        // Owner decision 2: Linux WebKit has no MediaRecorder, so the take is refused and records nothing.
        expect(browserName).toBe('webkit');
        await page.click('#gesture');
        const refused = await page.evaluate(() =>
            window.internals.recordTake({ recipe: 'answer', seconds: 12 }),
        );

        expect(errors).toEqual([]);
        expect(refused.errors).toEqual(['recorder_unsupported']);
        expect(refused.runs).toEqual([]);
        expect(refused.segments).toEqual([]);
        expect(refused.events).toContain('device.permission_granted');

        return;
    }

    await skipWithoutRecorder(page);
    await page.click('#gesture');
    const take = await page.evaluate(() =>
        window.internals.recordTake({ recipe: 'answer', seconds: 12 }),
    );
    const run = take.runs.find((r) => r.track === 'camera')!;

    testInfo.annotations.push({
        type: 'run',
        description: JSON.stringify({
            mime: run.mime_type,
            segmenting: run.segmenting,
            honoured: run.keyframe_option_honoured,
            durations: take.segments.map((s) => s.duration_ms),
        }),
    });
    expect(errors).toEqual([]);
    expect(take.events).toContain('device.permission_granted');

    if (measured(testInfo, browserName)) {
        expect(['moof', 'blob', 'cluster']).toContain(run.segmenting);

        return;
    }

    const camera = take.segments.filter((s) => s.run_id === run.run_id);
    const init = bytes(camera[0].base64);
    const media = camera.slice(1);
    expect(run.segmenting).toBe('cluster');

    for (const segment of media) {
        expect(firstVideoBlockIsKey(init, bytes(segment.base64))).toBe(true);
    }

    if (browserName === 'chromium') {
        expect(run.mime_type).toBe('video/webm;codecs=vp8,opus');
        expect(media.length).toBeGreaterThanOrEqual(3);

        for (const segment of media.slice(0, -1)) {
            expect(segment.duration_ms).toBeGreaterThanOrEqual(4750);
            expect(segment.duration_ms).toBeLessThanOrEqual(5250);
        }

        expect(take.recorderOptions).toContainEqual({
            mimeType: 'video/webm;codecs=vp8,opus',
            videoBitsPerSecond: 300_000,
            audioBitsPerSecond: 32_000,
            videoKeyFrameIntervalDuration: 5000,
        });
        expect(take.recorderOptions).toContainEqual({
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 32_000,
        });
    }
});

test('stop ends every track', async ({ page, browserName }) => {
    await installMedia(page, browserName);
    await openHarness(page);

    // Owner decision 2: where there is no MediaRecorder the take is refused, and stopTake() must still release capture.
    if (!(await assertsUnsupported(page))) {
        await skipWithoutRecorder(page);
    }

    await page.click('#gesture');

    const states = await page.evaluate(() => window.internals.releaseCheck());

    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(new Set(states)).toEqual(new Set(['ended']));
});

test('a camera switch mid-take ends the run and starts another, each with its own seq 0', async ({
    page,
    browserName,
}, testInfo) => {
    test.skip(measured(testInfo, browserName), 'recorded in the first test');
    await installMedia(page, browserName, { prefer: 'synthetic' });
    await openHarness(page);
    await skipWithoutRecorder(page);
    await page.click('#gesture');
    const take = await page.evaluate(() =>
        window.internals.recordTake({
            recipe: 'monitor',
            seconds: 10,
            switchCameraAt: 6000,
        }),
    );

    expect(take.runs.map((r) => r.ended_reason)).toEqual([
        'device_switch',
        'stop',
    ]);
    expect(new Set(take.runs.map((r) => r.run_id)).size).toBe(2);

    for (const run of take.runs) {
        expect(
            take.segments.filter(
                (s) =>
                    s.run_id === run.run_id && s.seq === 0 && s.kind === 'init',
            ),
        ).toHaveLength(1);
    }
});

test('an ended track is device_disconnected, and the device coming back starts a new run', async ({
    page,
    browserName,
}, testInfo) => {
    test.skip(measured(testInfo, browserName), 'recorded in the first test');
    await installMedia(page, browserName, { prefer: 'synthetic' });
    await openHarness(page);
    await skipWithoutRecorder(page);
    await page.click('#gesture');
    const take = await page.evaluate(() =>
        window.internals.recordTake({
            recipe: 'monitor',
            seconds: 10,
            endTrackAt: 4000,
            deviceBackAt: 6000,
        }),
    );

    expect(take.errors).toEqual(['device_disconnected', null]);
    expect(take.runs).toHaveLength(2);
});
