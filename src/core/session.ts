import type { MixSource } from '../recorder/audio.ts';
import type { MediaDevicesLike, Selection } from '../recorder/capture.ts';
import type { DevicesView } from '../recorder/devices.ts';
import {
    createRecorderEngine,
    type RecorderEngine,
} from '../recorder/engine.ts';
import type { RecorderFactory } from '../recorder/run.ts';
import { createSilenceDetector } from '../recorder/silence.ts';
import { createStallWatch, type StallWatch } from '../recorder/stall.ts';
import {
    lockKeyboard,
    requestFullscreen,
    type ActionResult,
} from '../signals/fullscreen.ts';
import {
    environmentSnapshot,
    startSignals,
    type PageLike,
} from '../signals/index.ts';
import { VERSION } from '../version.ts';
import {
    callWithRetry,
    createSessionApi,
    transcriptBody,
    type SessionApi,
    type TranscriptUpload,
} from './api.ts';
import { backoffMs } from './backoff.ts';
import { createBatcher, type Batcher } from './batcher.ts';
import {
    waitForChecks as pollChecks,
    waitForReady as pollReady,
    type ChecksResult,
} from './checks.ts';
import { createClock, type Clock, type ClockJump } from './clock.ts';
import {
    readDescriptor,
    type ChunkedTrack,
    type Descriptor,
    type RecordingLimits,
    type TrackName,
} from './descriptor.ts';
import { createStayOnPage } from './enforce.ts';
import { browserEnvironment, type Environment } from './env.ts';
import {
    ERROR_CODES,
    FittVideoError,
    type ErrorCode,
    type RejectionCode,
} from './errors.ts';
import { createEventBus, type SdkEvent } from './events.ts';
import { send, type WireAnswer } from './http.ts';
import { createLadder, type Ladder } from './ladder.ts';
import {
    createLifecycle,
    type Lifecycle,
    type Milestone,
    type TakeEngine,
} from './lifecycle.ts';
import { buildManifest } from './manifest.ts';
import { resolveSettings, type SessionOptions } from './options.ts';
import { createQueue, type Queue } from './queue.ts';
import { classify } from './responses.ts';
import { planResume } from './resume-plan.ts';
import { createState, type Phase, type SessionState } from './state.ts';
import {
    MemoryQueueStore,
    openStore,
    type QueueStore,
    type SegmentRecord,
    type SessionRecord,
} from './store.ts';
import { createTokenKeeper, type TokenKeeper } from './token.ts';
import { createUploader, type Uploader } from './uploader.ts';
import { eventsRequest } from './wire.ts';

/** The session a host drives (spec 6.2). */
export interface FittSession {
    readonly id: string;
    readonly state: SessionState;
    readonly stream: MediaStream | null;
    readonly devices: DevicesView;
    readonly audioLevel: number;
    readonly debug?: { dropNextSegment(track?: TrackName): void };
    prepare(): Promise<void>;
    /** srcObject = the capture stream, muted, playsInline, autoplay, mirrored unless mirror is false; followed on every re-acquire. */
    attachPreview(
        video: HTMLVideoElement,
        options?: { mirror?: boolean },
    ): void;
    /** Stops following this element; when no connected preview is left, the session's own hidden element takes over the stall watch. */
    detachPreview(video: HTMLVideoElement): void;
    mixAudio(source: MixSource, options: { role: 'interviewer' }): void;
    onAudioLevel(listener: (level: number) => void): () => void;
    now(): number;
    start(): Promise<void>;
    stop(options?: { sealTracks?: boolean }): Promise<void>;
    finalise(): Promise<void>;
    waitForChecks(options?: { timeoutMs?: number }): Promise<ChecksResult>;
    waitForReady(options: {
        track: TrackName;
        timeoutMs?: number;
    }): Promise<string>;
    reset(): Promise<void>;
    discard(): Promise<void>;
    event(type: string, payload?: Record<string, unknown> | unknown[]): boolean;
    uploadTranscript(upload: TranscriptUpload): Promise<void>;
    onEvent(listener: (event: SdkEvent) => void): () => void;
    onStatus(listener: (state: SessionState) => void): () => void;
    onMilestone(listener: (milestone: Milestone) => void): () => void;
    onChecks(listener: (checks: ChecksResult) => void): () => void;
    /** Called with {track, url} whenever waitForReady() resolves, whoever called it. */
    onReady(
        listener: (ready: { track: TrackName; url: string }) => void,
    ): () => void;
    requestFullscreen(target?: Element): Promise<ActionResult>;
    lockKeyboard(): Promise<ActionResult>;
    /** Releases capture and listeners; the lock, the channel, the queue and the map entry stay (author's call 12). */
    destroy(): void;
}

/** The browser's globals; tests pass their own. */
export interface SessionSeams {
    /** Tests pass a whole fake environment here; the browser uses browserEnvironment(options.environment). */
    env?: Environment;
    /** null outside a browser: prepare() rejects recorder_unsupported. */
    media: (MediaDevicesLike & EventTarget) | null;
    recorderFactory: RecorderFactory;
    makeStream(tracks: MediaStreamTrack[]): MediaStream;
    isTypeSupported(type: string): boolean;
    permissions: Permissions | undefined;
    /** null outside a browser: no signals, no stay-on-page, no stall watch. */
    page: PageLike | null;
    /** null: no audio graph (Node tests); the camera records the microphone track as is. */
    createAudioContext: (() => AudioContext) | null;
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    indexedDB: IDBFactory | undefined;
    /** Tests pass a store; the browser opens IndexedDB. */
    store?: QueueStore;
}

type StorageView = SessionSeams['storage'];

/** Errors that leave nothing to record with: only these enter phase 'error' (author's call 12). */
const PHASE_ERRORS: ReadonlySet<string> = new Set([
    'permission_denied',
    'device_busy',
    'no_camera',
    'no_microphone',
    'recorder_unsupported',
    'config_invalid',
]);

/** The codes the engine clears with onError(null) once a device or a run is back. */
const RECOVERED_CODES: readonly ErrorCode[] = [
    'device_disconnected',
    'recorder_error',
];

/** The capture codes a successful prepare() clears. */
const CAPTURE_CODES: readonly ErrorCode[] = [
    'permission_denied',
    'device_busy',
    'no_camera',
    'no_microphone',
    'device_disconnected',
    'recorder_unsupported',
];

/** The session's own tick: the clock, the token deadline, the upload state. */
const TICK_MS = 1000;

/** A live session writes last_activity_ms at least this often, so it is never seen as abandoned. */
const ACTIVITY_MS = 60_000;

/** A tombstone outlives its token by this much (author's call 15). */
const TOMBSTONE_MARGIN_MS = 60_000;

/** Manifest network errors in a row after which a network known to block preflights stops holding up stop(). */
const MANIFEST_BLOCKED_AFTER = 2;

/** The style of the session's own stall-watch element: never display:none, so requestVideoFrameCallback keeps firing. */
const OWN_VIDEO_STYLE =
    'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';

const epochKey = (sessionId: string): string => `fitt-video:${sessionId}:epoch`;
const seqKey = (sessionId: string): string =>
    `fitt-video:${sessionId}:next_batch_seq`;

function readNumber(storage: StorageView, key: string): number | null {
    try {
        const value = storage?.getItem(key) ?? null;

        if (value === null) {
            return null;
        }

        const parsed = Number(value);

        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } catch {
        return null;
    }
}

function writeItem(storage: StorageView, key: string, value: string): void {
    try {
        storage?.setItem(key, value);
    } catch {
        // A full or blocked localStorage: IndexedDB still holds the value.
    }
}

function removeItem(storage: StorageView, key: string): void {
    try {
        storage?.removeItem(key);
    } catch {
        // Nothing to do: the key ages out with the origin's storage.
    }
}

function isErrorCode(code: unknown): code is ErrorCode {
    return (ERROR_CODES as readonly unknown[]).includes(code);
}

function codeOf(error: unknown): ErrorCode | RejectionCode | null {
    return error instanceof FittVideoError ? error.code : null;
}

function rejectWith(
    code: ErrorCode | RejectionCode,
    detail: Record<string, unknown> = {},
): Promise<never> {
    return Promise.reject(new FittVideoError(code, detail));
}

function isConnected(video: HTMLVideoElement): boolean {
    return (video as { isConnected?: boolean }).isConnected !== false;
}

function chunkedTracks(descriptor: Descriptor): ChunkedTrack[] {
    return descriptor.tracks.filter(
        (track): track is ChunkedTrack => track.kind === 'chunked',
    );
}

function isOk(answer: WireAnswer): boolean {
    return answer.status >= 200 && answer.status < 300;
}

function listenerSet<T>(): {
    add(listener: (value: T) => void): () => void;
    call(value: T): void;
} {
    const listeners = new Set<(value: T) => void>();

    return {
        add(listener) {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        call(value) {
            for (const listener of [...listeners]) {
                try {
                    listener(value);
                } catch (error) {
                    // One host listener that throws must never stop the session.
                    console.error(error);
                }
            }
        },
    };
}

const NO_DEVICES: DevicesView = {
    cameras: [],
    microphones: [],
    selected: {},
    select: () => rejectWith('config_invalid'),
};

/** What FittVideo.session() returns for a descriptor it cannot read: phase 'error', never a throw. */
function invalidSession(detail: Record<string, unknown>): FittSession {
    const state: SessionState = Object.freeze({
        phase: 'error' as Phase,
        upload: {
            bytesSent: 0,
            bytesTotal: 0,
            backlog: 0,
            tracksSealed: 0,
            sessionFinalised: false,
        },
        checks: null,
        error: { code: 'config_invalid' as ErrorCode, detail },
        audio: 'ok' as const,
    });
    const refuse = (): Promise<never> => rejectWith('config_invalid', detail);
    const none = (): (() => void) => () => undefined;

    return {
        id: '',
        state,
        stream: null,
        devices: NO_DEVICES,
        audioLevel: 0,
        prepare: refuse,
        attachPreview: () => undefined,
        detachPreview: () => undefined,
        mixAudio: () => undefined,
        onAudioLevel: none,
        now: () => 0,
        start: refuse,
        stop: refuse,
        finalise: refuse,
        waitForChecks: refuse,
        waitForReady: refuse,
        reset: refuse,
        discard: refuse,
        event: () => false,
        uploadTranscript: refuse,
        onEvent: none,
        onStatus: none,
        onMilestone: none,
        onChecks: none,
        onReady: none,
        requestFullscreen: async () => ({
            ok: false,
            reason: 'config_invalid',
        }),
        lockKeyboard: async () => ({ ok: false, reason: 'config_invalid' }),
        destroy: () => undefined,
    };
}

/** The descriptor setter of every session object, for the same-id map. */
const setters = new WeakMap<FittSession, (descriptor: Descriptor) => void>();

/** The same-id map: one session object per session id in this page. */
const sessions = new Map<string, FittSession>();

/** The session without the same-id map. Exported for session.test.ts. */
export function createSession(
    input: unknown,
    options: SessionOptions,
    seams: SessionSeams,
): FittSession {
    const read = readDescriptor(input);

    if (!read.ok) {
        return invalidSession({ path: read.path, reason: read.reason });
    }

    let descriptor = read.descriptor;
    const given = read.descriptor;
    const sessionId = descriptor.session_id;
    const warn = (message: string): void => console.warn(message);
    const settings = resolveSettings(descriptor, options, warn);
    const env = seams.env ?? browserEnvironment(options.environment);
    const { storage, page } = seams;
    const cap = descriptor.clock.session_cap_ms;

    // The clock starts now (spec 4.1): from the epoch every tab of the origin shares, or a new one.
    const syncEpoch = readNumber(storage, epochKey(sessionId));
    let inner: Clock =
        syncEpoch === null ? createClock(env) : createClock(env, syncEpoch);

    if (syncEpoch === null) {
        writeItem(storage, epochKey(sessionId), String(inner.epochMs));
    }

    /** Every module holds this one clock, so a re-created clock reaches them all. */
    const clock: Clock = {
        get epochMs(): number {
            return inner.epochMs;
        },
        now: () => inner.now(),
        anchorSource: () => inner.anchorSource(),
        check: () => inner.check(),
    };

    const statusListeners = listenerSet<SessionState>();
    const milestoneListeners = listenerSet<Milestone>();
    const checksListeners = listenerSet<ChecksResult>();
    const readyListeners = listenerSet<{ track: TrackName; url: string }>();
    const levelListeners = listenerSet<number>();
    const state = createState((next) => statusListeners.call(next));

    let store: QueueStore = new MemoryQueueStore();
    let record: SessionRecord | null = null;
    let batcher: Batcher | null = null;
    let token: TokenKeeper | null = null;
    let ladder: Ladder | null = null;
    let queue: Queue | null = null;
    let uploader: Uploader | null = null;
    let api: SessionApi | null = null;
    let lifecycle: Lifecycle | null = null;
    let engine: RecorderEngine | null = null;
    let stall: StallWatch | null = null;
    let stay: { arm(): void; disarm(): void } | null = null;
    let stopSignals: (() => void) | null = null;
    let pageListeners: (() => void)[] = [];
    let removeOnline: (() => void) | null = null;
    let tickTimer: number | null = null;

    /** Events raised before the batcher exists; they move onto the stored clock if it changes. */
    let early: SdkEvent[] = [];
    let localTake = descriptor.take;
    /** The take the lifecycle started last, for the stop bookkeeping. */
    let activeTake: number | null = null;
    let tombstoned = false;
    let tombstoning = false;
    let finalised = false;
    let destroyed = false;
    let heartbeats = false;
    let environmentSent = false;
    let storageReported = false;
    let lastEmittedError: ErrorCode | null = null;
    let preparing: Promise<void> | null = null;
    let deferredSealed = false;
    let pendingDescriptors: Descriptor[] = [];
    /** The record was read from the store, not created by this page. */
    let recordExisted = false;
    const runIndexes = new Map<string, number>();
    /** `${track}:${take}` of every manifest posted, for the abandon re-post (author's call 8). */
    const posted = new Set<string>();
    /** `${track}:${take}` the server answered sealed. */
    const sealed = new Set<string>();
    const manifestsInFlight = new Map<string, Promise<void>>();
    const repostWanted = new Set<string>();
    /** Tracks whose manifest stop() stopped waiting for on a network that blocks preflights. */
    const blockedTracks = new Set<TrackName>();

    // Previews and the stall watch (item 13).
    const previews: HTMLVideoElement[] = [];
    let own: HTMLVideoElement | null = null;
    let watched: HTMLVideoElement | null = null;
    let levelGraph: ReturnType<RecorderEngine['audio']> = null;
    let levelUnsubscribe: (() => void) | null = null;

    const bus = createEventBus({
        env,
        clock,
        groups: settings.groups,
        onQueued: (event) => {
            // A finished session queues nothing more: the last flush is behind it (item 10).
            // Listeners still see the event; no batch carries it.
            const sending = !tombstoned && !tombstoning;

            if (sending && batcher !== null) {
                batcher.add(event);
            } else if (sending) {
                early.push(event);
            }

            if (event.type.startsWith('upload.')) {
                refreshUpload();
            }
        },
    });
    const emit = (type: string, payload?: Record<string, unknown>): void => {
        bus.emit(type, payload);
    };

    // Record writes: one at a time, each the whole current record, so none is lost.
    let writes: Promise<void> = Promise.resolve();

    const persist = (): Promise<void> => {
        if (record === null) {
            return writes;
        }

        const copy: SessionRecord = {
            ...record,
            manifest_owed: { ...record.manifest_owed },
        };
        writes = writes
            .then(() => store.putSession(copy))
            .catch((error: unknown) => console.error(error));

        return writes;
    };

    const touch = (): void => {
        if (record === null) {
            return;
        }

        record.last_activity_ms = env.dateNow();
        record.max_session_ms = Math.max(record.max_session_ms, clock.now());
    };

    const setError = (
        code: ErrorCode,
        detail?: Record<string, unknown>,
    ): void => {
        const current = state.get().error;

        if (
            current?.code === code &&
            JSON.stringify(current.detail) === JSON.stringify(detail)
        ) {
            return;
        }

        state.patch({
            error: detail === undefined ? { code } : { code, detail },
        });
    };

    const clearError = (...codes: ErrorCode[]): void => {
        const current = state.get().error;

        if (current !== null && codes.includes(current.code)) {
            state.patch({ error: null });

            if (lastEmittedError === current.code) {
                lastEmittedError = null;
            }
        }
    };

    /** A capture or engine code: state.error, and session.error once per change (item 9). */
    const engineError = (code: ErrorCode): void => {
        setError(code);

        if (lastEmittedError !== code) {
            lastEmittedError = code;
            emit('session.error', { code });
        }
    };

    const refreshUpload = (): void => {
        const stats = uploader?.stats() ?? {
            bytesSent: 0,
            bytesTotal: 0,
            backlog: 0,
        };
        let tracksSealed = 0;

        for (const key of sealed) {
            if (key.endsWith(`:${localTake}`)) {
                tracksSealed += 1;
            }
        }

        const next = {
            ...stats,
            tracksSealed,
            sessionFinalised: finalised || tombstoned,
        };
        const current = state.get().upload;

        if (
            current.bytesSent !== next.bytesSent ||
            current.bytesTotal !== next.bytesTotal ||
            current.backlog !== next.backlog ||
            current.tracksSealed !== next.tracksSealed ||
            current.sessionFinalised !== next.sessionFinalised
        ) {
            state.patch({ upload: next });
        }
    };

    const reportStorage = (reason: 'open_failed' | 'quota'): void => {
        if (!storageReported) {
            storageReported = true;
            emit('upload.storage_unavailable', { reason });
        }
    };

    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            env.timers.setTimeout(resolve, Math.max(0, ms));
        });

    /** Deletes the local segments of every take below `take`. Run records hold no bytes and stay (the manifest filters by take). */
    const dropLocalTakesBelow = async (take: number): Promise<void> => {
        for (const segment of await store.listSegments(sessionId)) {
            if (segment.take < take) {
                await store.deleteSegment(segment);
            }
        }
    };

    // The purge sweep over every stored session (item 3).
    const purgeSweep = async (): Promise<void> => {
        const nowMs = env.dateNow();

        for (const stored of await store.listSessions()) {
            const plan = planResume(stored, nowMs);
            const own =
                stored.session_id.toLowerCase() === sessionId.toLowerCase();

            if (plan === 'purge' && own) {
                // The session being opened: its media is abandoned, its numbering is not.
                // A fresh next_batch_seq would replay seqs the server already holds,
                // and the server drops a replayed batch_seq as a no-op.
                await store.deleteSession(stored.session_id);
                await store.putSession({
                    ...stored,
                    take_start_ms: null,
                    take_open: false,
                    take_end_ms: null,
                    stop_completed: false,
                    manifest_owed: {},
                    finalised: false,
                    expires_at_ms: null,
                    last_activity_ms: nowMs,
                });
            } else if (plan === 'purge') {
                await store.deleteSession(stored.session_id);
                removeItem(storage, epochKey(stored.session_id));
                removeItem(storage, seqKey(stored.session_id));
            } else if (
                (plan === 'discard' || plan === 'reset') &&
                nowMs - stored.last_activity_ms >
                    stored.descriptor.queue.abandon_after_ms
            ) {
                // The owed call outlives the purge; its media does not (author's call 15).
                await store.deleteSession(stored.session_id);
                await store.putSession(stored);
            }
        }
    };

    /** Reads or creates the session record; true when it is a tombstone. */
    const loadRecord = async (): Promise<boolean> => {
        const nowMs = env.dateNow();
        const existing = await store.getSession(sessionId);

        if (
            existing !== undefined &&
            planResume(existing, nowMs) === 'tombstone'
        ) {
            record = existing;
            localTake = Math.max(existing.take, given.take);

            if (
                existing.descriptor.token.id.toLowerCase() >
                given.token.id.toLowerCase()
            ) {
                descriptor = existing.descriptor;
            }

            return true;
        }

        if (existing !== undefined) {
            // Merged, never replaced: only the descriptor (through the keeper),
            // its expiry and the activity time change.
            recordExisted = true;
            record = {
                ...existing,
                manifest_owed: { ...existing.manifest_owed },
                last_activity_ms: nowMs,
            };
            descriptor = existing.descriptor;

            if (
                existing.epoch_ms !== inner.epochMs ||
                existing.max_session_ms > inner.now()
            ) {
                // The localStorage copy was missing: the stored epoch wins, and
                // events raised on the provisional clock move onto it.
                const shift = inner.epochMs - existing.epoch_ms;
                inner = createClock(
                    env,
                    existing.epoch_ms,
                    existing.max_session_ms,
                );

                for (const event of early) {
                    event.t_ms += shift;
                }

                writeItem(storage, epochKey(sessionId), String(inner.epochMs));
            }
        } else {
            record = {
                session_id: sessionId,
                descriptor,
                epoch_ms: inner.epochMs,
                take: descriptor.take,
                take_start_ms: null,
                take_open: false,
                take_end_ms: null,
                next_batch_seq: 0,
                ladder_rung: settings.forcePost ? 'post' : 'put',
                ever_succeeded: false,
                stop_completed: false,
                rejected_take: null,
                pending_discard: false,
                last_activity_ms: nowMs,
                token_expires_at_ms:
                    nowMs + descriptor.token.expires_in_s * 1000,
                pending_reset_take: null,
                manifest_owed: {},
                max_session_ms: 0,
                finalised: false,
                expires_at_ms: null,
            };
            writeItem(storage, epochKey(sessionId), String(inner.epochMs));
        }

        localTake = Math.max(record.take, given.take);

        if (localTake > record.take) {
            // A later take is open on the server: the old one is closed here and never continued.
            record.take = localTake;
            record.take_open = false;
            record.take_start_ms = null;
            record.take_end_ms = null;
            record.stop_completed = false;
            record.manifest_owed = {};
            await dropLocalTakesBelow(localTake);
        }

        for (const run of await store.listRuns(sessionId)) {
            const key = `${run.track}:${run.take}`;
            runIndexes.set(
                key,
                Math.max(runIndexes.get(key) ?? 0, run.run_index + 1),
            );
        }

        await persist();

        return false;
    };

    /**
     * The token a finished session still reads with: the held one, never
     * refreshed. Its lapse ends the call with token_expired instead of a
     * wait for a refresh that a stopped keeper never makes.
     */
    const heldToken: Pick<TokenKeeper, 'current' | 'expired' | 'ready'> = {
        current: () =>
            token?.current() ?? {
                id: descriptor.token.id,
                secret: descriptor.token.secret,
            },
        expired: () => 'paused',
        ready: () => rejectWith('token_expired'),
    };

    /** The object a finalised session leaves: phase stopped, finalised, nothing running (item 10). */
    const becomeTombstone = (): void => {
        tombstoned = true;
        early = [];
        // No uploader, batcher or keeper; the status reads (checks, playback) still go.
        api = createSessionApi(
            env,
            () => descriptor,
            () => heldToken.current(),
        );
        state.patch({
            phase: 'stopped',
            upload: { ...state.get().upload, sessionFinalised: true },
        });
    };

    const finalisedRefusal = (): Promise<never> =>
        rejectWith('invalid_state', { reason: 'finalised' });

    const handleJump = (jump: ClockJump): void => {
        emit('session.clock_jump', { ...jump });

        if (lifecycle?.phase() === 'recording') {
            void engine?.restartRuns('clock_jump').catch(() => undefined);
        }

        lifecycle?.recheck();
        token?.check();
    };

    const checkClock = (): void => {
        const jump = clock.check();

        if (jump !== null) {
            handleJump(jump);
        }
    };

    const preflightsFail = (): boolean => {
        const code = state.get().error?.code;

        return (
            ladder?.rung() === 'post' ||
            code === 'token_refresh_blocked' ||
            code === 'network_blocked'
        );
    };

    /** One manifest answer: what it means for the track (item 5). */
    const settleManifest = async (
        track: TrackName,
        take: number,
        answer: WireAnswer,
    ): Promise<void> => {
        const key = `${track}:${take}`;
        const owed = (): void => {
            if (record?.manifest_owed[track] === take) {
                delete record.manifest_owed[track];
            }
        };

        if (isOk(answer)) {
            const body = answer.body as { track?: { sealed?: unknown } } | null;

            if (body?.track?.sealed === true) {
                sealed.add(key);
            }

            owed();
        } else {
            const verdict = classify(answer);
            const code =
                verdict.kind === 'terminal' || verdict.kind === 'ok'
                    ? verdict.code
                    : 'unknown';
            const status = verdict.kind === 'terminal' ? verdict.status : 0;

            if (verdict.kind === 'ok' || code === 'track_sealed') {
                sealed.add(key);
                owed();
            } else if (
                status === 409 &&
                ['stale_take', 'session_closed', 'discarded'].includes(code)
            ) {
                // stale_take: that take's manifest is dropped. session_closed and discarded close the session (Task 15a).
                owed();
            } else {
                // The track stays unsealed until the server's IdleClose.
                setError('manifest_rejected', { track, code });
            }
        }

        blockedTracks.delete(track);

        if (
            blockedTracks.size === 0 &&
            state.get().error?.code === 'manifests_blocked'
        ) {
            clearError('manifests_blocked');
        }

        await persist();
        refreshUpload();
    };

    /**
     * Builds and posts one track's manifest for `take` until a final
     * answer. Resolves 'blocked' early when two online network errors in a
     * row show a network that blocks preflights; the post goes on.
     */
    const postManifest = (
        track: ChunkedTrack,
        take: number,
        endMs: number,
    ): Promise<'answered' | 'blocked'> => {
        const key = `${track.track}:${take}`;
        let escape!: () => void;
        const escaped = new Promise<'blocked'>((resolve) => {
            escape = () => resolve('blocked');
        });
        let failures = 0;

        const final = (async (): Promise<void> => {
            const runs = (await store.listRuns(sessionId)).filter(
                (run) => run.track === track.track,
            );
            const segments = (await store.listSegments(sessionId)).filter(
                (segment) => segment.track === track.track,
            );
            const body = buildManifest({
                take,
                takeStartMs: record?.take_start_ms ?? null,
                endMs,
                partSize: track.segments.part_size,
                runs,
                segments,
            });
            posted.add(key);
            let attempt = 0;
            const call = async (): Promise<WireAnswer> => {
                const answer = await api!.postManifest(track.track, body);

                if (answer.networkError && !answer.timedOut) {
                    if (env.online()) {
                        failures += 1;
                    }
                } else if (answer.status > 0) {
                    failures = 0;
                }

                if (failures >= MANIFEST_BLOCKED_AFTER && preflightsFail()) {
                    escape();
                }

                return answer;
            };

            for (;;) {
                const answer = await callWithRetry(
                    {
                        env,
                        token: token!,
                        onSuccess: () => ladder?.markSucceeded(),
                    },
                    call,
                );
                const verdict = isOk(answer) ? null : classify(answer);

                if (
                    verdict !== null &&
                    (verdict.kind === 'blocked' || verdict.kind === 'step_down')
                ) {
                    // JSON calls have no POST rung: back off and keep the manifest owed.
                    attempt += 1;
                    await sleep(backoffMs(attempt, env.random()));

                    continue;
                }

                await settleManifest(track.track, take, answer);

                return;
            }
        })();

        const tracked = final
            .catch((error: unknown) => console.error(error))
            .finally(() => {
                manifestsInFlight.delete(key);

                if (repostWanted.delete(key)) {
                    repost(track.track, take);
                }
            });
        manifestsInFlight.set(key, tracked);

        return Promise.race([tracked.then(() => 'answered' as const), escaped]);
    };

    /** Posts the track's full manifest for that take again, after the post in flight if there is one. */
    const repost = (track: TrackName, take: number): void => {
        const key = `${track}:${take}`;
        const described = chunkedTracks(descriptor).find(
            (each) => each.track === track,
        );

        const endMs = record?.take_end_ms ?? null;

        if (described === undefined || sealed.has(key) || endMs === null) {
            return;
        }

        if (manifestsInFlight.has(key)) {
            repostWanted.add(key);

            return;
        }

        void postManifest(described, take, endMs);
    };

    /** Seals the take's tracks: take_end_ms first, then each manifest, owed until answered (item 5). */
    const sealTracks = async (endMs: number): Promise<void> => {
        const take = activeTake ?? localTake;

        if (record === null) {
            return;
        }

        record.take_end_ms = endMs;
        await persist();

        if (take < localTake) {
            // The server moved on to a newer take: this one is gone.
            return;
        }

        const runs = await store.listRuns(sessionId);
        const tracks = chunkedTracks(descriptor).filter((track) =>
            runs.some((run) => run.track === track.track && run.take === take),
        );

        for (const track of tracks) {
            record.manifest_owed[track.track] = take;
        }

        await persist();
        const results = await Promise.all(
            tracks.map((track) => postManifest(track, take, endMs)),
        );
        const blocked = tracks
            .filter((_, index) => results[index] === 'blocked')
            .map((track) => track.track)
            .filter((track) => record?.manifest_owed[track] === take);

        if (blocked.length > 0) {
            for (const track of blocked) {
                blockedTracks.add(track);
            }

            setError('manifests_blocked', { tracks: [...blockedTracks] });
        }
    };

    /** A stale_take for the current local take: the server is on `current` (item 5). */
    const adoptTake = async (current: number): Promise<void> => {
        if (record === null || current <= localTake) {
            return;
        }

        localTake = current;
        record.take = current;
        record.take_open = false;
        record.take_start_ms = null;
        record.take_end_ms = null;
        record.stop_completed = false;
        record.manifest_owed = {};
        void persist();
        uploader?.dropTakesBelow(current);
        setError('stale_take');
        const phase = lifecycle?.phase();

        if (
            phase === 'countdown' ||
            phase === 'recording' ||
            phase === 'ready'
        ) {
            lifecycle?.setPhase('stopped');
        }

        await engine?.stopTake().catch(() => undefined);
        await dropLocalTakesBelow(current);
    };

    /** A finished session: stopped, every segment settled, finalised. Leaves the tombstone (item 10). */
    const maybeTombstone = async (): Promise<void> => {
        if (
            !finalised ||
            tombstoned ||
            tombstoning ||
            record === null ||
            lifecycle?.phase() !== 'stopped' ||
            (uploader?.stats().backlog ?? 0) > 0
        ) {
            return;
        }

        tombstoning = true;
        stopTick();
        await batcher?.flush().catch((error: unknown) => console.error(error));
        batcher?.stop();
        // No signal, pagehide or online listener may freeze or send a batch after the last flush.
        detachPage();
        removeOnline?.();
        removeOnline = null;
        await token?.stop();
        await uploader?.stop();
        const tombstone: SessionRecord = {
            ...record,
            manifest_owed: {},
            finalised: true,
            expires_at_ms: record.token_expires_at_ms + TOMBSTONE_MARGIN_MS,
        };
        record = tombstone;
        await writes;
        // deleteSession takes the runs, segments and batches with it; the record comes back as the tombstone.
        await store.deleteSession(sessionId);
        await store.putSession(tombstone);
        tombstoned = true;
        refreshUpload();
    };

    const tick = (): void => {
        tickTimer = env.timers.setTimeout(tick, TICK_MS);
        checkClock();
        token?.check();
        refreshUpload();

        if (
            record !== null &&
            env.dateNow() - record.last_activity_ms >= ACTIVITY_MS
        ) {
            touch();
            void persist();
        }

        void maybeTombstone();
    };

    function stopTick(): void {
        if (tickTimer !== null) {
            env.timers.clearTimeout(tickTimer);
            tickTimer = null;
        }
    }

    // Previews and the stall watch (item 13).
    const watch = (video: HTMLVideoElement | null): void => {
        watched = video;
        stall?.setVideo(video);
    };

    const dropOwn = (): void => {
        const element = own;
        own = null;

        if (element !== null) {
            element.srcObject = null;
            element.remove();
        }

        if (watched === element && element !== null) {
            watch(null);
        }
    };

    const ensureOwn = (): HTMLVideoElement | null => {
        if (own !== null) {
            return own;
        }

        const doc = page?.doc;

        if (
            typeof doc?.createElement !== 'function' ||
            doc.body === undefined ||
            doc.body === null
        ) {
            return null;
        }

        const element = doc.createElement('video');
        element.muted = true;
        element.playsInline = true;
        element.autoplay = true;
        element.setAttribute('playsinline', '');
        element.setAttribute('style', OWN_VIDEO_STYLE);
        element.srcObject = engine?.stream ?? null;
        doc.body.appendChild(element);
        void Promise.resolve()
            .then(() => element.play())
            .catch(() => undefined);
        own = element;

        return element;
    };

    /** The most recent connected preview, else the session's own element while capture is live. */
    const repick = (): void => {
        const preview = [...previews].reverse().find(isConnected);

        if (preview !== undefined) {
            dropOwn();
            watch(preview);

            return;
        }

        watch(engine?.stream ? ensureOwn() : null);
    };

    const subscribeLevel = (): void => {
        const graph = engine?.audio() ?? null;

        if (graph === levelGraph) {
            return;
        }

        levelUnsubscribe?.();
        levelGraph = graph;
        levelUnsubscribe =
            graph?.onLevel((level) => levelListeners.call(level)) ?? null;
    };

    const onStream = (stream: MediaStream | null): void => {
        for (const video of previews) {
            video.srcObject = stream;
        }

        subscribeLevel();

        if (stream === null) {
            stall?.stop();
            dropOwn();

            return;
        }

        if (own !== null) {
            own.srcObject = stream;
        }

        if (watched === null || !isConnected(watched)) {
            repick();
        }

        if (!destroyed) {
            stall?.start();
        }
    };

    const attachPage = (): void => {
        if (page === null || stopSignals !== null) {
            return;
        }

        stopSignals = startSignals({
            page,
            env,
            clock,
            emit: bus.emit,
            idleMs: settings.idleMs,
            resizeDebounceMs: settings.resizeDebounceMs,
        });
        const listen = (
            target: EventTarget | null | undefined,
            type: string,
            handler: () => void,
        ): void => {
            if (target === null || target === undefined) {
                return;
            }

            target.addEventListener(type, handler);
            pageListeners.push(() => target.removeEventListener(type, handler));
        };

        // iOS often fires no pagehide, so a hidden page flushes too (item 12).
        listen(page.win, 'pagehide', () => batcher?.pagehide());
        listen(page.doc, 'visibilitychange', () => {
            if (page.doc.visibilityState === 'hidden') {
                batcher?.pagehide();
            } else {
                checkClock();
                token?.check();
            }
        });
    };

    const detachPage = (): void => {
        stopSignals?.();
        stopSignals = null;
        stay?.disarm();
        stall?.stop();
        dropOwn();

        for (const remove of pageListeners) {
            remove();
        }

        pageListeners = [];
    };

    const onPhase = (phase: Phase): void => {
        state.patch({ phase });

        if (phase === 'recording') {
            stay?.arm();
        } else {
            stay?.disarm();
        }

        if (
            record !== null &&
            phase === 'stopped' &&
            activeTake === localTake
        ) {
            record.take_open = false;
            record.stop_completed = true;
            record.take_end_ms =
                record.take_end_ms ?? lifecycle?.unsealedEndMs() ?? null;
            void persist();
        }

        if (record !== null && phase === 'ready' && record.take_open) {
            // The too_short path: the take was reset and nothing is open.
            record.take_open = false;
            void persist();
        }

        refreshUpload();
        void maybeTombstone();
    };

    const onMilestone = (milestone: Milestone): void => {
        if (milestone.name === 'started' && record !== null) {
            activeTake = localTake;
            deferredSealed = false;
            record.take_open = true;
            record.stop_completed = false;
            record.take_start_ms = milestone.t_ms;
            record.take_end_ms = null;
            void persist();
        }

        emit('recorder.milestone', {
            name: milestone.name,
            ...(milestone.remaining_ms === undefined
                ? {}
                : { remaining_ms: milestone.remaining_ms }),
            ...(milestone.reason === undefined
                ? {}
                : { reason: milestone.reason }),
        });
        milestoneListeners.call(milestone);
    };

    /** The engine's onError: a code sets the error; null clears what the engine recovered from. */
    const onEngineError = (code: ErrorCode | null): void => {
        if (code === null) {
            clearError(...RECOVERED_CODES);

            return;
        }

        engineError(code);
        const phase = lifecycle?.phase();

        if (
            PHASE_ERRORS.has(code) &&
            (phase === 'recording' || phase === 'ready')
        ) {
            lifecycle?.setPhase('error');
        }
    };

    /** Every cut: stored, then handed to the uploader; the clock and the limits are read again. */
    const addSegment = async (segment: SegmentRecord): Promise<unknown> => {
        if (segment.take < localTake || queue === null) {
            return 'dropped';
        }

        const result = await queue.add(segment);

        if (segment.take < localTake) {
            // The take was adopted away while this segment was stored.
            await store.deleteSegment(segment);

            return 'dropped';
        }

        if (result === 'stored') {
            uploader?.enqueue(segment);
        }

        touch();
        void persist();
        checkClock();
        lifecycle?.recheck();

        return result;
    };

    const unsupportedEngine: TakeEngine = {
        startTake: () => rejectWith('recorder_unsupported'),
        stopTake: async () => undefined,
    };

    const recordingLimits = (): RecordingLimits =>
        descriptor.recording ?? {
            countdown_ms: 0,
            min_duration_ms: 0,
            max_duration_ms: cap,
            extension_ms: 0,
            warning_before_end_ms: 0,
        };

    /** Builds the pipeline over the stored record, in the plan's order (item 5). */
    const build = (): void => {
        const held = record as SessionRecord;
        api = createSessionApi(
            env,
            () => descriptor,
            () => token!.current(),
        );
        const eventsUrl = (): string =>
            `${descriptor.endpoints.api}/sessions/${descriptor.session_id}/events`;

        ladder = createLadder({
            rung: held.ladder_rung,
            everSucceeded: held.ever_succeeded,
            forcePost: settings.forcePost,
            persist: async (rung, everSucceeded) => {
                if (record !== null) {
                    record.ladder_rung = rung;
                    record.ever_succeeded = everSucceeded;
                }

                await persist();
            },
            emit,
            onBlocked: () => setError('network_blocked'),
            onUnblocked: () => clearError('network_blocked'),
        });

        token = createTokenKeeper({
            env,
            descriptor,
            receivedAtMs: recordExisted
                ? held.token_expires_at_ms -
                  descriptor.token.expires_in_s * 1000
                : env.dateNow(),
            refresh: async (used) => {
                const answer = await api!.refresh(used);

                if (answer.status === 201) {
                    ladder?.markSucceeded();
                }

                return answer;
            },
            onDescriptor: (next) => {
                descriptor = next;

                if (record !== null) {
                    record.descriptor = next;
                    record.token_expires_at_ms =
                        env.dateNow() + next.token.expires_in_s * 1000;
                }

                void persist();
            },
            emit,
            setError: (code) => {
                if (code === null) {
                    clearError('token_expired', 'token_refresh_blocked');
                } else {
                    setError(code);
                }
            },
        });

        // A descriptor handed in before the record was read: the keeper decides.
        token.set(given);

        for (const later of pendingDescriptors) {
            token.set(later);
        }

        pendingDescriptors = [];

        batcher = createBatcher({
            env,
            clock,
            store,
            sessionId,
            take: () => localTake,
            nextBatchSeq: held.next_batch_seq,
            batchMs: descriptor.events.batch_ms,
            token,
            send: async (body, keepalive, used) => {
                const answer = await send(
                    env,
                    eventsRequest(eventsUrl(), used, body, keepalive),
                );

                if (isOk(answer)) {
                    ladder?.markSucceeded();
                }

                return answer;
            },
            persistNextBatchSeq: async (next) => {
                if (record !== null) {
                    record.next_batch_seq = Math.max(
                        record.next_batch_seq,
                        next,
                    );
                    touch();
                }

                await persist();
            },
            persistNextBatchSeqSync: (next) =>
                writeItem(storage, seqKey(sessionId), String(next)),
            readNextBatchSeqSync: () => readNumber(storage, seqKey(sessionId)),
            // Closing on session_closed and discarded is Task 15a.
            onClosed: () => undefined,
            onRejected: (rejection) => {
                console.warn(
                    `Fitt Video: event batch ${rejection.batch_seq} was refused (${rejection.code}).`,
                );
                setError('events_rejected', {
                    batch_seq: rejection.batch_seq,
                    code: rejection.code,
                });
            },
            onClockJump: handleJump,
        });

        for (const event of early) {
            batcher.add(event);
        }

        early = [];

        queue = createQueue(store, {
            abandonAfterMs: descriptor.queue.abandon_after_ms,
            budgetBytes: descriptor.queue.buffer_budget_bytes,
            perfNow: () => env.perfNow(),
        });

        uploader = createUploader({
            env,
            store,
            queue,
            now: () => clock.now(),
            tracks: () => descriptor.tracks,
            token,
            ladder,
            emit,
            onAbandon: (track, take) => {
                const phase = lifecycle?.phase();

                if (
                    posted.has(`${track}:${take}`) &&
                    take === localTake &&
                    (phase === 'stopping' || phase === 'stopped')
                ) {
                    repost(track, take);
                }
            },
            currentTake: () => localTake,
            onTakeBehind: (current) => {
                void adoptTake(current).catch((error: unknown) =>
                    console.error(error),
                );
            },
            warn,
        });

        const detector = createSilenceDetector({
            level: settings.silenceLevel,
            noAudioMs: settings.noAudioMs,
            emit,
            onState: (audio) => state.patch({ audio }),
        });
        const tracks = chunkedTracks(descriptor);

        if (seams.media !== null) {
            engine = createRecorderEngine({
                env,
                clock,
                sessionId,
                take: () => localTake,
                tracks,
                media: seams.media,
                recorderFactory: seams.recorderFactory,
                isTypeSupported: seams.isTypeSupported,
                bitrates: (track) =>
                    settings.bitrates[track.track] ?? {
                        video: track.capture.video?.bitrate_bps,
                        audio: track.capture.audio.bitrate_bps,
                    },
                cameraAudio: (stream) => stream.getAudioTracks(),
                createAudioContext: seams.createAudioContext,
                onSample: (level, tMs) =>
                    detector.sample(level, tMs, lifecycle?.phase() ?? 'idle'),
                makeStream: seams.makeStream,
                permissions: seams.permissions,
                nextRunIndex: (track) => {
                    const key = `${track}:${localTake}`;
                    const next = runIndexes.get(key) ?? 0;
                    runIndexes.set(key, next + 1);

                    return next;
                },
                add: addSegment,
                putRun: async (run) => {
                    if (run.take >= localTake) {
                        await store.putRun(run);
                    }
                },
                emit,
                onError: onEngineError,
                ua: page?.nav?.userAgent ?? '',
                doc:
                    page?.doc ??
                    Object.assign(new EventTarget(), {
                        visibilityState: 'visible',
                    }),
                onStream,
            });
        }

        lifecycle = createLifecycle({
            env,
            clock,
            recording: recordingLimits(),
            sessionCapMs: cap,
            engine: engine ?? unsupportedEngine,
            // The reset call is Task 15a; until then the too_short path resets at once.
            resetTake: async () => undefined,
            sealTracks,
            onMilestone,
            onPhase,
            onError: (code) => setError(code),
            warn,
        });

        const camera = tracks.find((track) => track.track === 'camera');

        if (page !== null && camera !== undefined) {
            stall = createStallWatch({
                env,
                clock,
                video: watched,
                frameRate: camera.capture.video?.frame_rate ?? 30,
                doc: page.doc,
                emit: (type, payload) => {
                    if (
                        watched !== null &&
                        watched !== own &&
                        !isConnected(watched)
                    ) {
                        // A removed preview is paused: no frame says nothing about the camera.
                        repick();

                        return;
                    }

                    emit(type, payload);
                },
            });
        }

        if (page !== null && settings.stayOnPage !== null) {
            stay = createStayOnPage({
                page,
                env,
                clock,
                graceMs: settings.stayOnPage.graceMs,
                emit: bus.emit,
                forceStop: () => {
                    void lifecycle
                        ?.stop({ forced: 'left_page' })
                        .catch((error: unknown) =>
                            warn(`The forced stop failed: ${String(error)}`),
                        );
                },
            });
        }

        const onOnline = (): void => token?.check();
        const onlineTarget = env.onlineTarget;
        onlineTarget?.addEventListener('online', onOnline);
        removeOnline = () =>
            onlineTarget?.removeEventListener('online', onOnline);

        if (!destroyed) {
            attachPage();
        }

        uploader.start();
        batcher.startTimer({ emptyHeartbeats: false });
        tickTimer = env.timers.setTimeout(tick, TICK_MS);
    };

    const ready: Promise<void> = (async () => {
        if (seams.store !== undefined) {
            store = seams.store;
        } else {
            const opened = await openStore(seams.indexedDB, (reason) =>
                reportStorage(reason),
            );
            store = opened.store;

            if (opened.unavailable !== undefined) {
                reportStorage(opened.unavailable);
            }
        }

        await purgeSweep();

        if (await loadRecord()) {
            becomeTombstone();

            return;
        }

        build();
    })();
    ready.catch((error: unknown) =>
        console.error('Fitt Video: the session could not start.', error),
    );

    const emitEnvironment = (withLabels: boolean): void => {
        if (environmentSent) {
            return;
        }

        environmentSent = true;
        const extra: Record<string, unknown> = { sdk_version: VERSION };

        if (withLabels && engine !== null) {
            const devices = engine.devices();
            extra.cameras = devices.cameras.map((device) => device.label);
            extra.microphones = devices.microphones.map(
                (device) => device.label,
            );
        }

        emit(
            'session.environment',
            page === null ? extra : environmentSnapshot(page, extra),
        );
    };

    const doPrepare = async (): Promise<void> => {
        const life = lifecycle as Lifecycle;

        if (engine === null) {
            engineError('recorder_unsupported');
            life.setPhase('error');
            emitEnvironment(false);

            throw new FittVideoError('recorder_unsupported');
        }

        life.setPhase('preparing');

        try {
            await engine.prepare();
        } catch (error) {
            const code = codeOf(error);

            if (code !== null && isErrorCode(code)) {
                engineError(code);
            }

            life.setPhase(
                code !== null && PHASE_ERRORS.has(code) ? 'error' : 'idle',
            );
            emitEnvironment(false);

            throw error;
        }

        clearError(...CAPTURE_CODES);
        life.setPhase('ready');
        emitEnvironment(true);
    };

    const devices: DevicesView = {
        get cameras(): MediaDeviceInfo[] {
            return engine?.devices().cameras ?? [];
        },
        get microphones(): MediaDeviceInfo[] {
            return engine?.devices().microphones ?? [];
        },
        get selected(): Selection {
            return engine?.devices().selected ?? {};
        },
        async select(kind, deviceId): Promise<void> {
            await ready;

            if (engine === null) {
                throw new FittVideoError('recorder_unsupported');
            }

            await engine.devices().select(kind, deviceId);
        },
    };

    const created: FittSession = {
        id: sessionId,
        get state(): SessionState {
            return state.get();
        },
        get stream(): MediaStream | null {
            return engine?.stream ?? null;
        },
        devices,
        get audioLevel(): number {
            return engine?.audio()?.level() ?? 0;
        },
        ...(options.debug === true
            ? {
                  debug: {
                      dropNextSegment(track?: TrackName): void {
                          uploader?.dropNext(track);
                      },
                  },
              }
            : {}),

        async prepare(): Promise<void> {
            await ready;

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            if (destroyed) {
                destroyed = false;
                attachPage();
            }

            const phase = (lifecycle as Lifecycle).phase();

            if (
                phase === 'countdown' ||
                phase === 'recording' ||
                phase === 'stopping' ||
                phase === 'stopped' ||
                phase === 'rejected' ||
                (phase === 'ready' && engine?.stream !== null)
            ) {
                return;
            }

            preparing ??= doPrepare().finally(() => {
                preparing = null;
            });

            return preparing;
        },

        attachPreview(video, previewOptions = {}): void {
            const at = previews.indexOf(video);

            if (at !== -1) {
                previews.splice(at, 1);
            }

            previews.push(video);
            video.srcObject = engine?.stream ?? null;
            video.muted = true;
            video.playsInline = true;
            video.autoplay = true;

            if (previewOptions.mirror !== false) {
                video.style.transform = 'scaleX(-1)';
            }

            void Promise.resolve()
                .then(() => video.play())
                .catch(() => undefined);
            dropOwn();
            watch(video);
        },

        detachPreview(video): void {
            const at = previews.indexOf(video);

            if (at === -1) {
                return;
            }

            previews.splice(at, 1);

            if (watched === video) {
                repick();
            }
        },

        mixAudio(source): void {
            const graph = engine?.audio() ?? null;

            if (graph === null) {
                warn(
                    'Fitt Video: mixAudio() needs prepare() first; nothing was mixed.',
                );

                return;
            }

            graph.mix(source);
        },

        onAudioLevel(listener): () => void {
            subscribeLevel();

            return levelListeners.add(listener);
        },

        now: () => clock.now(),

        async start(): Promise<void> {
            await ready;

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            const life = lifecycle as Lifecycle;
            const phase = life.phase();

            if (phase === 'idle' || phase === 'preparing') {
                await created.prepare();
            }

            if (!heartbeats) {
                // Empty heartbeats go from the first start() to finalise (author's call 11).
                heartbeats = true;
                batcher?.startTimer({ emptyHeartbeats: true });
            }

            try {
                await life.start();
            } catch (error) {
                const code = codeOf(error);

                if (code !== null && PHASE_ERRORS.has(code)) {
                    life.setPhase('error');
                }

                if (
                    record !== null &&
                    record.take_open &&
                    life.phase() !== 'recording'
                ) {
                    record.take_open = false;
                    void persist();
                }

                throw error;
            }
        },

        async stop(stopOptions = {}): Promise<void> {
            await ready;

            if (tombstoned) {
                return;
            }

            await (lifecycle as Lifecycle).stop(stopOptions);
            await writes;
        },

        async finalise(): Promise<void> {
            await ready;

            if (tombstoned) {
                return;
            }

            const life = lifecycle as Lifecycle;
            const phase = life.phase();

            if (phase === 'stopping') {
                await life.stop();
            } else if (phase === 'countdown' || phase === 'recording') {
                return rejectWith('invalid_state', { phase });
            }

            const unsealed = life.unsealedEndMs();

            if (unsealed !== null && !deferredSealed) {
                deferredSealed = true;
                await sealTracks(unsealed);
            }

            await batcher?.flush();
            const held = record as SessionRecord;
            // The take's real end, so a wait for checks never adds a black, silent tail (spec 4.4).
            const endMs = Math.min(held.take_end_ms ?? clock.now(), cap);
            const answer = await callWithRetry(
                {
                    env,
                    token: token!,
                    onSuccess: () => ladder?.markSucceeded(),
                },
                () => api!.finalise(endMs),
            );

            if (!isOk(answer)) {
                const verdict = classify(answer);

                return rejectWith('invalid_state', {
                    reason:
                        verdict.kind === 'terminal' ? verdict.code : 'refused',
                    status: answer.status,
                });
            }

            finalised = true;

            if (life.phase() !== 'stopped') {
                // Finalised with no stopped take (from idle, ready or error):
                // nothing more is recorded into it, and it becomes the tombstone.
                await preparing?.catch(() => undefined);
                life.setPhase('stopped');
            }

            refreshUpload();
            void maybeTombstone();

            if (settings.checksWait) {
                await created.waitForChecks();
            }
        },

        async waitForChecks(checkOptions = {}): Promise<ChecksResult> {
            // A finished session still polls with the held token (item 10).
            await ready;

            // The shared poll, the rejected phase and the cancel on reset are Task 15a.
            return pollChecks(
                {
                    env,
                    status: () => api!.status(),
                    take: () => localTake,
                    onChecks: (result) => {
                        state.patch({ checks: result });
                        checksListeners.call(result);
                    },
                },
                checkOptions.timeoutMs ?? settings.checksTimeoutMs,
            );
        },

        async waitForReady(readyOptions): Promise<string> {
            // Playback exists only once a finalised session was processed: a tombstone polls too.
            await ready;

            const url = await pollReady(
                { env, status: () => api!.status() },
                readyOptions.track,
                readyOptions.timeoutMs,
            );
            readyListeners.call({ track: readyOptions.track, url });

            return url;
        },

        async reset(): Promise<void> {
            await ready;

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            // The reset call and its bookkeeping are Task 15a.
            return rejectWith('invalid_state', { reason: 'not_available' });
        },

        async discard(): Promise<void> {
            await ready;

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            // The discard call and closing are Task 15a.
            return rejectWith('invalid_state', { reason: 'not_available' });
        },

        event(type, payload): boolean {
            return tombstoned ? false : bus.host(type, payload);
        },

        async uploadTranscript(upload): Promise<void> {
            const body = transcriptBody(upload);
            await ready;
            // A transcript often comes after finalise: a finished session sends it with the held token.
            const answer = await callWithRetry(
                {
                    env,
                    token: tombstoned || tombstoning ? heldToken : token!,
                    onSuccess: () => ladder?.markSucceeded(),
                },
                () => api!.transcript(body),
            );

            if (!isOk(answer)) {
                const verdict = classify(answer);

                return rejectWith('invalid_state', {
                    reason:
                        verdict.kind === 'terminal' ? verdict.code : 'refused',
                    status: answer.status,
                });
            }
        },

        onEvent: (listener) => bus.on(listener),
        onStatus: (listener) => statusListeners.add(listener),
        onMilestone: (listener) => milestoneListeners.add(listener),
        onChecks: (listener) => checksListeners.add(listener),
        onReady: (listener) => readyListeners.add(listener),

        async requestFullscreen(target?: Element): Promise<ActionResult> {
            if (page === null) {
                return { ok: false, reason: 'not_supported' };
            }

            return requestFullscreen(
                target ??
                    (page.doc.documentElement as unknown as
                        Element | undefined) ??
                    null,
                page.doc as unknown as Document,
            );
        },

        async lockKeyboard(): Promise<ActionResult> {
            if (page === null) {
                return { ok: false, reason: 'not_supported' };
            }

            return lockKeyboard(
                (page.nav ?? null) as unknown as Navigator | null,
                page.doc as unknown as Document,
            );
        },

        destroy(): void {
            destroyed = true;
            engine?.release();
            detachPage();
        },
    };

    setters.set(created, (next) => {
        if (tombstoned) {
            return;
        }

        if (token === null) {
            pendingDescriptors.push(next);

            return;
        }

        // The keeper persists it only when its token is newer (author's call 10).
        token.set(next);
    });

    return created;
}

/** createSession() plus the module-level same-id map. Exported so session.test.ts never reaches the real globals. */
export function sessionWith(
    descriptor: unknown,
    options: SessionOptions,
    seams: SessionSeams,
): FittSession {
    const read = readDescriptor(descriptor);

    if (!read.ok) {
        return createSession(descriptor, options, seams);
    }

    const key = read.descriptor.session_id.toLowerCase();
    const existing = sessions.get(key);

    if (existing !== undefined) {
        setters.get(existing)?.(read.descriptor);

        return existing;
    }

    const created = createSession(read.descriptor, options, seams);
    sessions.set(key, created);

    return created;
}

/** Reads every global through globalThis behind a typeof check, when called. With no document (Node, SSR): media and page are null. */
export function browserSeams(): SessionSeams {
    if (typeof document === 'undefined') {
        return {
            media: null,
            recorderFactory: () => {
                throw new ReferenceError('MediaRecorder is not defined');
            },
            makeStream: () => {
                throw new ReferenceError('MediaStream is not defined');
            },
            isTypeSupported: () => false,
            permissions: undefined,
            page: null,
            createAudioContext: null,
            storage: null,
            indexedDB: undefined,
        };
    }

    let storage: SessionSeams['storage'] = null;

    try {
        storage = window.localStorage;
    } catch {
        // Blocked site data: the epoch and the batch seq live in IndexedDB only.
    }

    const media =
        typeof navigator !== 'undefined' && navigator.mediaDevices !== undefined
            ? navigator.mediaDevices
            : null;

    return {
        media,
        recorderFactory: (stream, recorderOptions) =>
            new MediaRecorder(stream, recorderOptions),
        makeStream: (tracks) => new MediaStream(tracks),
        isTypeSupported: (type) =>
            typeof MediaRecorder !== 'undefined' &&
            MediaRecorder.isTypeSupported(type),
        permissions:
            typeof navigator === 'undefined'
                ? undefined
                : navigator.permissions,
        page: {
            win: window,
            doc: document,
            nav: navigator,
        } as unknown as PageLike,
        createAudioContext:
            typeof AudioContext === 'undefined'
                ? null
                : () => new AudioContext(),
        storage,
        indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    };
}

/** sessionWith(descriptor, options, browserSeams()). Synchronous and never throws: an invalid descriptor gives a session in phase 'error' with config_invalid. */
export function session(
    descriptor: unknown,
    options: SessionOptions = {},
): FittSession {
    return sessionWith(descriptor, options, browserSeams());
}
