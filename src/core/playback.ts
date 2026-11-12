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
    let listeners: Listener[] = [];
    let fetching = false;
    const playing = !video.paused && !video.ended;

    const setSource = (source: PlaybackSource): void => {
        current = source;
        deps.onSource(source);
    };

    const listen = (
        type: string,
        handler: () => void,
        once = false,
    ): Listener => {
        const entry: Listener = {
            type,
            handler: once
                ? (): void => {
                      forget(entry);
                      handler();
                  }
                : handler,
        };
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

    /** Sets the place once the new src has its metadata; nothing when the result is not finite. */
    const seekOnLoad = (target: number | 'end'): void => {
        listen(
            'loadedmetadata',
            () => {
                if (!live()) {
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
            },
            true,
        );
    };

    /** A media error on the server source fetches the URL again (it lives 120 s) and keeps the place. */
    const watchExpiry = (): void => {
        listen('error', () => {
            if (!live() || current !== 'server' || fetching) {
                return;
            }

            fetching = true;
            const at = video.currentTime;

            void deps
                .waitServer(REFETCH_MS, deps.cancelled)
                .then(
                    (next) => {
                        if (!live()) {
                            return;
                        }

                        seekOnLoad(at);
                        video.src = next;
                    },
                    () => undefined,
                )
                .finally(() => {
                    fetching = false;
                });
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

    if (playing && held) {
        // Never set src while the video plays: keep the local copy and wait for a pause.
        setSource('local');
        const server = waitServer();
        server?.then(switchWhenIdle, () => undefined);

        return 'local';
    }

    setSource('preparing');
    const server = waitServer();

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

        if (first !== null) {
            startServer(first);

            return 'server';
        }
    }

    if (held && live()) {
        const url = deps.copy.objectUrl();

        if (url !== null) {
            video.src = url;
            setSource('local');
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
        setSource('none');

        throw error;
    }

    startServer(url);

    return 'server';
}
