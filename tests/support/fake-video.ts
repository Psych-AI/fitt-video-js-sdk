import type { ObjectUrls } from '../../src/core/review.ts';

/** Object URLs that count: `blob:fake/1`, `blob:fake/2`, ...; every Blob and every revoke is kept. */
export function fakeObjectUrls(): ObjectUrls & {
    blobs: Blob[];
    made: string[];
    revoked: string[];
} {
    const blobs: Blob[] = [];
    const made: string[] = [];
    const revoked: string[] = [];

    return {
        blobs,
        made,
        revoked,
        create(blob: Blob): string {
            blobs.push(blob);
            const url = `blob:fake/${made.length + 1}`;
            made.push(url);

            return url;
        },
        revoke(url: string): void {
            revoked.push(url);
        },
    };
}
