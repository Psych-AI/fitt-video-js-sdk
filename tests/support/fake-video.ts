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

/** The parts of a video element session.playback() uses; play, pause, end and loaded act as the browser does. */
export class FakeVideo extends EventTarget {
    src = '';
    preload = 'metadata';
    currentTime = 0;
    paused = true;
    ended = false;
    duration = Number.NaN;

    play(): void {
        this.paused = false;
        this.dispatchEvent(new Event('play'));
    }

    pause(): void {
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
    }

    end(): void {
        this.paused = true;
        this.ended = true;
        this.dispatchEvent(new Event('ended'));
    }

    /** The engine refused the current src: a media error, as Safari 18.6 raises on a blob: URL it preloaded metadata-only. */
    fail(): void {
        this.dispatchEvent(new Event('error'));
    }

    /** The current src loaded its metadata. */
    loaded(duration: number): void {
        this.duration = duration;
        this.ended = false;
        this.dispatchEvent(new Event('loadedmetadata'));
    }
}
