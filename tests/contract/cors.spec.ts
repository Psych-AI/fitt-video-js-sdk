import { expect, test } from '@playwright/test';
import { openHarness } from '../browser/support/measure.ts';
import { createSession, proxyCounts, resetProxy } from './support.ts';

test('the hosted module imports cross-origin, reports its version and defines fitt-recorder', async ({
    page,
}) => {
    await openHarness(page);

    const loaded = await page.evaluate(async (url) => {
        const module = (await import(url)) as { VERSION: string };

        return {
            version: module.VERSION,
            element: typeof customElements.get('fitt-recorder'),
        };
    }, 'http://127.0.0.1:8123/sdk/v1/fitt-video.js');

    expect(loaded).toEqual({ version: '1.0.2', element: 'function' });
});

test('a Bearer GET from an allowed origin gets a readable status', async ({
    page,
    request,
}) => {
    const { descriptor } = await createSession(request);
    await openHarness(page);

    const status = await page.evaluate(async (d) => {
        const response = await fetch(
            `${d.endpoints.api}/sessions/${d.session_id}/status`,
            {
                headers: {
                    Authorization: `Bearer fvt_${d.token.id}.${d.token.secret}`,
                    Accept: 'application/json',
                },
                credentials: 'omit',
            },
        );

        return (await response.json()).checks.status as string;
    }, descriptor);

    expect(status).toBe('pending');
});

test('the same call for a space that does not allow this origin is a TypeError, like being offline', async ({
    page,
    request,
}) => {
    const { descriptor } = await createSession(
        request,
        {},
        process.env.FITT_CONTRACT_KEY_OTHER,
    );
    await openHarness(page);

    const outcome = await page.evaluate(async (d) => {
        try {
            await fetch(`${d.endpoints.api}/sessions/${d.session_id}/status`, {
                headers: {
                    Authorization: `Bearer fvt_${d.token.id}.${d.token.secret}`,
                },
                credentials: 'omit',
            });

            return 'answered';
        } catch (error) {
            return error instanceof TypeError ? 'TypeError' : String(error);
        }
    }, descriptor);

    expect(outcome).toBe('TypeError');
});

test('a PUT through a proxy that refuses preflights is a TypeError and never reaches the server', async ({
    page,
    request,
}) => {
    const { descriptor } = await createSession(request);
    await resetProxy(request);
    await openHarness(page);

    const outcome = await page.evaluate(async (d) => {
        try {
            await fetch(
                `http://127.0.0.1:8125/api/v1/sessions/${d.session_id}/tracks/camera/segments/0`,
                {
                    method: 'PUT',
                    headers: {
                        Authorization: `Bearer fvt_${d.token.id}.${d.token.secret}`,
                        'Content-Type': 'application/octet-stream',
                        'X-Fitt-Take': '1',
                    },
                    body: new ArrayBuffer(10),
                    credentials: 'omit',
                },
            );

            return 'answered';
        } catch (error) {
            return error instanceof TypeError ? 'TypeError' : String(error);
        }
    }, descriptor);
    const counts = await proxyCounts(request);

    expect(outcome).toBe('TypeError');
    expect(counts.OPTIONS ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.PUT ?? 0).toBe(0);
});
