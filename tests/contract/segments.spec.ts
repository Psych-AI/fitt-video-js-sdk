import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { measured, openHarness } from '../browser/support/measure.ts';
import { FIXTURES_DIR } from '../support/fixtures.ts';
import { createSession, proxyCounts, resetProxy } from './support.ts';

const fragment = (seq: number): string =>
    readFileSync(
        `${FIXTURES_DIR}chrome-vp8-kf-aligned/fragments/seq_0000${seq}.bin`,
    ).toString('base64');
const RUN = '01jbz8q4w6x0k3m5n7p9r2t4v6';

test('segment writes answer as the contract says, on both rungs', async ({
    page,
    request,
    browserName,
}, testInfo) => {
    const { descriptor } = await createSession(request);
    await openHarness(page);
    await resetProxy(request);
    // The browser signs the URL's path and the server signs getPathInfo(): a prefixed VIDEO_API_URL fails here, not in production.
    expect(new URL(descriptor.tracks[0].upload.url).pathname).toBe(
        `/api/v1/sessions/${descriptor.session_id}/tracks/camera/segments`,
    );

    const results = await page.evaluate(
        async ({ d, init, media, run }) => {
            const {
                segmentPut,
                segmentPost,
                send,
                browserEnvironment,
                sha256Hex,
                fromBase64,
            } = window.internals;
            const env = browserEnvironment();
            const token = { id: d.token.id, secret: d.token.secret };
            const camera = d.tracks[0].upload.url;
            const initBytes = fromBase64(init);
            const mediaBytes = fromBase64(media);
            const initMeta = {
                take: 1,
                run,
                seq: 0,
                kind: 'init' as const,
                startMs: 12,
                durationMs: 0,
                recordedAt: Date.now(),
                sha256: await sha256Hex(initBytes),
                init: {
                    anchorMs: 12,
                    anchorSource: 'performance' as const,
                    mime: 'video/webm;codecs=vp8,opus',
                    startedMs: 10,
                },
            };
            const mediaMeta = {
                take: 1,
                run,
                seq: 1,
                kind: 'media' as const,
                startMs: 12,
                durationMs: 5026,
                recordedAt: Date.now(),
                sha256: await sha256Hex(mediaBytes),
            };
            const out: Record<string, unknown> = {};

            out.init = await send(
                env,
                segmentPut(camera, token, initMeta, initBytes),
            );
            out.again = await send(
                env,
                segmentPut(camera, token, initMeta, initBytes),
            );
            out.other = await send(
                env,
                segmentPut(
                    camera,
                    token,
                    { ...initMeta, sha256: await sha256Hex(mediaBytes) },
                    mediaBytes,
                ),
            );
            out.wrongHash = await send(
                env,
                segmentPut(
                    camera,
                    token,
                    { ...mediaMeta, seq: 2, sha256: 'ab'.repeat(32) },
                    mediaBytes,
                ),
            );
            const throughProxy = camera.replace(
                '127.0.0.1:8123',
                '127.0.0.1:8125',
            );
            out.post = await send(
                env,
                await segmentPost(
                    throughProxy,
                    token,
                    mediaMeta,
                    mediaBytes,
                    Date.now(),
                ),
            );
            const big = new Uint8Array(8_388_609);
            out.tooBig = await send(
                env,
                segmentPut(
                    camera,
                    token,
                    { ...mediaMeta, seq: 4, sha256: await sha256Hex(big) },
                    big.buffer,
                ),
            );

            return out;
        },
        { d: descriptor, init: fragment(0), media: fragment(1), run: RUN },
    );

    testInfo.annotations.push({
        type: 'answers',
        description: JSON.stringify(results),
    });
    const code = (key: string) => {
        const answer = results[key] as {
            status: number;
            body: { code?: string; error?: { code: string } };
        };

        return [answer.status, answer.body?.code ?? answer.body?.error?.code];
    };

    if (measured(testInfo, browserName)) {
        return;
    }

    expect(code('init')).toEqual([201, 'stored']);
    expect(code('again')).toEqual([200, 'already_present']);
    expect(code('other')).toEqual([409, 'segment_conflict']);
    expect(code('wrongHash')).toEqual([400, 'hash_mismatch']);
    expect(code('post')).toEqual([201, 'stored']);
    expect(code('tooBig')).toEqual([413, 'payload_too_large']);
    expect((await proxyCounts(request)).OPTIONS ?? 0).toBe(0);
});
