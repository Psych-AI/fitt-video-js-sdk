import { expect, test } from '@playwright/test';
import { audioChannels } from '../support/ebml-inspect.ts';
import {
    assertsUnsupported,
    audioMeasured,
    measured,
    openHarness,
    skipWithoutRecorder,
} from './support/measure.ts';
import { installMedia } from './support/media.ts';

const bytes = (base64: string): Uint8Array =>
    new Uint8Array(Buffer.from(base64, 'base64'));

test('started by a click, without the autoplay flag, the meter reads the tone and gain 0 is no_audio within 5 to 6.5 s', async ({
    page,
    browserName,
}, testInfo) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    const errors = await openHarness(page);
    await page.click('#gesture');
    const probe = await page.evaluate(() => window.internals.audioProbe());
    testInfo.annotations.push({
        type: 'audio',
        description: JSON.stringify(probe),
    });

    expect(errors).toEqual([]);

    if (audioMeasured(testInfo, browserName, probe.context)) {
        // Owner decision 1: Firefox has no audio device here, so its context stays suspended and no level is passed on.
        expect(['running', 'suspended']).toContain(probe.context);
        // Closing needs no running context, so the release still closes it.
        expect(probe.contextAfterClose).toBe('closed');

        return;
    }

    // Owner decision 1: WebKit asserts the meter and the dead microphone like Chromium (this spec does not record).
    expect(probe.context).toBe('running');
    expect(probe.level).toBeGreaterThan(0.01);
    expect(probe.noAudioAfterMs).toBeGreaterThanOrEqual(5000);
    expect(probe.noAudioAfterMs).toBeLessThanOrEqual(6500);
    expect(probe.contextAfterClose).toBe('closed');
});

test('a conversation take records a stereo camera track, a mono audio track, and a dead microphone under a loud interviewer', async ({
    page,
    browserName,
}, testInfo) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    const errors = await openHarness(page);
    const unsupported = await assertsUnsupported(page);

    if (!unsupported) {
        await skipWithoutRecorder(page);
    }

    await page.click('#gesture');
    const take = await page.evaluate(() =>
        window.internals.mixedTake({ seconds: 7, micGain: 0 }),
    );
    testInfo.annotations.push({
        type: 'mix',
        description: JSON.stringify({
            events: take.events,
            errors: take.errors,
            context: take.context,
            contextState: take.contextState,
            leftRms: take.leftRms,
            rightRms: take.rightRms,
            audioTrackRms: take.audioTrackRms,
            cameraChannels:
                take.cameraInit === null
                    ? null
                    : audioChannels(bytes(take.cameraInit)),
            audioChannels:
                take.audioInit === null
                    ? null
                    : audioChannels(bytes(take.audioInit)),
        }),
    });

    expect(errors).toEqual([]);

    if (unsupported) {
        // Owner decision 2: Linux WebKit has no MediaRecorder, so the take is refused and records nothing.
        expect(browserName).toBe('webkit');
        expect(take.errors).toEqual(['recorder_unsupported']);
        expect(take.cameraInit).toBeNull();
        expect(take.audioInit).toBeNull();
        expect(take.contextState).toBe('closed');
        // The graph needs no recorder: the dead microphone and the D20 mix hold on WebKit too.
        expect(take.events).toContain('device.no_audio');
        expect(take.leftRms).toBeLessThan(0.01);
        expect(take.rightRms).toBeGreaterThan(0.01);

        return;
    }

    if (audioMeasured(testInfo, browserName, take.context)) {
        // Owner decision 1: the stereo camera track, device.no_audio and the three levels need a running AudioContext.
        expect(['running', 'suspended']).toContain(take.context);
        // Firefox still records from its native fake devices: both inits and the mono audio track stand.
        expect(take.cameraInit).not.toBeNull();
        expect(take.audioInit).not.toBeNull();
        expect(audioChannels(bytes(take.audioInit!))).toBe(1);
        expect(take.contextState).toBe('closed');

        return;
    }

    if (measured(testInfo, browserName)) {
        return;
    }

    expect(take.cameraInit).not.toBeNull();
    expect(take.audioInit).not.toBeNull();
    expect(audioChannels(bytes(take.cameraInit!))).toBe(2);
    expect(audioChannels(bytes(take.audioInit!))).toBe(1);
    expect(take.events).toContain('device.no_audio');
    expect(take.contextState).toBe('closed');
    // D20: the microphone (gain 0 here) on the left, the interviewer on the right, and the audio track stays microphone only.
    expect(take.leftRms).toBeLessThan(0.01);
    expect(take.rightRms).toBeGreaterThan(0.01);
    expect(take.audioTrackRms).toBeLessThan(0.01);
});

test('an interviewer media element mixed into a take, a stop and a second take reaches the right channel both times', async ({
    page,
    browserName,
}, testInfo) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    const errors = await openHarness(page);
    await page.click('#gesture');
    const result = await page.evaluate(() =>
        window.internals.elementMixTwice(),
    );
    testInfo.annotations.push({
        type: 'element-mix',
        description: JSON.stringify(result),
    });

    // createMediaElementSource() binds an element once for good: the second mix() must neither throw nor warn.
    expect(errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.contexts).toHaveLength(2);

    if (audioMeasured(testInfo, browserName, result.contexts[0])) {
        // Owner decision 1: the levels need a running AudioContext.
        expect(['running', 'suspended']).toContain(result.contexts[1]);

        return;
    }

    expect(result.contexts).toEqual(['running', 'running']);
    expect(result.rightRms[0]).toBeGreaterThan(0.01);
    expect(result.rightRms[1]).toBeGreaterThan(0.01);
    // The element still plays after both graphs closed, so the candidate keeps hearing the interviewer.
    expect(result.elementPlaying).toBe(true);
});

test('an audio-only conversation records the D20 mix on its one audio track', async ({
    page,
    browserName,
}, testInfo) => {
    await installMedia(page, browserName, { prefer: 'synthetic' });
    const errors = await openHarness(page);
    const unsupported = await assertsUnsupported(page);

    if (!unsupported) {
        await skipWithoutRecorder(page);
    }

    await page.click('#gesture');
    const take = await page.evaluate(() =>
        window.internals.mixedTake({ seconds: 7, micGain: 0, audioOnly: true }),
    );
    testInfo.annotations.push({
        type: 'mix',
        description: JSON.stringify({
            events: take.events,
            errors: take.errors,
            context: take.context,
            contextState: take.contextState,
            leftRms: take.leftRms,
            rightRms: take.rightRms,
            audioTrackRms: take.audioTrackRms,
            audioChannels:
                take.audioInit === null
                    ? null
                    : audioChannels(bytes(take.audioInit)),
        }),
    });

    expect(errors).toEqual([]);

    if (unsupported) {
        // Owner decision 2: Linux WebKit has no MediaRecorder, so the take is refused and records nothing.
        expect(browserName).toBe('webkit');
        expect(take.errors).toEqual(['recorder_unsupported']);
        expect(take.cameraInit).toBeNull();
        expect(take.audioInit).toBeNull();
        expect(take.contextState).toBe('closed');
        // The graph needs no recorder: the dead microphone and the D20 mix hold on WebKit too.
        expect(take.events).toContain('device.no_audio');
        expect(take.leftRms).toBeLessThan(0.01);
        expect(take.rightRms).toBeGreaterThan(0.01);

        return;
    }

    if (audioMeasured(testInfo, browserName, take.context)) {
        // Owner decision 1: a suspended context records the microphone as is.
        expect(take.cameraInit).toBeNull();
        expect(take.audioInit).not.toBeNull();

        return;
    }

    if (measured(testInfo, browserName)) {
        return;
    }

    expect(take.cameraInit).toBeNull();
    expect(audioChannels(bytes(take.audioInit!))).toBe(2);
    expect(take.events).toContain('device.no_audio');
    // D20: the microphone (gain 0 here) on the left, the interviewer on the right.
    expect(take.leftRms).toBeLessThan(0.01);
    expect(take.rightRms).toBeGreaterThan(0.01);
});
