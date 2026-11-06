import { expect, test } from '@playwright/test';
import { openHarness } from '../browser/support/measure.ts';
import { createSession } from './support.ts';

test('a complete manifest seals at once, and a manifest with an unsent seq seals once it is listed abandoned', async ({
    page,
    request,
}) => {
    const monitor = (await createSession(request, { recipe: 'monitor' }))
        .descriptor;
    const answer = (await createSession(request)).descriptor;
    await openHarness(page);

    const result = await page.evaluate(
        async ({ monitor, answer }) => {
            const {
                browserEnvironment,
                createSessionApi,
                buildManifest,
                putFixtureSegments,
            } = window.internals;
            const env = browserEnvironment();
            const post = async (
                d: typeof monitor,
                track: 'camera' | 'audio',
                records: Awaited<ReturnType<typeof putFixtureSegments>>,
                abandonSeq?: number,
            ) => {
                const api = createSessionApi(
                    env,
                    () => d,
                    () => d.token,
                );
                const segments = records.map((record) =>
                    record.seq === abandonSeq
                        ? { ...record, state: 'abandoned' as const }
                        : record,
                );

                return api.postManifest(
                    track,
                    buildManifest({
                        take: 1,
                        takeStartMs: 0,
                        endMs: 20_000,
                        partSize: 1_048_576,
                        runs: [records.run],
                        segments,
                    }),
                );
            };
            const sent = await putFixtureSegments({
                descriptor: monitor,
                track: 'camera',
                seqs: [0, 1, 2, 3],
            });
            const audio = await putFixtureSegments({
                descriptor: answer,
                track: 'audio',
                seqs: [0, 1, 2],
                skip: [2],
            });

            return {
                monitor: await post(monitor, 'camera', sent),
                unsent: await post(answer, 'audio', audio),
                abandoned: await post(answer, 'audio', audio, 2),
            };
        },
        { monitor, answer },
    );

    expect(result.monitor.status).toBe(200);
    expect(result.monitor.body).toEqual({
        track: expect.objectContaining({
            track: 'camera',
            sealed: true,
            segments: { expected: 0, present: 4, missing: 0, abandoned: 0 },
        }),
        late_window_s: 0,
    });
    expect(result.unsent.body).toEqual({
        track: expect.objectContaining({ sealed: false }),
        late_window_s: expect.any(Number),
    });
    expect(
        (result.unsent.body as { late_window_s: number }).late_window_s,
    ).toBeGreaterThan(0);
    expect(
        (result.unsent.body as { late_window_s: number }).late_window_s,
    ).toBeLessThanOrEqual(600);
    expect(result.abandoned.body).toEqual({
        track: expect.objectContaining({
            sealed: true,
            segments: { expected: 0, present: 2, missing: 0, abandoned: 1 },
        }),
        late_window_s: 0,
    });
});

test('finalise, reset and discard answer as the SDK reads them', async ({
    page,
    request,
}) => {
    const first = (await createSession(request)).descriptor;
    const second = (await createSession(request)).descriptor;
    const third = (await createSession(request)).descriptor;
    await openHarness(page);

    const result = await page.evaluate(
        async ({ first, second, third }) => {
            const {
                browserEnvironment,
                createSessionApi,
                segmentPut,
                send,
                sha256Hex,
            } = window.internals;
            const env = browserEnvironment();
            const api = (d: typeof first) =>
                createSessionApi(
                    env,
                    () => d,
                    () => d.token,
                );
            const finalised = await api(first).finalise(15_000);
            const again = await api(first).finalise(16_000);
            const status = await api(first).status();
            const reset = await api(second).reset(1);
            const resetAgain = await api(second).reset(1);
            await api(second).finalise(1000);
            // A reset of a finalising session: the SDK's resetTake() reads this as "not allowed now", never as closing (Task 15a).
            const resetClosed = await api(second).reset(2);
            const discarded = await api(third).discard();
            const bytes = new Uint8Array([1]).buffer;
            const put = await send(
                env,
                segmentPut(
                    third.tracks[0].upload.url,
                    third.token,
                    {
                        take: 1,
                        run: '01jbz8q4w6x0k3m5n7p9r2t4v9',
                        seq: 1,
                        kind: 'media',
                        startMs: 0,
                        durationMs: 1,
                        recordedAt: Date.now(),
                        sha256: await sha256Hex(bytes),
                    },
                    bytes,
                ),
            );
            const events = await api(third).events(
                JSON.stringify({
                    take: 1,
                    batch_seq: 0,
                    sent_at_ms: Date.now(),
                    events: [],
                }),
                false,
            );
            const afterStatus = await api(third).status();
            const code = (answer: { status: number; body: unknown }) => [
                answer.status,
                (answer.body as { error?: { code: string } } | null)?.error
                    ?.code ?? null,
            ];

            return {
                finalised: finalised.status,
                again: again.status,
                endMs: (status.body as { session: { end_ms: number } }).session
                    .end_ms,
                reset: [reset.status, reset.body],
                resetAgain: [resetAgain.status, resetAgain.body],
                resetClosed: code(resetClosed),
                discarded: discarded.status,
                put: code(put),
                events: code(events),
                afterStatus: code(afterStatus),
            };
        },
        { first, second, third },
    );

    expect(result).toEqual({
        finalised: 200,
        again: 200,
        endMs: 15_000,
        reset: [200, { take: 2 }],
        resetAgain: [200, { take: 2 }],
        resetClosed: [409, 'session_closed'],
        discarded: 200,
        put: [409, 'discarded'],
        events: [409, 'discarded'],
        afterStatus: [409, 'discarded'],
    });
});
