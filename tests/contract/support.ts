import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import type { Descriptor } from '../../src/core/descriptor.ts';

export const API = 'http://127.0.0.1:8123/api/v1';

const PROXY = 'http://127.0.0.1:8125';

/** Creates an `answer` session with a space key (the contract space's by default), on the passthrough server unless `api` names another. */
export async function createSession(
    request: APIRequestContext,
    body: Record<string, unknown> = {},
    key: string | undefined = process.env.FITT_CONTRACT_KEY,
    api: string = API,
): Promise<{ descriptor: Descriptor; session: { id: string } }> {
    const response = await request.post(`${api}/sessions`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        data: { recipe: 'answer', tags: ['sdk-contract'], ...body },
    });

    expect(response.status(), await response.text()).toBe(201);

    return (await response.json()) as {
        descriptor: Descriptor;
        session: { id: string };
    };
}

/** The same descriptor, with every API and upload URL pointed at the proxy. */
export function viaProxy(descriptor: Descriptor): Descriptor {
    const swap = (url: string): string =>
        url.replace('http://127.0.0.1:8123', PROXY);

    return {
        ...descriptor,
        endpoints: {
            ...descriptor.endpoints,
            api: swap(descriptor.endpoints.api),
        },
        tracks: descriptor.tracks.map((track) => ({
            ...track,
            upload: {
                ...track.upload,
                url: swap(track.upload.url),
                fallback_url:
                    track.upload.fallback_url === null
                        ? null
                        : swap(track.upload.fallback_url),
            },
        })),
    } as Descriptor;
}

/** What the proxy has seen since its last reset, by method. */
export async function proxyCounts(
    request: APIRequestContext,
): Promise<Record<string, number>> {
    const response = await request.get(`${PROXY}/__counts`);

    return (await response.json()) as Record<string, number>;
}

export async function resetProxy(request: APIRequestContext): Promise<void> {
    await request.post(`${PROXY}/__counts/reset`);
}
