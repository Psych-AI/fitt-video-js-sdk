import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import {
    assertsUnsupported,
    openHarness,
    skipWithoutRecorder,
} from '../browser/support/measure.ts';
import { installMedia } from '../browser/support/media.ts';
import { DIRECT_API, MINIO } from './env.ts';
import { createSession } from './support.ts';

async function directStatus(
    request: APIRequestContext,
    descriptor: { session_id: string; token: { id: string; secret: string } },
) {
    const response = await request.get(
        `${DIRECT_API}/sessions/${descriptor.session_id}/status`,
        {
            headers: {
                Authorization: `Bearer fvt_${descriptor.token.id}.${descriptor.token.secret}`,
                Origin: 'http://127.0.0.1:8124',
                Accept: 'application/json',
            },
        },
    );

    return response.json();
}

async function recordFor(page: Page, seconds: number): Promise<void> {
    await page.evaluate(() => window.internals.e2e.prepare());
    await page.click('#gesture');
    await page.evaluate(() => window.internals.e2e.start());
    await page.waitForTimeout(seconds * 1000);
}

async function takeAndSeal(
    page: Page,
    request: APIRequestContext,
    browserName: string,
) {
    const { descriptor } = await createSession(
        request,
        {},
        process.env.FITT_CONTRACT_KEY,
        DIRECT_API,
    );
    expect(descriptor.tracks.map((track) => track.upload.mode)).toEqual([
        's3',
        's3',
    ]);
    await installMedia(page, browserName);
    const errors = await openHarness(page);
    test.skip(
        await assertsUnsupported(page),
        'Linux WebKit has no MediaRecorder (owner decision 2)',
    );
    await skipWithoutRecorder(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await recordFor(page, 12);
    await page.evaluate(() => window.internals.e2e.stop());
    const local = await page.evaluate(() => window.internals.e2e.local());

    await expect
        .poll(
            async () =>
                (await directStatus(request, descriptor)).tracks.map(
                    (track: { sealed: boolean }) => track.sealed,
                ),
            { timeout: 30_000 },
        )
        .toEqual([true, true]);

    for (const track of (await directStatus(request, descriptor)).tracks) {
        expect(track.segments).toEqual({
            expected: 0,
            present: local.counts[track.track as 'camera' | 'audio'],
            missing: 0,
            abandoned: 0,
        });
    }

    // The confirm or PUT that seals a track runs the stitch in its own request (the sync queue), so the
    // status reads sealed before that answer is back. Wait for every API call to answer before reading the log.
    await expect
        .poll(
            async () =>
                (
                    await page.evaluate(() => window.internals.e2e.calls())
                ).filter(
                    (call) =>
                        call.url.startsWith(DIRECT_API) && call.status === 0,
                ).length,
            { timeout: 60_000 },
        )
        .toBe(0);

    return {
        errors,
        calls: await page.evaluate(() => window.internals.e2e.calls()),
        events: await page.evaluate(() => window.internals.e2e.events()),
    };
}

test('an answer take uploads straight to the bucket and seals with nothing missing', async ({
    page,
    request,
    browserName,
}) => {
    const { errors, calls, events } = await takeAndSeal(
        page,
        request,
        browserName,
    );

    expect(
        calls.some(
            (call) =>
                call.method === 'PUT' &&
                call.url.startsWith(`${MINIO}/fitt-video-contract/videos/`),
        ),
    ).toBe(true);
    expect(
        calls
            .filter((call) => call.url.endsWith('/confirm'))
            .every((call) => call.status === 201 || call.status === 200),
    ).toBe(true);
    expect(
        calls.some(
            (call) => call.method === 'PUT' && call.url.includes('/api/v1/'),
        ),
    ).toBe(false);
    expect(events).not.toContain('upload.transport_fallback');
    expect(errors).toEqual([]);
});

test('a blocked bucket steps down to the passthrough PUT and still lands every segment', async ({
    page,
    request,
    browserName,
}) => {
    await page.route(`${MINIO}/**`, (route) => route.abort('failed'));
    const { errors, calls, events } = await takeAndSeal(
        page,
        request,
        browserName,
    );

    expect(events).toContain('upload.transport_fallback');
    expect(
        calls.some(
            (call) =>
                call.method === 'PUT' && call.url.includes('/api/v1/sessions/'),
        ),
    ).toBe(true);
    expect(errors).toEqual([]);
});
