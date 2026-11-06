import { expect, test } from '@playwright/test';
import { measured, openHarness } from '../browser/support/measure.ts';
import { API, createSession } from './support.ts';

test('refresh, grace and a stale take answer as the contract says', async ({
    page,
    request,
    browserName,
}, testInfo) => {
    const { descriptor } = await createSession(request);
    await openHarness(page);

    const result = await page.evaluate(
        async ({ d, api }) => {
            const {
                browserEnvironment,
                send,
                jsonRequest,
                segmentPut,
                sha256Hex,
                runUploader,
            } = window.internals;
            const env = browserEnvironment();
            const old = { id: d.token.id, secret: d.token.secret };
            const bytes = new Uint8Array([1, 2, 3]).buffer;
            const meta = (seq: number, take = 1) => ({
                take,
                run: '01jbz8q4w6x0k3m5n7p9r2t4v7',
                seq,
                kind: 'media' as const,
                startMs: seq * 5000,
                durationMs: 5000,
                recordedAt: Date.now(),
            });
            const camera = d.tracks[0].upload.url;
            const refreshed = await send(
                env,
                jsonRequest(
                    `${api}/sessions/${d.session_id}/refresh-upload`,
                    old,
                    'POST',
                ),
            );
            const fresh = (refreshed.body as { descriptor: typeof d })
                .descriptor;
            const token = { id: fresh.token.id, secret: fresh.token.secret };
            const sha256 = await sha256Hex(bytes);
            const withNew = await send(
                env,
                segmentPut(camera, token, { ...meta(1), sha256 }, bytes),
            );
            const withOld = await send(
                env,
                segmentPut(camera, old, { ...meta(2), sha256 }, bytes),
            );
            const refreshOld = await send(
                env,
                jsonRequest(
                    `${api}/sessions/${d.session_id}/refresh-upload`,
                    old,
                    'POST',
                ),
            );
            await send(
                env,
                jsonRequest(
                    `${api}/sessions/${d.session_id}/reset`,
                    token,
                    'POST',
                    { take: 1 },
                ),
            );
            const stale = await runUploader({
                descriptor: fresh,
                segments: [
                    {
                        track: 'camera',
                        take: 1,
                        run: '01jbz8q4w6x0k3m5n7p9r2t4v8',
                        seq: 1,
                        kind: 'media',
                        base64: 'AQID',
                    },
                ],
                seconds: 5,
                currentTake: 2,
            });

            return {
                refreshed: refreshed.status,
                withNew: withNew.status,
                withOld: withOld.status,
                refreshOld: [refreshOld.status, refreshOld.body],
                stale,
            };
        },
        { d: descriptor, api: API },
    );

    testInfo.annotations.push({
        type: 'answers',
        description: JSON.stringify(result),
    });

    if (measured(testInfo, browserName)) {
        return;
    }

    expect(result.refreshed).toBe(201);
    expect(result.withNew).toBe(201);
    expect(result.withOld).toBe(201);
    expect(result.refreshOld).toEqual([
        401,
        {
            error: expect.objectContaining({
                code: 'token_expired',
                recoverable: true,
            }),
        },
    ]);
    expect(result.stale.events).toContainEqual([
        'upload.segment_rejected',
        { track: 'camera', seq: 1, code: 'stale_take' },
    ]);
    expect(result.stale.states).toEqual([]);
});
