/**
 * The review player behind `session.playback(video)` (Plan 9, spec 6.10, author's calls 7 and 8).
 *
 * It plays the server file when the status has its URL at the first look, else the local copy
 * when one is held, else it shows `preparing` and waits for the server file. A server URL that
 * arrives while the local copy plays is used only while the video is paused or ended, never mid
 * play: the switch keeps the place plus the copy's lead-in (the server file starts at the take
 * start, the copy at the run anchor). The player never calls play(). A later call replaces it:
 * once `cancelled()` is true it removes its listeners and never touches its video again.
 */

import type { Environment } from './env.ts';
import { FittVideoError } from './errors.ts';
import type { LocalCopy } from './review.ts';
import type { PlaybackSource } from './state.ts';

export type PlaybackElement = Pick<
    HTMLVideoElement,
    | 'src'
    | 'preload'
    | 'currentTime'
    | 'paused'
    | 'ended'
    | 'duration'
    | 'addEventListener'
    | 'removeEventListener'
>;

/** How long playback() waits for the first status answers before it shows the local copy (author's call 7). */
export const FIRST_LOOK_MS = 1500;

/** How long it waits for the server file: the upload token's lifetime (spec 9.1). */
export const SERVER_WAIT_MS = 900_000;

/** How long the fetch of an expired server URL waits. */
export const REFETCH_MS = 30_000;

export interface PlayerDeps {
    env: Environment;
    copy: LocalCopy;
    inStatus: boolean;
    waitServer(timeoutMs: number, cancelled: () => boolean): Promise<string>;
    cancelled(): boolean;
    onSource(source: PlaybackSource): void;
    emit(type: string, payload: Record<string, unknown>): void;
}

type Listener = { type: string; handler: () => void };

export async function startPlayback(
    video: PlaybackElement,
    deps: PlayerDeps,
): Promise<'local' | 'server'> {
    let current: PlaybackSource = 'none';
    /** What a cancelled call returns: a promise that never settles, so it never reports or sets a source. */
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    let listeners: Listener[] = [];
    let fetching = false;
    const playing = !video.paused && !video.ended;

    const setSource = (source: PlaybackSource): void => {
        current = source;
        deps.onSource(source);
    };

    const listen = (type: string, handler: () => void): Listener => {
        const entry: Listener = { type, handler };
        listeners.push(entry);
        video.addEventListener(type, entry.handler);

        return entry;
    };

    const forget = (entry: Listener): void => {
        video.removeEventListener(entry.type, entry.handler);
        listeners = listeners.filter((other) => other !== entry);
    };

    const detach = (): void => {
        for (const entry of listeners) {
            video.removeEventListener(entry.type, entry.handler);
        }

        listeners = [];
    };

    /** False, after detaching, once a later call or a clearing rule replaced this player. */
    const live = (): boolean => {
        if (deps.cancelled()) {
            detach();

            return false;
        }

        return true;
    };

    /** The one pending place for the next src's metadata; a later seek replaces it, never stacks beside it. */
    let pendingSeek: number | 'end' | null = null;
    /** True from setting a refetched URL until its metadata loads: an error then is not an expiry. */
    let retried = false;
    let seeking: Listener | null = null;

    const onMetadata = (): void => {
        if (!live()) {
            return;
        }

        retried = false;
        const target = pendingSeek;
        pendingSeek = null;

        if (target === null) {
            return;
        }

        const duration = video.duration;
        const at =
            target === 'end'
                ? duration
                : Number.isFinite(duration)
                  ? Math.min(target, duration)
                  : target;

        if (Number.isFinite(at)) {
            video.currentTime = at;
        }
    };

    /** Sets the place once the new src has its metadata; nothing when the result is not finite. */
    const seekOnLoad = (target: number | 'end'): void => {
        pendingSeek = target;
        seeking ??= listen('loadedmetadata', onMetadata);
    };

    /**
     * A media error on the server source fetches the URL again (it lives 120 s) and keeps the place.
     * A refetched URL that errors before its metadata loads is not an expired one (a file the engine
     * cannot decode, a URL that always fails): it is not fetched again, so nothing loops.
     */
    const watchExpiry = (): void => {
        listen('error', () => {
            if (!live() || current !== 'server' || fetching || retried) {
                return;
            }

            fetching = true;
            const at = pendingSeek ?? video.currentTime;

            void deps
                .waitServer(REFETCH_MS, deps.cancelled)
                .then(
                    (next) => {
                        if (!live()) {
                            return;
                        }

                        seekOnLoad(at);
                        retried = true;
                        video.src = next;
                    },
                    () => undefined,
                )
                .finally(() => {
                    fetching = false;
                });
        });
    };

    /**
     * A media error on the local copy (Safari 18.6 raises one on the first ranged read of a
     * blob: URL it preloaded metadata-only, even though the bytes play with preload auto):
     * the copy is cleared as `unplayable` and the player falls back to the server file at the
     * same place, or to no source when the status carries no playback.
     */
    const watchLocal = (): void => {
        listen('error', () => {
            if (!live() || current !== 'local') {
                return;
            }

            const at = video.currentTime;
            const lead = deps.copy.leadInMs();
            deps.copy.clear('unplayable');

            if (server === null) {
                setSource('none');
                deps.emit('playback.source', {
                    source: 'none',
                    from: 'local',
                    at: 'error',
                });

                return;
            }

            setSource('preparing');
            deps.emit('playback.source', {
                source: 'preparing',
                from: 'local',
                at: 'error',
            });

            server.then(
                (url) => {
                    if (!live() || current !== 'preparing') {
                        return;
                    }

                    seekOnLoad(at + lead / 1000);
                    video.src = url;
                    setSource('server');
                    deps.emit('playback.source', {
                        source: 'server',
                        from: 'local',
                        at: 'error',
                        offset_ms: lead,
                    });
                    watchExpiry();
                },
                () => {
                    if (live() && current === 'preparing') {
                        setSource('none');
                    }
                },
            );
        });
    };

    const toServer = (url: string, at: 'start' | 'paused' | 'ended'): void => {
        if (!live()) {
            return;
        }

        if (at === 'start') {
            video.src = url;
            setSource('server');
            deps.emit('playback.source', { source: 'server', at: 'start' });
        } else {
            const lead = deps.copy.leadInMs();
            seekOnLoad(
                at === 'ended' ? 'end' : video.currentTime + lead / 1000,
            );
            video.src = url;
            setSource('server');
            deps.emit('playback.source', {
                source: 'server',
                from: 'local',
                at,
                offset_ms: lead,
            });
        }

        deps.copy.clear('server');
        watchExpiry();
    };

    /** Calls `then` at once when the video is paused or ended, else at its first pause or end. */
    const whenIdle = (then: () => void): void => {
        if (video.paused || video.ended) {
            then();

            return;
        }

        const onIdle = (): void => {
            if (!live()) {
                return;
            }

            if (!video.paused && !video.ended) {
                return;
            }

            forget(onPause);
            forget(onEnded);
            then();
        };
        const onPause = listen('pause', onIdle);
        const onEnded = listen('ended', onIdle);
    };

    /** The switch from the local copy: only while paused or ended (a natural end fires pause with ended true). */
    const switchWhenIdle = (url: string): void => {
        if (!live() || current !== 'local') {
            return;
        }

        whenIdle(() => {
            if (current === 'local') {
                toServer(url, video.ended ? 'ended' : 'paused');
            }
        });
    };

    /** The server file on the start path; a playing video keeps its place and waits for a pause. */
    const startServer = (url: string): void => {
        if (!playing) {
            toServer(url, 'start');

            return;
        }

        whenIdle(() => {
            if (!live()) {
                return;
            }

            seekOnLoad(video.ended ? 'end' : video.currentTime);
            toServer(url, 'start');
        });
    };

    const held = deps.copy.view().state === 'held';

    if (!held && !deps.inStatus) {
        deps.onSource('none');

        throw new FittVideoError('playback_not_enabled', {
            reason: 'no_local_copy',
        });
    }

    const waitServer = (): Promise<string> | null => {
        const wait = deps.inStatus
            ? deps.waitServer(SERVER_WAIT_MS, deps.cancelled)
            : null;
        wait?.catch(() => undefined);

        return wait;
    };

    const server = waitServer();

    if (playing && held) {
        // Never set src while the video plays: keep the local copy and wait for a pause.
        setSource('local');
        watchLocal();
        server?.then(switchWhenIdle, () => undefined);

        return 'local';
    }

    setSource('preparing');

    if (held && server !== null) {
        const first = await Promise.race([
            server.then(
                (url): string | null => url,
                () => null,
            ),
            new Promise<null>((resolve) =>
                deps.env.timers.setTimeout(() => resolve(null), FIRST_LOOK_MS),
            ),
        ]);

        if (!live()) {
            return never();
        }

        if (first !== null) {
            startServer(first);

            return 'server';
        }
    }

    if (held && live()) {
        const url = deps.copy.objectUrl();

        if (url !== null) {
            // The copy is already in memory, so load it whole. Safari 18.6 fails a blob: URL with
            // preload metadata on its first ranged read (media error 2, "Media failed to load").
            video.preload = 'auto';
            video.src = url;
            setSource('local');
            watchLocal();
            deps.emit('playback.source', { source: 'local', at: 'start' });
            server?.then(switchWhenIdle, () => undefined);

            return 'local';
        }
    }

    if (server === null) {
        setSource('none');

        throw new FittVideoError('playback_not_enabled', {
            reason: 'no_local_copy',
        });
    }

    let url: string;

    try {
        url = await server;
    } catch (error) {
        if (!live()) {
            return never();
        }

        setSource('none');

        throw error;
    }

    if (!live()) {
        return never();
    }

    startServer(url);

    return 'server';
}
