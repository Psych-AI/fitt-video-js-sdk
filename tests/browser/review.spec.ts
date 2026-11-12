import { expect, test } from '@playwright/test';
import { createCutter } from '../../src/cut/select.ts';
import type { CutSegment } from '../../src/cut/types.ts';
import { readSet } from '../support/fixtures.ts';
import { openHarness } from './support/measure.ts';

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
        test.fixme(
            browserName === 'webkit' && set === 'chrome-vp8-kf',
            'webkit does not seek a local copy of chrome-vp8-kf: the owner decides, https://github.com/Psych-AI/fitt-video/pull/18#issuecomment-6818077890',
        );
        test.fixme(
            browserName === 'webkit' && set === 'chrome-vp9-kf',
            'webkit does not seek a local copy of chrome-vp9-kf: the owner decides, https://github.com/Psych-AI/fitt-video/pull/18#issuecomment-6818077890',
        );
        test.fixme(
            browserName === 'webkit' && set === 'chrome-vp8-nokf',
            'webkit does not seek a local copy of chrome-vp8-nokf: the owner decides, https://github.com/Psych-AI/fitt-video/pull/18#issuecomment-6818077890',
        );
        test.fixme(
            browserName === 'webkit' && set === 'firefox-vp8',
            'webkit does not seek a local copy of firefox-vp8: the owner decides, https://github.com/Psych-AI/fitt-video/pull/18#issuecomment-6818187709',
        );
        if (browserName === 'webkit') {
            testInfo.annotations.push({
                type: 'engine',
                description: 'WebKitGTK on Linux, not Safari',
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
