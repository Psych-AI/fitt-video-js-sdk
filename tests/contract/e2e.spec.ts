import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from '@playwright/test';
import {
    assertsUnsupported,
    measured,
    openHarness,
    skipWithoutRecorder,
} from '../browser/support/measure.ts';
import { installMedia } from '../browser/support/media.ts';
import { API, createSession } from './support.ts';

async function status(
    request: APIRequestContext,
    descriptor: { session_id: string; token: { id: string; secret: string } },
    origin = 'http://127.0.0.1:8124',
) {
    const response = await request.get(
        `${API}/sessions/${descriptor.session_id}/status`,
        {
            headers: {
                Authorization: `Bearer fvt_${descriptor.token.id}.${descriptor.token.secret}`,
                Origin: origin,
                Accept: 'application/json',
            },
        },
    );

    return response.json();
}

async function record(page: Page, seconds: number): Promise<void> {
    await page.evaluate(() => window.internals.e2e.prepare());
    await page.click('#gesture');
    await page.evaluate(() => window.internals.e2e.start());
    await page.waitForTimeout(seconds * 1000);
}

test('a 12 s answer take uploads, seals both tracks and finalises', async ({
    page,
    request,
    browserName,
}, testInfo) => {
    const { descriptor } = await createSession(request);
    await installMedia(page, browserName);
    const errors = await openHarness(page);

    if (await assertsUnsupported(page)) {
        // Owner decision 2: Linux WebKit has no MediaRecorder, so the take is refused and nothing is stored or sent.
        expect(browserName).toBe('webkit');
        await page.evaluate(
            (d) => window.internals.e2e.open(d, {}),
            descriptor,
        );
        await page.evaluate(() => window.internals.e2e.prepare());
        await page.click('#gesture');
        const refused = await page.evaluate(() =>
            window.internals.e2e.start().then(
                () => null,
                (error: { code?: string }) => error.code ?? String(error),
            ),
        );

        expect(refused).toBe('recorder_unsupported');
        expect(
            (await page.evaluate(() => window.internals.e2e.state())).error
                ?.code,
        ).toBe('recorder_unsupported');
        expect(
            (await page.evaluate(() => window.internals.e2e.local())).runs,
        ).toEqual([]);
        expect(
            (await status(request, descriptor)).tracks.map(
                (t: { segments: { present: number } }) => t.segments.present,
            ),
        ).toEqual([0, 0]);
        expect(errors).toEqual([]);

        return;
    }

    await skipWithoutRecorder(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 12); // start() resolves after the countdown, so this is 12 s of recording
    await page.evaluate(() => window.internals.e2e.stop());
    const local = await page.evaluate(() => window.internals.e2e.local());
    testInfo.annotations.push({
        type: 'local',
        description: JSON.stringify(local.runs),
    });

    if (measured(testInfo, browserName)) {
        expect(errors).toEqual([]);

        return;
    }

    await expect
        .poll(
            async () =>
                (await status(request, descriptor)).tracks.map(
                    (t: { sealed: boolean }) => t.sealed,
                ),
            { timeout: 30_000 },
        )
        .toEqual([true, true]);
    const tracks = (await status(request, descriptor)).tracks;

    for (const track of tracks) {
        expect(track.segments).toEqual({
            expected: 0,
            present: local.counts[track.track as 'camera' | 'audio'],
            missing: 0,
            abandoned: 0,
        });
    }

    await page.evaluate(() => window.internals.e2e.finalise());
    expect(
        (await page.evaluate(() => window.internals.e2e.state())).upload
            .sessionFinalised,
    ).toBe(true);
    expect(await page.evaluate(() => window.internals.e2e.events())).toContain(
        'session.environment',
    );
    expect(errors).toEqual([]);
});

test('offline for 10 s sends no segment while offline, and everything lands after', async ({
    page,
    request,
    browserName,
}, testInfo) => {
    test.skip(measured(testInfo, browserName), 'media in chromium and firefox');
    const { descriptor } = await createSession(request, { recipe: 'monitor' });
    await installMedia(page, browserName);
    await openHarness(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 4);
    await page.context().setOffline(true);
    await page.waitForTimeout(10_000);
    await page.context().setOffline(false);
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.internals.e2e.stop());
    const calls = await page.evaluate(() => window.internals.e2e.calls());
    const local = await page.evaluate(() => window.internals.e2e.local());

    expect(
        calls.filter((c) => !c.online && /\/segments\//.test(c.url)),
    ).toEqual([]);
    expect(await page.evaluate(() => window.internals.e2e.events())).toContain(
        'net.offline',
    );
    await expect
        .poll(
            async () =>
                (await status(request, descriptor)).tracks[0].segments.present,
            { timeout: 30_000 },
        )
        .toBe(local.counts.camera);
});

test('a host re-mint mid-take makes finalise wait for the new descriptor, then succeed', async ({
    page,
    request,
    browserName,
}, testInfo) => {
    test.skip(measured(testInfo, browserName), 'media in chromium and firefox');
    const { descriptor } = await createSession(request, { recipe: 'monitor' });
    await installMedia(page, browserName);
    await openHarness(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 4);
    await page.evaluate(() => window.internals.e2e.stop());
    const remint = await request.post(
        `${API}/sessions/${descriptor.session_id}/upload-token`,
        {
            headers: {
                Authorization: `Bearer ${process.env.FITT_CONTRACT_KEY}`,
                Accept: 'application/json',
            },
        },
    );
    const renewed = (await remint.json()).descriptor;
    await page.evaluate(() => {
        void window.internals.e2e.finalise();
    });

    await expect
        .poll(
            async () =>
                (await page.evaluate(() => window.internals.e2e.state())).error
                    ?.code,
        )
        .toBe('token_expired');
    await page.evaluate((d) => window.internals.e2e.setDescriptor(d), renewed);
    await expect
        .poll(
            async () =>
                (await page.evaluate(() => window.internals.e2e.state())).upload
                    .sessionFinalised,
        )
        .toBe(true);
    expect(
        (await page.evaluate(() => window.internals.e2e.calls()))
            .filter((c) => c.url.endsWith('/finalise'))
            .map((c) => c.status),
    ).toEqual([401, 200]);
});

test('a 10 s jump of Date.now raises session.clock_jump and starts a new run', async ({
    page,
    request,
    browserName,
}, testInfo) => {
    test.skip(measured(testInfo, browserName), 'media in chromium and firefox');
    const { descriptor } = await createSession(request, { recipe: 'monitor' });
    await installMedia(page, browserName, { prefer: 'synthetic' });
    await openHarness(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 3);
    await page.evaluate(() => {
        window.__dateOffset = 10_000;
    });
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.internals.e2e.stop());

    expect(await page.evaluate(() => window.internals.e2e.events())).toContain(
        'session.clock_jump',
    );
    expect(
        (await page.evaluate(() => window.internals.e2e.local())).runs.map(
            (r) => r.ended_reason,
        ),
    ).toEqual(['clock_jump', 'stop']);
});

test('a page whose origin the space does not allow ends in network_blocked with nothing stored', async ({
    page,
    request,
    browserName,
}, testInfo) => {
    test.skip(measured(testInfo, browserName), 'media in chromium and firefox');
    const { descriptor } = await createSession(
        request,
        { recipe: 'monitor' },
        process.env.FITT_CONTRACT_KEY_OTHER,
    );
    await installMedia(page, browserName);
    await openHarness(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 8);

    await expect
        .poll(
            async () =>
                (await page.evaluate(() => window.internals.e2e.state())).error
                    ?.code,
            { timeout: 30_000 },
        )
        .toBe('network_blocked');
    // Read from Node with the origin that space allows: the server stored nothing.
    expect(
        (await status(request, descriptor, 'http://127.0.0.1:8199')).tracks[0]
            .segments.present,
    ).toBe(0);
});

test('a reload at 7 s is interrupted, and the take continues with a new run on the wall clock', async ({
    page,
    request,
    browserName,
}) => {
    test.skip(
        browserName !== 'chromium',
        'one engine is enough for the reload path',
    );
    const { descriptor } = await createSession(request, { recipe: 'monitor' });
    await installMedia(page, browserName);
    await openHarness(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 7);
    const batchesBefore = (
        await page.evaluate(() => window.internals.e2e.calls())
    ).filter((c) => c.url.endsWith('/events')).length;
    await page.reload();
    await page.waitForFunction(() => 'internals' in window);

    expect(await page.evaluate(() => window.internals.e2e.resume())).toEqual([
        { session_id: descriptor.session_id, state: 'interrupted' },
    ]);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 6);
    await page.evaluate(() => window.internals.e2e.stop());
    const local = await page.evaluate(() => window.internals.e2e.local());

    expect(local.runs.map((r) => [r.ended_reason, r.anchor_source])).toEqual([
        ['reload', 'performance'],
        ['stop', 'wall_clock'],
    ]);
    expect(local.firstBatchSeqAfterReload).toBeGreaterThanOrEqual(
        batchesBefore,
    );
    await expect
        .poll(
            async () => (await status(request, descriptor)).tracks[0].sealed,
            { timeout: 30_000 },
        )
        .toBe(true);
});

test('an interrupted session is finalised from resume() alone, with no descriptor passed in', async ({
    page,
    request,
    browserName,
}) => {
    test.skip(
        browserName !== 'chromium',
        'one engine is enough for the reload path',
    );
    const { descriptor } = await createSession(request, { recipe: 'monitor' });
    await installMedia(page, browserName);
    await openHarness(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 4);
    await page.reload();
    await page.waitForFunction(() => 'internals' in window);

    expect(await page.evaluate(() => window.internals.e2e.resume())).toEqual([
        { session_id: descriptor.session_id, state: 'interrupted' },
    ]);
    await page.evaluate(
        (id) => window.internals.e2e.finaliseResumed(id),
        descriptor.session_id,
    );
    expect(
        (await page.evaluate(() => window.internals.e2e.calls()))
            .filter((c) => c.url.endsWith('/finalise'))
            .map((c) => c.status),
    ).toEqual([200]);
});

test('a session re-attached in a fresh tab continues on the same clock', async ({
    page,
    context,
    request,
    browserName,
}) => {
    test.skip(
        browserName !== 'chromium',
        'one engine is enough for the reload path',
    );
    const { descriptor } = await createSession(request, { recipe: 'monitor' });
    await installMedia(page, browserName);
    await openHarness(page);
    await page.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(page, 7);
    await page.close();
    const fresh = await context.newPage(); // shares IndexedDB and localStorage, not sessionStorage
    await installMedia(fresh, browserName);
    await openHarness(fresh);
    await fresh.evaluate((d) => window.internals.e2e.open(d, {}), descriptor);
    await record(fresh, 4);
    await fresh.evaluate(() => window.internals.e2e.stop());
    const runs = (await fresh.evaluate(() => window.internals.e2e.local()))
        .runs;

    expect(runs).toHaveLength(2);
    expect(runs[1].anchor_source).toBe('wall_clock');
    expect(runs[1].anchor_ms).toBeGreaterThan(runs[0].ended_ms ?? 0);
});
