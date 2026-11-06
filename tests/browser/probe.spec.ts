import { expect, test } from '@playwright/test';
import { audioMeasured, measured, openHarness } from './support/measure.ts';
import { installMedia } from './support/media.ts';

const CAMERA = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm',
];
const AUDIO = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm',
];

test('the engine can capture and record, and says which types it supports', async ({
    page,
    browserName,
}, testInfo) => {
    const source = await installMedia(page, browserName);
    await openHarness(page);
    await page.click('#gesture');

    const probe = await page.evaluate(
        async ({ camera, audio }) => {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            });
            const supported = Object.fromEntries(
                [...camera, ...audio].map((type) => [
                    type,
                    typeof MediaRecorder !== 'undefined' &&
                        MediaRecorder.isTypeSupported(type),
                ]),
            );
            const chosen = camera.find((type) => supported[type]) ?? '';
            const sizes: number[] = [];
            let recorderError: string | undefined;

            if (typeof MediaRecorder !== 'undefined') {
                try {
                    const recorder = new MediaRecorder(
                        stream,
                        chosen === '' ? {} : { mimeType: chosen },
                    );
                    recorder.addEventListener('dataavailable', (event) =>
                        sizes.push(event.data.size),
                    );
                    recorder.start(1000);
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                    recorder.stop();
                    await new Promise((resolve) =>
                        recorder.addEventListener('stop', resolve, {
                            once: true,
                        }),
                    );
                } catch (error) {
                    recorderError = (error as Error).name; // Linux WebKit may refuse the stream: recorded, not failed
                }
            }

            return {
                secure: isSecureContext,
                recorder: typeof MediaRecorder !== 'undefined',
                video: stream.getVideoTracks().length,
                audio: stream.getAudioTracks().length,
                supported,
                chosen,
                sizes,
                recorderError,
            };
        },
        { camera: CAMERA, audio: AUDIO },
    );

    const context = await page.evaluate(() => {
        const created = new AudioContext();
        return new Promise<string>((resolve) =>
            setTimeout(() => resolve(created.state), 200),
        );
    });

    testInfo.annotations.push({
        type: 'probe',
        description: JSON.stringify({ source, ...probe, context }),
    });

    expect(probe.secure).toBe(true);
    expect([probe.video, probe.audio]).toEqual([1, 1]);

    // Owner decision 1: Firefox has no audio device here, so its context is measured.
    if (audioMeasured(testInfo, browserName, context)) {
        expect(['running', 'suspended']).toContain(context);
    } else {
        expect(context).toBe('running');
    }

    // Owner decision 2: Linux WebKit has no MediaRecorder, so what it supports is measured.
    if (measured(testInfo, browserName)) {
        return;
    }

    expect(probe.recorderError).toBeUndefined();
    expect(probe.chosen).toBe('video/webm;codecs=vp8,opus');
    expect(
        probe.sizes.filter((size) => size > 0).length,
    ).toBeGreaterThanOrEqual(1);
});

test('the synthetic stream answers getUserMedia in every engine, Firefox without waiting on audio', async ({
    page,
    browserName,
}) => {
    const source = await installMedia(page, browserName, {
        prefer: 'synthetic',
    });
    await openHarness(page);
    await page.click('#gesture');

    const result = await page.evaluate(async () => {
        const first = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
        });
        const second = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: 'fake-camera-2' } },
        });
        first.getTracks().forEach((track) => track.stop());

        let refused = '';

        try {
            await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: 'no-such-camera' } },
            });
        } catch (error) {
            refused = (error as Error).name;
        }

        window.__dateOffset = 60_000;
        const offset =
            Date.now() - (performance.timeOrigin + performance.now());
        const devices = await navigator.mediaDevices.enumerateDevices();

        return {
            first: [
                first.getVideoTracks().length,
                first.getAudioTracks().length,
            ],
            second: [
                second.getVideoTracks().length,
                second.getAudioTracks().length,
            ],
            secondLive: second.getVideoTracks()[0].readyState,
            devices: devices.map((device) => device.deviceId),
            refused,
            offset,
        };
    });

    expect(source).toBe('synthetic');
    expect(result.first).toEqual([1, 1]);
    expect(result.second).toEqual([1, 0]);
    expect(result.secondLive).toBe('live');
    expect(result.devices).toEqual([
        'fake-camera-1',
        'fake-camera-2',
        'fake-mic-1',
    ]);
    expect(result.refused).toBe('OverconstrainedError');
    expect(Math.abs(result.offset - 60_000)).toBeLessThan(1_000);
});
