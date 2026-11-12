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
    startsDirect,
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
    CAP_MARGIN_MS,
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
import {
    createLocalCopy,
    dropPageCopy,
    type LocalCopy,
    type ObjectUrls,
} from './review.ts';
import {
    createState,
    type Phase,
    type PlaybackState,
    type SessionState,
} from './state.ts';
import {
    MemoryQueueStore,
    openStore,
    type QueueStore,
    type RunEndedReason,
    type RunRecord,
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
    readonly debug?: {
        dropNextSegment(track?: TrackName): void;
        /** Starts a second run on the open take, as a camera switch would (the playground's multi-run case, Plan 9). */
        restartRun(reason?: RunEndedReason): Promise<void>;
    };
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
    /** Releases capture and listeners; the lock, the channel, the queue and the map entry stay (author's calls 12 and 15). */
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
    /** navigator.locks: one owning tab per session (author's call 15). null: every session owns its id. */
    locks: Pick<LockManager, 'request' | 'query'> | null;
    /** URL.createObjectURL and revokeObjectURL for the review copy (Plan 9); null: no copy (unsupported). */
    objectUrls?: ObjectUrls | null;
    /** BroadcastChannel: the relay between a second tab and the owner. null outside a browser. */
    channel:
        | ((
              name: string,
          ) => Pick<
              BroadcastChannel,
              'postMessage' | 'addEventListener' | 'close'
          >)
        | null;
}

type StorageView = SessionSeams['storage'];

/**
 * How resume() opens a stored session (Task 15b, author's call 15). Not part
 * of the public API. The session it opens is passive: it captures nothing
 * and listens to no page until the host re-attaches with
 * FittVideo.session(descriptor) or calls prepare().
 */
export interface ResumeOpening {
    /** 'finalise' drains the queue, then finalises with the stored take end; 'drain' only drains. */
    resume: 'drain' | 'finalise';
}

/** What build() starts: everything, the queue and the batches only, or nothing (an owed discard). */
type BuildMode = 'full' | 'drain' | 'none';

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

/** The storage key of a session's epoch copy (shared by every tab of the origin). */
export const epochKey = (sessionId: string): string =>
    `fitt-video:${sessionId}:epoch`;
/** The storage key of a session's synchronous next_batch_seq copy. */
export const seqKey = (sessionId: string): string =>
    `fitt-video:${sessionId}:next_batch_seq`;

export function readNumber(storage: StorageView, key: string): number | null {
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

export function writeItem(
    storage: StorageView,
    key: string,
    value: string,
): void {
    try {
        storage?.setItem(key, value);
    } catch {
        // A full or blocked localStorage: IndexedDB still holds the value.
    }
}

export function removeItem(storage: StorageView, key: string): void {
    try {
        storage?.removeItem(key);
    } catch {
        // Nothing to do: the key ages out with the origin's storage.
    }
}

/** The Web Lock and BroadcastChannel name of a session (author's call 15). */
export const lockName = (sessionId: string): string =>
    `fitt-video:${sessionId.toLowerCase()}`;

/**
 * Runs `work` inside the session's Web Lock when no tab holds it, and says
 * whether it ran. Without locks it always runs. The purge sweep and resume()
 * delete through it, so a session a live tab holds is never deleted.
 */
export async function underLock(
    locks: SessionSeams['locks'],
    sessionId: string,
    work: () => Promise<void>,
): Promise<boolean> {
    if (locks === null) {
        await work();

        return true;
    }

    let granted = false;
    let entered = false;

    try {
        await locks.request(
            lockName(sessionId),
            { ifAvailable: true },
            async (lock) => {
                entered = true;

                if (lock === null) {
                    return;
                }

                granted = true;
                await work();
            },
        );
    } catch (error) {
        if (entered) {
            throw error;
        }

        // The Lock API is there but refuses every request (a sandboxed or
        // opaque-origin frame rejects with SecurityError): as without locks.
        await work();

        return true;
    }

    return granted;
}

/** What one tab tells the others of a session over its BroadcastChannel. */
type RelayMessage =
    | {
          type: 'descriptor';
          event: 'page.duplicate_tab';
          descriptor: Descriptor;
      }
    | { type: 'want_lock' };

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

/** The two 409 codes after which the server takes nothing more for the session. */
type ClosingCode = 'session_closed' | 'discarded';

function isClosingCode(code: unknown): code is ClosingCode {
    return code === 'session_closed' || code === 'discarded';
}

/** The closing code of a 409 answer, or null for any other answer. */
function closingCodeOf(answer: WireAnswer): ClosingCode | null {
    const verdict = classify(answer);

    return verdict.kind === 'terminal' &&
        verdict.status === 409 &&
        isClosingCode(verdict.code)
        ? verdict.code
        : null;
}

/** A refusal made locally, so a call that must not go out ends as the server would end it. */
function localRefusal(code: string): WireAnswer {
    return {
        status: 409,
        body: { error: { code, message: code } },
        networkError: false,
        timedOut: false,
    };
}

/** error.current_take of a 409 stale_take, or null. */
function currentTakeIn(body: unknown): number | null {
    const error = (body as { error?: { current_take?: unknown } } | null)
        ?.error;
    const take = error?.current_take;

    return typeof take === 'number' && Number.isSafeInteger(take) && take > 0
        ? take
        : null;
}

/** The answer of a call owed until a final answer, or the token that can no longer be re-minted. */
type OwedOutcome =
    { kind: 'answer'; answer: WireAnswer } | { kind: 'unrecoverable' };

/** One shared checks poll for one take (spec 6.7). */
interface ChecksPoll {
    take: number;
    promise: Promise<ChecksResult>;
    /** What the server said, or the local unknown at the timeout; null while polling. */
    result: ChecksResult | null;
    cancelled: boolean;
    cancel(): void;
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
        // An unreadable descriptor never allows a review copy (Plan 9, author's call 4).
        playback: {
            source: 'none' as const,
            local: 'off' as const,
            localBytes: 0,
            localReason: 'not_allowed' as const,
            objectUrls: 0,
            revoked: 0,
        },
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

/** Whether each session object holds its Web Lock, for resume(). */
const owners = new WeakMap<FittSession, () => boolean>();

/** Whether this page's object holds the session's lock (always true without locks). */
export function ownsLock(session: FittSession): boolean {
    return owners.get(session)?.() ?? true;
}

/** Each session object's first lock answer: true when it took the lock (or runs without locks). */
const lockDecisions = new WeakMap<FittSession, Promise<boolean>>();

/** Resolves once the session's first lock request is answered: true when it owns the session. */
export function lockDecided(session: FittSession): Promise<boolean> {
    return lockDecisions.get(session) ?? Promise.resolve(true);
}

/** What <fitt-recorder> reads to draw its timers and its stop rule. Not part of the public API. */
export interface TakeView {
    recording: RecordingLimits;
    /** Session time of the current take's `started` milestone, or null when no take is open. */
    takeStartMs: number | null;
    /** Session time of the cap's forced stop: `session_cap_ms` less the lifecycle's margin (author's call 6). */
    capStopMs: number;
}

/** Each session object's take view, for the element. */
const takeViews = new WeakMap<FittSession, () => TakeView>();

/** The take's limits and start, or null for a session this module did not make (an invalid descriptor, another copy of the SDK). */
export function takeView(session: FittSession): TakeView | null {
    return takeViews.get(session)?.() ?? null;
}

/** The same-id map: one session object per session id in this page. */
const sessions = new Map<string, FittSession>();

/** The session without the same-id map. Exported for session.test.ts. */
export function createSession(
    input: unknown,
    options: SessionOptions,
    seams: SessionSeams,
    opening: ResumeOpening | null = null,
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
    const patchPlayback = (change: Partial<PlaybackState>): void =>
        state.patch({ playback: { ...state.get().playback, ...change } });

    // The review copy, in memory only (Plan 9, author's calls 1, 4 and 6).
    const copy: LocalCopy = createLocalCopy({
        sessionId,
        off:
            descriptor.playback?.local !== true
                ? 'not_allowed'
                : options.playback?.local === false
                  ? 'host_off'
                  : seams.objectUrls == null || typeof Blob === 'undefined'
                    ? 'unsupported'
                    : null,
        maxBytes: descriptor.playback?.local_max_bytes ?? 0,
        objectUrls: seams.objectUrls ?? null,
        win: page?.win ?? null,
        onChange: (view) =>
            patchPlayback({
                local: view.state,
                localBytes: view.bytes,
                localReason: view.reason,
                objectUrls: view.objectUrls,
                revoked: view.revoked,
            }),
    });
    patchPlayback({
        local: copy.view().state,
        localReason: copy.view().reason,
    });

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
    /**
     * The direct window attempts this page received (author's call 10): the
     * descriptor handed to FittVideo.session() with no stored record, and
     * every descriptor the token keeper accepted. A resumed or stored window
     * is not here, so its first direct PUT renews it.
     */
    const receivedAttempts = new Set<string>();
    const receiveWindows = (from: Descriptor): void => {
        for (const track of from.tracks) {
            if (track.upload.direct !== undefined) {
                receivedAttempts.add(track.upload.direct.attempt);
            }
        }
    };
    const runIndexes = new Map<string, number>();
    /** `${track}:${take}` of every manifest posted, for the abandon re-post (author's call 8). */
    const posted = new Set<string>();
    /** `${track}:${take}` the server answered sealed. */
    const sealed = new Set<string>();
    const manifestsInFlight = new Map<string, Promise<void>>();
    const repostWanted = new Set<string>();
    /** Tracks whose manifest stop() stopped waiting for on a network that blocks preflights. */
    const blockedTracks = new Set<TrackName>();
    /** The server closed or discarded the session: everything local is gone, nothing more is sent. */
    let closed = false;
    let closedReason: ClosingCode = 'session_closed';
    let closing: Promise<void> | null = null;
    /** The discard in progress, owed until a final answer (spec 6.5). */
    let discarding: Promise<void> | null = null;
    /** The host's reset in progress. */
    let resetting: Promise<void> | null = null;
    /** True from a finalise() that passed its checks until it ends: a host reset() is refused meanwhile. */
    let finalising = false;
    /** The take whose manifests stop() has posted: its checks poll may start (spec 6.7). */
    let sealedTake: number | null = null;
    let checksPoll: ChecksPoll | null = null;
    /** The capture error of the re-acquire after the last reset, if it failed. */
    let reacquireError: unknown = null;
    /** A take a reload interrupted, not yet continued, sealed or reset (step 8). */
    let interrupted = false;
    /** The end of the interrupted take's last stored segment: its end when it is finalised without being continued. */
    let interruptedEndMs = 0;
    /** resume() found a completed stop: finalise once the queue has drained (author's call 15). */
    let autoFinalise = opening?.resume === 'finalise';
    /** startPipeline() ran: the queue holds every pending segment, so a backlog of 0 means drained. */
    let pipelineStarted = false;

    // One owning tab (author's call 15).
    /** Set to null when the Lock API rejects its requests: the session then runs as without locks. */
    let locks = seams.locks;
    /** This tab holds the session's Web Lock; without locks every session owns its id. */
    let owner = locks === null;
    /** Settles the promise the lock callback returned, which hands the lock to the next waiting request. */
    let releaseLock: (() => void) | null = null;
    /** A waiting lock request is queued. */
    let lockQueued = false;
    let relay: ReturnType<NonNullable<SessionSeams['channel']>> | null = null;
    let handingOver = false;
    /** The host re-attached or prepared: the page is listened to whenever this tab owns the session. */
    let attachWanted = false;

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
            if (event.type.startsWith('playback.')) {
                // Local only (Plan 9, author's call 9): listeners saw it; no batch carries it.
                return;
            }

            // A finished session queues nothing more: the last flush is behind it (item 10).
            // Listeners still see the event; no batch carries it.
            const sending = !tombstoned && !tombstoning && !closed;

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

        if (type === 'recorder.fallback' && payload?.track === 'camera') {
            // A blob fallback on the camera turns the review copy off (Plan 9, author's call 5).
            copy.fellBack(localTake);
        }
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

        maybeAutoFinalise();
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

    /**
     * The purge sweep over every stored session (item 3). Each delete runs
     * inside that session's Web Lock, taken only when no tab holds it: a
     * session a live tab holds is skipped (author's call 15).
     */
    const purgeSweep = async (): Promise<void> => {
        const nowMs = env.dateNow();

        for (const listed of await store.listSessions()) {
            if (sweepPlan(listed, nowMs) === null) {
                continue;
            }

            await underLock(seams.locks, listed.session_id, async () => {
                // Read again inside the lock: a tab that held it until now may
                // have written the record since the list was taken.
                const stored = await store.getSession(listed.session_id);
                const plan =
                    stored === undefined ? null : sweepPlan(stored, nowMs);

                if (stored !== undefined && plan !== null) {
                    await sweepOne(stored, plan, nowMs);
                }
            });
        }
    };

    /** What the purge sweep does with a stored session: null when it is left alone. */
    const sweepPlan = (
        stored: SessionRecord,
        nowMs: number,
    ): ReturnType<typeof planResume> | null => {
        const plan = planResume(stored, nowMs);
        const keepOwed =
            (plan === 'discard' || plan === 'reset') &&
            nowMs - stored.last_activity_ms >
                stored.descriptor.queue.abandon_after_ms;

        return plan === 'purge' || keepOwed ? plan : null;
    };

    /** One stored session the purge sweep deletes, or keeps as a record with no media. */
    const sweepOne = async (
        stored: SessionRecord,
        plan: ReturnType<typeof planResume>,
        nowMs: number,
    ): Promise<void> => {
        const own = stored.session_id.toLowerCase() === sessionId.toLowerCase();

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
        } else {
            // The owed call outlives the purge; its media does not (author's call 15).
            await store.deleteSession(stored.session_id);
            await store.putSession(stored);
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
                ladder_rung: settings.forcePost
                    ? 'post'
                    : startsDirect(descriptor)
                      ? 'direct'
                      : 'put',
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

            if (opening === null) {
                // A newer descriptor over a stored record reaches the keeper's onDescriptor instead.
                receiveWindows(given);
            }
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

    /** Item 10's cleanup: the lock goes to the next waiting tab, and the relay closes. */
    const releaseOwnership = (): void => {
        const release = releaseLock;
        releaseLock = null;
        release?.();
        relay?.close();
        relay = null;
    };

    /** The object a finalised session leaves: phase stopped, finalised, nothing running (item 10). */
    const becomeTombstone = (): void => {
        tombstoned = true;
        early = [];
        releaseOwnership();
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
            } else if (status === 409 && code === 'stale_take') {
                // That take's manifest is dropped and never posted again.
                owed();
            } else if (status === 409 && isClosingCode(code)) {
                owed();
                void closeSession(code);
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
                if (closed) {
                    return localRefusal(closedReason);
                }

                if (take < localTake) {
                    // A reset or a newer take on the server: the old take is never posted again.
                    return localRefusal('stale_take');
                }

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

    /**
     * Seals the take's tracks: take_end_ms and every owed manifest stored in
     * one write, then each manifest posted, owed until answered (item 5). One
     * write, so a reload never finds take_end_ms set with no manifest owed,
     * which reads as a stop whose manifests were all answered.
     */
    const sealTracks = async (endMs: number): Promise<void> => {
        const take = activeTake ?? localTake;

        if (record === null || closed || discarding !== null) {
            // A session being discarded or already closed seals nothing.
            return;
        }

        if (take < localTake) {
            // The server moved on to a newer take: this one is gone, and its
            // end is never stored as the newer take's.
            return;
        }

        const runs = await store.listRuns(sessionId);
        const tracks = chunkedTracks(descriptor).filter((track) =>
            runs.some((run) => run.track === track.track && run.take === take),
        );
        const held: SessionRecord | null = record;

        if (
            held === null ||
            closed ||
            discarding !== null ||
            take < localTake
        ) {
            return;
        }

        held.take_end_ms = endMs;

        for (const track of tracks) {
            held.manifest_owed[track.track] = take;
        }

        await persist();
        await postOwedManifests(tracks, take, endMs);

        if (take === localTake && !closed) {
            // stop() has posted the manifests: the take's checks poll may start (spec 6.7).
            sealedTake = take;
        }
    };

    /**
     * Posts the owed manifests of `take` and waits for each final answer, or
     * until a network known to block preflights holds them up (item 5).
     */
    const postOwedManifests = async (
        tracks: ChunkedTrack[],
        take: number,
        endMs: number,
    ): Promise<void> => {
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
        // A take a reload interrupted is gone too: finalise() never seals it,
        // and start() never continues it.
        interrupted = false;
        lifecycle?.forgetResumedTake();
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

    /**
     * The server takes nothing more for this session (a discard that
     * landed, or the first 409 session_closed or discarded from a segment,
     * a batch, a refresh, a manifest, finalise or discard; never from reset).
     * The uploader aborts what is in flight first, so no store write follows,
     * then the record with its runs, segments and batches and both storage
     * copies are deleted. Capture is released.
     */
    const closeSession = (code: ClosingCode): Promise<void> => {
        if (closing !== null) {
            return closing;
        }

        closed = true;
        closedReason = code;
        // No write after this point may bring the record back.
        record = null;
        checksPoll?.cancel();
        stopTick();
        batcher?.stop();
        detachPage();
        removeOnline?.();
        removeOnline = null;
        const phase = lifecycle?.phase();

        if (
            phase === 'countdown' ||
            phase === 'recording' ||
            phase === 'ready'
        ) {
            lifecycle?.setPhase('stopped');
        }

        closing = (async (): Promise<void> => {
            // Stops any run still open (its last cuts are dropped) and releases capture.
            await engine?.stopTake().catch(() => undefined);
            await uploader?.stop();
            await token?.stop();
            await writes;
            await store.deleteSession(sessionId);
            removeItem(storage, epochKey(sessionId));
            removeItem(storage, seqKey(sessionId));
            refreshUpload();
        })().catch((error: unknown) => console.error(error));

        return closing;
    };

    /** A write that landed after the close: the rows go again (deleteSession also removes rows with no record). */
    const sweepAfterClose = async (): Promise<void> => {
        await closing;
        await store.deleteSession(sessionId);
    };

    const closedRefusal = (): Promise<never> =>
        rejectWith('invalid_state', { reason: closedReason });

    /**
     * A reset or a discard, sent until a final answer (author's call 15).
     * It waits on token.ready() first. A 401 token_expired with
     * recoverable false (the session can no longer be re-minted) ends it
     * as `unrecoverable`; a 405 or a proxy 403 backs off and goes again.
     */
    const callOwed = async (
        call: () => Promise<WireAnswer>,
    ): Promise<OwedOutcome> => {
        const keeper = token as TokenKeeper;
        let unrecoverable = false;
        let giveUp = false;
        const guarded: Pick<TokenKeeper, 'current' | 'expired' | 'ready'> = {
            current: () => keeper.current(),
            expired: (usedId) => {
                const result = keeper.expired(usedId);

                if (result === 'paused' && unrecoverable) {
                    giveUp = true;
                }

                return result;
            },
            ready: () =>
                giveUp ? rejectWith('token_expired') : keeper.ready(),
        };
        let attempt = 0;

        await keeper.ready();

        for (;;) {
            let answer: WireAnswer;

            try {
                answer = await callWithRetry(
                    {
                        env,
                        token: guarded,
                        onSuccess: () => ladder?.markSucceeded(),
                    },
                    async () => {
                        if (closed) {
                            return localRefusal(closedReason);
                        }

                        const sent = await call();
                        const verdict = classify(sent);
                        unrecoverable =
                            verdict.kind === 'refresh' && !verdict.recoverable;

                        return sent;
                    },
                );
            } catch (error) {
                if (giveUp) {
                    return { kind: 'unrecoverable' };
                }

                throw error;
            }

            const verdict = isOk(answer) ? null : classify(answer);

            if (verdict?.kind === 'blocked' || verdict?.kind === 'step_down') {
                // JSON calls have no POST rung: back off and keep the call owed.
                attempt += 1;
                await sleep(backoffMs(attempt, env.random()));

                continue;
            }

            return { kind: 'answer', answer };
        }
    };

    /** A checks result for the current take: state.checks, onChecks, and the rejected phase on a reject (spec 6.5). */
    const takeChecks = (result: ChecksResult): void => {
        state.patch({ checks: result });
        checksListeners.call(result);

        if (
            result.verdict !== 'reject' ||
            result.take !== localTake ||
            record === null ||
            finalised ||
            tombstoned
        ) {
            return;
        }

        record.rejected_take = result.take;
        void persist().then(() => {
            if (
                !closed &&
                result.take === localTake &&
                lifecycle?.phase() === 'stopped'
            ) {
                lifecycle.setPhase('rejected');
            }
        });
    };

    /** Starts the one shared checks poll for the current take. */
    const startChecks = (timeoutMs: number): ChecksPoll => {
        const take = localTake;
        let cancelled!: (result: ChecksResult) => void;
        const onCancel = new Promise<ChecksResult>((resolve) => {
            cancelled = resolve;
        });
        const poll: ChecksPoll = {
            take,
            promise: onCancel,
            result: null,
            cancelled: false,
            cancel(): void {
                if (poll.cancelled) {
                    return;
                }

                poll.cancelled = true;
                // A cancelled wait settles at once on the local unknown.
                cancelled({
                    status: 'pending',
                    verdict: 'unknown',
                    take,
                    reasons: [],
                });
            },
        };
        const polled = pollChecks(
            {
                env,
                // A cancelled poll sends nothing more: its next look never settles.
                status: () =>
                    poll.cancelled
                        ? new Promise<WireAnswer>(() => undefined)
                        : api!.status(),
                take: () => take,
                onChecks: (result) => {
                    if (!poll.cancelled) {
                        poll.result = result;
                        takeChecks(result);
                    }
                },
            },
            timeoutMs,
        );
        poll.promise = Promise.race([polled, onCancel]);
        checksPoll = poll;

        return poll;
    };

    /** Once stop() has posted the take's manifests, its checks poll starts by itself (spec 6.7 step 3). */
    const maybeStartChecks = (): void => {
        if (
            descriptor.checks === undefined ||
            closed ||
            discarding !== null ||
            sealedTake !== localTake ||
            lifecycle?.phase() !== 'stopped' ||
            (checksPoll !== null &&
                checksPoll.take === localTake &&
                !checksPoll.cancelled)
        ) {
            return;
        }

        startChecks(settings.checksTimeoutMs);
    };

    /** The server is on `newTake`: the old take is gone here too (spec 6.5). */
    const applyReset = async (
        newTake: number,
        reacquire: boolean,
    ): Promise<void> => {
        if (record === null) {
            return;
        }

        const take = Math.max(newTake, localTake);
        localTake = take;
        record.take = take;
        record.take_open = false;
        record.take_start_ms = null;
        record.take_end_ms = null;
        record.stop_completed = false;
        record.rejected_take = null;
        record.pending_reset_take = null;
        record.manifest_owed = {};
        posted.clear();
        repostWanted.clear();
        blockedTracks.clear();
        clearError('manifests_blocked', 'manifest_rejected');
        activeTake = null;
        sealedTake = null;
        interrupted = false;
        // Nothing of the old take is sealed later, not even by finalise().
        deferredSealed = true;
        checksPoll?.cancel();
        checksPoll = null;
        await persist();
        uploader?.dropTakesBelow(take);
        await dropLocalTakesBelow(take);

        if (!reacquire || engine === null || closed) {
            return;
        }

        // stopTake() released capture: the preview and the meter are live again (spec 6.5).
        try {
            await engine.prepare();
        } catch (error) {
            if (closed || discarding !== null) {
                // The close released capture while the prompt was open: resetTake() reports the close.
                return;
            }

            const code = codeOf(error);

            if (code !== null && isErrorCode(code)) {
                engineError(code);
            }

            reacquireError = error;

            return;
        }

        if (closed || discarding !== null) {
            // Closed or discarded while the permission prompt was open: nothing is held for it.
            engine.release();

            return;
        }

        clearError(...CAPTURE_CODES);
    };

    /** A reset that landed while the session closed or a discard began: reset() never ends in ready then. */
    const refuseIfClosing = (): Promise<void> => {
        if (closed) {
            return closedRefusal();
        }

        if (discarding !== null) {
            return rejectWith('invalid_state', { reason: 'discarding' });
        }

        return Promise.resolve();
    };

    /**
     * The reset of `take` (the host's reset(), the too_short path, or one
     * owed by an earlier page). Owed from before the first request until a
     * final answer. A 409 session_closed is not the closing signal here: the
     * server answers it for every status but open, finalising included, so
     * the take, the queue and the uploads stay as they are (Task 15a).
     */
    const resetTake = async (
        take: number,
        reacquire: boolean,
    ): Promise<void> => {
        reacquireError = null;

        if (closed) {
            return closedRefusal();
        }

        if (record === null) {
            return;
        }

        record.pending_reset_take = take;
        await persist();
        const outcome = await callOwed(() => api!.reset(take));

        if (closed) {
            return closedRefusal();
        }

        const clearIntent = async (): Promise<void> => {
            if (record !== null) {
                record.pending_reset_take = null;
                await persist();
            }
        };

        if (outcome.kind === 'unrecoverable') {
            await clearIntent();

            return rejectWith('invalid_state', { reason: 'token_expired' });
        }

        const { answer } = outcome;

        if (isOk(answer)) {
            const next = (answer.body as { take?: unknown } | null)?.take;
            await applyReset(
                typeof next === 'number' && Number.isSafeInteger(next)
                    ? next
                    : take + 1,
                reacquire,
            );

            return refuseIfClosing();
        }

        const verdict = classify(answer);
        const code = verdict.kind === 'terminal' ? verdict.code : 'refused';

        if (closingCodeOf(answer) === 'discarded') {
            await closeSession('discarded');

            return closedRefusal();
        }

        const current =
            code === 'stale_take' ? currentTakeIn(answer.body) : null;

        if (current !== null && current > take) {
            // The server is already past that take: the reset landed, or another did.
            await applyReset(current, reacquire);

            return refuseIfClosing();
        }

        await clearIntent();

        return rejectWith(
            'invalid_state',
            code === 'session_closed'
                ? { reason: code }
                : { reason: code, status: answer.status },
        );
    };

    /**
     * The discard (spec 6.5): owed from before the first request, the batcher
     * and the checks poll stopped, then sent until a final answer. Any final
     * answer closes the session locally.
     */
    const runDiscard = (): Promise<void> => {
        discarding ??= (async (): Promise<void> => {
            if (closed) {
                return;
            }

            if (record !== null) {
                record.pending_discard = true;
                await persist();
            }

            batcher?.stop();
            checksPoll?.cancel();
            const outcome = await callOwed(() => api!.discard());

            if (outcome.kind === 'unrecoverable') {
                await closeSession('discarded');

                return;
            }

            const { answer } = outcome;
            const closingCode = closingCodeOf(answer);

            if (isOk(answer) || closingCode !== null) {
                await closeSession(closingCode ?? 'discarded');

                return;
            }

            // Any other final refusal (a 404 for a session the server no longer has):
            // nothing is left to discard there, so nothing is kept here.
            await closeSession('discarded');
            const verdict = classify(answer);

            return rejectWith('invalid_state', {
                reason: verdict.kind === 'terminal' ? verdict.code : 'refused',
                status: answer.status,
            });
        })();

        return discarding;
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

        if (closed || record === null) {
            // The last flush or refresh closed the session: closeSession() deletes it, no tombstone comes back.
            return;
        }

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

        if (closed) {
            return;
        }

        await store.putSession(tombstone);
        tombstoned = true;
        releaseOwnership();
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

        maybeAutoFinalise();
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
            // The interrupted take is continued with a new run.
            interrupted = false;
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

        if (
            record !== null &&
            phase === 'ready' &&
            record.take_open &&
            !interrupted
        ) {
            // The too_short path: the take was reset and nothing is open. An
            // interrupted take stays open until it is continued, reset or sealed:
            // prepare() after a reload reaches ready too.
            record.take_open = false;
            void persist();
        }

        if (phase === 'stopped' && activeTake === localTake) {
            // The take stopped: the copy builds its one file (Plan 9, author's call 1).
            copy.complete(localTake, record?.take_start_ms ?? null);
        }

        if (phase === 'ready') {
            // The host's reset and the too_short reset both return to ready (Plan 9, author's call 6).
            copy.clear('reset');
        }

        if (phase === 'stopped') {
            maybeStartChecks();
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
    const addSegment = async (
        segment: SegmentRecord,
        nonKeyframeStart = false,
    ): Promise<unknown> => {
        if (closed || segment.take < localTake || queue === null) {
            return 'dropped';
        }

        // Before the queue, so a segment it abandons stays in the copy (Plan 9, author's call 5).
        copy.add(segment, nonKeyframeStart);

        const result = await queue.add(segment);

        if (closed) {
            // The session closed while this segment was stored.
            await sweepAfterClose();

            return 'dropped';
        }

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

    /**
     * Builds the pipeline over the stored record, in the plan's order (item
     * 5). It starts nothing that sends: startPipeline() does, once the owed
     * calls are done.
     */
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

                const closingCode = closingCodeOf(answer);

                if (closingCode !== null) {
                    void closeSession(closingCode);
                }

                return answer;
            },
            onDescriptor: (next) => {
                descriptor = next;
                receiveWindows(next);

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
            onClosed: (code) => {
                void closeSession(code);
            },
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
            emit: (type, payload) => {
                emit(type, payload);

                if (
                    type === 'upload.segment_rejected' &&
                    isClosingCode(payload.code)
                ) {
                    void closeSession(payload.code);
                }
            },
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
            freshAttempt: (attempt) => receivedAttempts.has(attempt),
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
                    if (closed || run.take < localTake) {
                        return;
                    }

                    await store.putRun(run);

                    if (closed) {
                        await sweepAfterClose();
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
            // The too_short path: the take is reset on the server before the phase is ready again.
            resetTake: () => resetTake(localTake, true),
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

        tickTimer = env.timers.setTimeout(tick, TICK_MS);
    };

    /**
     * Starts what sends. 'none' (an owed discard) starts nothing, so
     * nothing but the discard is ever sent; 'drain' (a session resume()
     * opened) uploads and sends batches but listens to no page until the
     * host re-attaches; 'full' also attaches the page.
     */
    const startPipeline = (mode: BuildMode): void => {
        if (
            mode === 'none' ||
            closed ||
            uploader === null ||
            batcher === null
        ) {
            return;
        }

        if ((mode === 'full' || attachWanted) && !destroyed) {
            attachPage();
        }

        uploader.start();
        batcher.startTimer({ emptyHeartbeats: false });
        pipelineStarted = true;
        maybeAutoFinalise();
    };

    /** A session resume() found stopped: once the queue has drained it finalises itself, with the stored take end. */
    function maybeAutoFinalise(): void {
        if (
            !autoFinalise ||
            !pipelineStarted ||
            finalising ||
            finalised ||
            closed ||
            tombstoned ||
            discarding !== null ||
            resetting !== null ||
            uploader === null ||
            uploader.stats().backlog > 0
        ) {
            return;
        }

        autoFinalise = false;
        void created
            .finalise()
            .catch((error: unknown) =>
                warn(
                    `Fitt Video: the resumed finalise failed: ${String(error)}`,
                ),
            );
    }

    /** The end of the last stored segment of a run, or its anchor when it has none. */
    const runEnd = (run: RunRecord, segments: SegmentRecord[]): number =>
        segments
            .filter(
                (segment) =>
                    segment.track === run.track &&
                    segment.take === run.take &&
                    segment.run_index === run.run_index,
            )
            .reduce(
                (end, segment) =>
                    Math.max(end, segment.start_ms + segment.duration_ms),
                run.anchor_ms,
            );

    /**
     * Step 8, after a reload over a stored record (Task 15b): the owed
     * manifests first, a stop that was under way completed, the runs of an
     * open take ended as `reload` and the take continued from its stored
     * start (author's call 12), and every pending segment back in the queue.
     */
    const continueAfterReload = async (): Promise<void> => {
        if (!recordExisted || record === null || closed) {
            return;
        }

        const take = localTake;
        const owedEndMs = record.take_end_ms;
        const owedTracks = chunkedTracks(descriptor).filter(
            (track) => record?.manifest_owed[track.track] === take,
        );

        if (owedTracks.length > 0 && owedEndMs !== null) {
            // Each owed manifest goes before anything else is uploaded.
            await postOwedManifests(owedTracks, take, owedEndMs);
        }

        const held = record as SessionRecord | null;

        if (held === null || closed) {
            return;
        }

        if (held.take_open && held.take_end_ms !== null) {
            // stop() had posted its manifests when the page went: the stop is complete now.
            held.take_open = false;
            held.stop_completed = true;
        }

        if (held.take_open && held.take_start_ms === null) {
            held.take_open = false;
        }

        const runs = await store.listRuns(sessionId);
        const segments = await store.listSegments(sessionId);

        if (held.take_open && held.take_start_ms !== null) {
            for (const run of runs) {
                if (run.take === take && run.ended_reason === null) {
                    await store.putRun({
                        ...run,
                        ended_reason: 'reload',
                        ended_ms: runEnd(run, segments),
                    });
                }
            }

            interruptedEndMs = segments
                .filter((segment) => segment.take === take)
                .reduce(
                    (end, segment) =>
                        Math.max(end, segment.start_ms + segment.duration_ms),
                    held.take_start_ms,
                );
            interrupted = true;
            activeTake = take;
            lifecycle?.resumeTake(held.take_start_ms);
        } else if (held.stop_completed) {
            // A stopped take needs reset() before another, as in the page that stopped it.
            if (held.take_end_ms !== null) {
                for (const track of chunkedTracks(descriptor)) {
                    if (
                        runs.some(
                            (run) =>
                                run.track === track.track && run.take === take,
                        )
                    ) {
                        // Its manifest was posted, so an abandon re-posts it (author's call 8).
                        posted.add(`${track.track}:${take}`);
                    }
                }
            }

            lifecycle?.setPhase(
                held.rejected_take === take ? 'rejected' : 'stopped',
            );
        }

        await persist();
        const pending = segments.filter(
            (segment) => segment.state === 'pending' && segment.take === take,
        );
        queue?.adopt(pending);

        for (const segment of pending) {
            uploader?.enqueue(segment);
        }
    };

    /**
     * The record, the build and the owed calls, run only while this tab
     * holds the lock: at once, or when a waiting request is granted (the
     * owner closed, or handed the lock over). The record is read fresh.
     */
    const takeOwnership = async (): Promise<void> => {
        if (await loadRecord()) {
            becomeTombstone();

            return;
        }

        // loadRecord() set it; the cast only widens what the compiler narrowed.
        const held = record as SessionRecord | null;

        if (held === null) {
            return;
        }

        if (autoFinalise) {
            // The record read now decides: a tab that held the lock until now
            // may have reset or reopened the take resume() planned to finalise.
            autoFinalise = planResume(held, env.dateNow()) === 'finalise';
        }

        build();

        if (held.pending_discard) {
            // A discard that never landed is finished before anything else, and nothing else is sent.
            startPipeline('none');
            void runDiscard().catch((error: unknown) =>
                warn(
                    `Fitt Video: the owed discard was refused: ${String(error)}`,
                ),
            );

            return;
        }

        if (held.pending_reset_take !== null) {
            // A reset whose answer was lost is finished before any capture or take.
            await resetTake(held.pending_reset_take, false).catch(
                (error: unknown) =>
                    warn(
                        `Fitt Video: the owed reset was refused: ${String(error)}`,
                    ),
            );
        }

        await continueAfterReload();
        startPipeline(opening === null ? 'full' : 'drain');
    };

    const reportReady = (error: unknown): void =>
        console.error('Fitt Video: the session could not start.', error);

    const otherTabRefusal = (): Promise<never> =>
        rejectWith('invalid_state', { reason: 'other_tab' });

    /** The relay message a second tab sends: page.duplicate_tab for the owner, and the descriptor it was handed. */
    const sendRelay = (current: Descriptor): void => {
        const message: RelayMessage = {
            type: 'descriptor',
            event: 'page.duplicate_tab',
            descriptor: current,
        };

        try {
            relay?.postMessage(message);
        } catch (error) {
            console.error(error);
        }
    };

    /** A descriptor from the host or a relay: the keeper takes it only when its token is newer (author's call 10). */
    const takeDescriptor = (next: Descriptor): void => {
        if (tombstoned) {
            return;
        }

        if (token === null) {
            pendingDescriptors.push(next);
        } else {
            token.set(next);
        }
    };

    /** Holds the lock until a hand-over or item 10's cleanup settles it. */
    const holdLock = (granted: () => void): Promise<void> =>
        new Promise<void>((release) => {
            releaseLock = release;
            owner = true;
            granted();
        });

    /** One ifAvailable request: true when this tab now holds the lock. The session never awaits a held lock's promise. */
    const requestLock = (): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
            let entered = false;
            (locks as NonNullable<SessionSeams['locks']>)
                .request(lockName(sessionId), { ifAvailable: true }, (lock) => {
                    entered = true;

                    if (lock === null) {
                        resolve(false);

                        return undefined;
                    }

                    return holdLock(() => resolve(true));
                })
                .catch((error: unknown) => {
                    console.error(error);

                    if (entered) {
                        return;
                    }

                    // The Lock API is there but refuses every request (a sandboxed
                    // or opaque-origin frame rejects with SecurityError). No other
                    // tab is involved, so this tab owns the session, as without locks.
                    locks = null;
                    owner = true;
                    relay?.close();
                    relay = null;
                    resolve(true);
                });
        });

    /** A waiting request: when it is granted, this tab builds the rest as the owner. */
    const queueLock = (): void => {
        if (locks === null || lockQueued) {
            return;
        }

        lockQueued = true;
        locks
            .request(lockName(sessionId), { mode: 'exclusive' }, (lock) => {
                lockQueued = false;

                if (lock === null) {
                    return undefined;
                }

                return holdLock(() => {
                    ready = takeOwnership();
                    ready.catch(reportReady);
                });
            })
            .catch((error: unknown) => console.error(error));
    };

    /**
     * Without the lock: phase idle, nothing stored, no keeper, uploader or
     * batcher (bus events wait in memory). The owner hears of this tab and
     * of its descriptor; a visible tab also asks for the lock. A waiting
     * request is queued either way.
     */
    const becomeBystander = (): void => {
        owner = false;
        // Status reads only, with the token this tab was handed.
        api = createSessionApi(
            env,
            () => descriptor,
            () => heldToken.current(),
        );
        sendRelay(descriptor);

        if (page !== null && page.doc.visibilityState === 'visible') {
            try {
                relay?.postMessage({
                    type: 'want_lock',
                } satisfies RelayMessage);
            } catch (error) {
                console.error(error);
            }
        }

        queueLock();
    };

    /**
     * A visible tab asked for the lock. A hidden owner that is not counting
     * down, recording or stopping (and has no prepare, reset, discard,
     * finalise or manifest in flight, and is neither finalised nor owed a
     * finalise) freezes its waiting events, stops its
     * keeper, uploader and batcher, and only then releases the lock and
     * queues a waiting request again, so the visible tab's request is first.
     */
    const handOver = async (): Promise<void> => {
        if (!owner || handingOver) {
            return;
        }

        await whenReady();
        const phase = lifecycle?.phase() ?? 'idle';

        if (
            !owner ||
            handingOver ||
            releaseLock === null ||
            page === null ||
            page.doc.visibilityState !== 'hidden' ||
            tombstoned ||
            tombstoning ||
            closed ||
            discarding !== null ||
            resetting !== null ||
            finalising ||
            // Finalised but not yet the tombstone (its backlog still drains), or
            // owed a finalise by resume(): only this tab knows it, so it keeps the
            // lock until the tombstone releases it.
            finalised ||
            autoFinalise ||
            preparing !== null ||
            manifestsInFlight.size > 0 ||
            phase === 'preparing' ||
            phase === 'countdown' ||
            phase === 'recording' ||
            phase === 'stopping'
        ) {
            return;
        }

        handingOver = true;
        owner = false;
        ready = (async (): Promise<void> => {
            stopTick();
            checksPoll?.cancel();
            checksPoll = null;
            detachPage();
            removeOnline?.();
            removeOnline = null;
            engine?.release();
            // The next owner sends what was waiting here: batch_seq and the bodies are stored first.
            await batcher?.freeze();
            await token?.stop();
            await uploader?.stop();
            batcher?.stop();
            await writes;
            pendingDescriptors.push(descriptor);
            // Another tab may use these windows' slots now: renew before any later PUT here.
            receivedAttempts.clear();
            record = null;
            batcher = null;
            token = null;
            ladder = null;
            queue = null;
            uploader = null;
            lifecycle = null;
            engine = null;
            stall = null;
            stay = null;
            api = createSessionApi(
                env,
                () => descriptor,
                () => heldToken.current(),
            );
            pipelineStarted = false;
            heartbeats = false;
            activeTake = null;
            sealedTake = null;
            interrupted = false;
            deferredSealed = false;
            recordExisted = false;
            lastEmittedError = null;
            posted.clear();
            sealed.clear();
            repostWanted.clear();
            blockedTracks.clear();
            state.patch({ phase: 'idle', error: null });
            refreshUpload();
            const release = releaseLock;
            releaseLock = null;
            release?.();
            sendRelay(descriptor);
            queueLock();
        })().finally(() => {
            handingOver = false;
        });
        ready.catch(reportReady);
        await whenReady();
    };

    const onRelay = (data: unknown): void => {
        const message = data as {
            type?: unknown;
            event?: unknown;
            descriptor?: unknown;
        } | null;

        if (message?.type === 'want_lock') {
            void handOver().catch((error: unknown) => console.error(error));

            return;
        }

        if (message?.type !== 'descriptor') {
            return;
        }

        if (owner && message.event === 'page.duplicate_tab') {
            // Re-emitted on this bus, so it is batched with the owner's events.
            emit('page.duplicate_tab', {});
        }

        const read = readDescriptor(message.descriptor);

        if (
            read.ok &&
            read.descriptor.session_id.toLowerCase() === sessionId.toLowerCase()
        ) {
            // A host re-mint in the second tab never strands the owner on a superseded token.
            takeDescriptor(read.descriptor);
        }
    };

    const openRelay = (): void => {
        try {
            relay = seams.channel?.(lockName(sessionId)) ?? null;
            relay?.addEventListener('message', (event) =>
                onRelay((event as MessageEvent).data),
            );
        } catch (error) {
            console.error(error);
            relay = null;
        }
    };

    let decideLock: (owns: boolean) => void = () => undefined;
    const lockDecision = new Promise<boolean>((resolve) => {
        decideLock = resolve;
    });

    let ready: Promise<void> = (async () => {
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

        if (opening === null) {
            // resume() swept every stored session before it opened this one.
            await purgeSweep();
        }

        if (locks !== null) {
            // The lock comes before the record is touched (author's call 15).
            openRelay();

            if (!(await requestLock())) {
                becomeBystander();
                decideLock(false);

                return;
            }
        }

        decideLock(true);
        await takeOwnership();
    })();
    ready.catch(reportReady);
    // A ready that failed before the lock was asked for still answers (a no-op once answered).
    void ready.then(
        () => decideLock(owner),
        () => decideLock(owner),
    );

    /** Waits for the current ready promise, and again whenever a grant or a hand-over replaced it meanwhile. */
    async function whenReady(): Promise<void> {
        for (;;) {
            const current = ready;
            await current;

            if (current === ready) {
                return;
            }
        }
    }

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

            if (closed || discarding !== null) {
                // Closed while the permission prompt was open: nothing is held for it.
                engine.release();

                throw new FittVideoError('invalid_state', {
                    reason: closed ? closedReason : 'discarding',
                });
            }
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
            await whenReady();

            if (!owner && !tombstoned) {
                return otherTabRefusal();
            }

            if (engine === null) {
                throw new FittVideoError('recorder_unsupported');
            }

            await engine.devices().select(kind, deviceId);
        },
    };

    /** finalise() once its refusals are passed: seal what was deferred, flush, close, then the checks wait. */
    const finaliseNow = async (): Promise<void> => {
        const life = lifecycle as Lifecycle;
        const phase = life.phase();

        if (phase === 'stopping') {
            await life.stop();
        } else if (phase === 'countdown' || phase === 'recording') {
            return rejectWith('invalid_state', { phase });
        }

        if (interrupted) {
            // A take a reload interrupted and nobody continued ends where its
            // last stored segment ends, not at clock.now(), which would add the
            // reload's gap as a black, silent tail (spec 4.4).
            interrupted = false;
            await sealTracks(interruptedEndMs);
        }

        const unsealed = life.unsealedEndMs();

        if (unsealed !== null && !deferredSealed) {
            deferredSealed = true;
            await sealTracks(unsealed);
            // The deferred manifests are posted: the take's checks poll may start.
            maybeStartChecks();
        }

        await batcher?.flush();

        if (closed || record === null) {
            return closedRefusal();
        }

        // The take's real end, so a wait for checks never adds a black, silent tail (spec 4.4).
        const endMs = Math.min(record.take_end_ms ?? clock.now(), cap);
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
            const closingCode = closingCodeOf(answer);

            if (closingCode !== null) {
                await closeSession(closingCode);
            }

            return rejectWith('invalid_state', {
                reason: verdict.kind === 'terminal' ? verdict.code : 'refused',
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
                      /** Starts a second run on the open take, as a camera switch would (the playground's multi-run case, Plan 9). */
                      restartRun(
                          reason: RunEndedReason = 'device_switch',
                      ): Promise<void> {
                          return (
                              engine?.restartRuns(reason) ?? Promise.resolve()
                          );
                      },
                  },
              }
            : {}),

        async prepare(): Promise<void> {
            await whenReady();

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            if (!owner) {
                return otherTabRefusal();
            }

            if (closed) {
                return closedRefusal();
            }

            if (discarding !== null) {
                return rejectWith('invalid_state', { reason: 'discarding' });
            }

            // A session resume() opened, or one destroy() released, listens to the page again.
            destroyed = false;
            attachWanted = true;
            attachPage();

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
            await whenReady();

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            if (!owner) {
                return otherTabRefusal();
            }

            if (closed) {
                return closedRefusal();
            }

            if (discarding !== null || resetting !== null) {
                return rejectWith('invalid_state', {
                    reason: discarding !== null ? 'discarding' : 'resetting',
                });
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
                    !interrupted &&
                    life.phase() !== 'recording'
                ) {
                    record.take_open = false;
                    void persist();
                }

                throw error;
            }
        },

        async stop(stopOptions = {}): Promise<void> {
            await whenReady();

            if (tombstoned) {
                return;
            }

            if (!owner) {
                return otherTabRefusal();
            }

            const life = lifecycle as Lifecycle;

            try {
                await life.stop(stopOptions);
            } catch (error) {
                if (
                    codeOf(error) === 'too_short' &&
                    reacquireError !== null &&
                    life.phase() === 'ready'
                ) {
                    // The reset landed but capture could not be acquired again.
                    const code = codeOf(reacquireError);
                    life.setPhase(
                        code !== null && PHASE_ERRORS.has(code)
                            ? 'error'
                            : 'idle',
                    );
                }

                throw error;
            } finally {
                await writes;
            }
        },

        async finalise(): Promise<void> {
            await whenReady();

            if (tombstoned) {
                return;
            }

            if (!owner) {
                return otherTabRefusal();
            }

            if (closed) {
                return closedRefusal();
            }

            if (discarding !== null || resetting !== null) {
                return rejectWith('invalid_state', {
                    reason: discarding !== null ? 'discarding' : 'resetting',
                });
            }

            finalising = true;

            try {
                await finaliseNow();
            } finally {
                finalising = false;
            }
        },

        async waitForChecks(checkOptions = {}): Promise<ChecksResult> {
            // A finished session still polls with the held token (item 10).
            await whenReady();
            const current = checksPoll;

            // One poll per take, shared with finalise() and the poll stop() started;
            // after a local unknown at the timeout, a new wait polls again.
            if (
                current !== null &&
                !current.cancelled &&
                current.take === localTake &&
                current.result?.status !== 'pending'
            ) {
                return current.promise;
            }

            return startChecks(
                checkOptions.timeoutMs ?? settings.checksTimeoutMs,
            ).promise;
        },

        async waitForReady(readyOptions): Promise<string> {
            // Playback exists only once a finalised session was processed: a tombstone polls too.
            await whenReady();

            const url = await pollReady(
                { env, status: () => api!.status() },
                readyOptions.track,
                readyOptions.timeoutMs,
            );
            readyListeners.call({ track: readyOptions.track, url });

            return url;
        },

        async reset(): Promise<void> {
            await whenReady();

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            if (!owner) {
                return otherTabRefusal();
            }

            if (closed) {
                return closedRefusal();
            }

            if (discarding !== null) {
                return rejectWith('invalid_state', { reason: 'discarding' });
            }

            if (finalising) {
                // A reset under a finalise could close the new, empty take with the old take's end.
                return rejectWith('invalid_state', { reason: 'finalising' });
            }

            if (resetting !== null) {
                return resetting;
            }

            const life = lifecycle as Lifecycle;
            const phase = life.phase();
            // A take a reload interrupted may be reset without being continued (spec 6.5).
            const interruptedReset =
                interrupted &&
                (phase === 'idle' || phase === 'ready' || phase === 'error');

            if (
                phase !== 'stopped' &&
                phase !== 'rejected' &&
                !interruptedReset
            ) {
                return rejectWith('invalid_state', { phase });
            }

            resetting = (async (): Promise<void> => {
                // An interrupted take holds capture only when the host prepared it.
                await resetTake(
                    localTake,
                    !interruptedReset || phase === 'ready',
                );

                if (interruptedReset) {
                    // Through stopped, so ready forgets the take's stored start in the lifecycle.
                    life.setPhase('stopped');
                }

                // ready forgets the take in the lifecycle, so nothing of it is sealed later.
                life.setPhase('ready');
                state.patch({ checks: null });

                if (interruptedReset && engine?.stream === null) {
                    life.setPhase('idle');
                }

                if (reacquireError !== null) {
                    const code = codeOf(reacquireError);
                    life.setPhase(
                        code !== null && PHASE_ERRORS.has(code)
                            ? 'error'
                            : 'idle',
                    );

                    throw reacquireError;
                }
            })().finally(() => {
                resetting = null;
            });

            return resetting;
        },

        async discard(): Promise<void> {
            await whenReady();

            if (tombstoned || finalised) {
                return finalisedRefusal();
            }

            if (!owner) {
                return otherTabRefusal();
            }

            // A discard clears the review copy (Plan 9, author's call 6).
            copy.clear('discard');

            return runDiscard();
        },

        event(type, payload): boolean {
            return tombstoned ? false : bus.host(type, payload);
        },

        async uploadTranscript(upload): Promise<void> {
            const body = transcriptBody(upload);
            await whenReady();

            if (!owner && !tombstoned) {
                return otherTabRefusal();
            }
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
            // destroy() clears the review copy first (Plan 9, author's call 6).
            copy.clear('destroy');
            destroyed = true;
            engine?.release();
            detachPage();
        },
    };

    /** The host re-attached a session resume() opened: it listens to the page from now on. */
    const reattach = (): void => {
        attachWanted = true;
        void whenReady().then(() => {
            if (
                owner &&
                !destroyed &&
                !closed &&
                !tombstoned &&
                !tombstoning &&
                discarding === null
            ) {
                attachPage();
            }
        });
    };

    setters.set(created, (next) => {
        if (tombstoned) {
            return;
        }

        if (!owner) {
            // A second tab: kept for a later grant, and relayed to the owner each time.
            pendingDescriptors.push(next);
            attachWanted = true;
            sendRelay(next);

            return;
        }

        if (token === null) {
            pendingDescriptors.push(next);
            reattach();

            return;
        }

        // The keeper persists it only when its token is newer (author's call 10).
        token.set(next);
        reattach();
    });

    owners.set(created, () => owner);
    lockDecisions.set(created, lockDecision);
    takeViews.set(created, () => ({
        recording: recordingLimits(),
        takeStartMs: lifecycle?.takeStartMs() ?? null,
        capStopMs: cap - CAP_MARGIN_MS,
    }));

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

    // A new session on the page drops another session's copy (Plan 9, author's call 6).
    dropPageCopy(key, 'next_session');
    const created = createSession(read.descriptor, options, seams);
    sessions.set(key, created);

    return created;
}

/** The session object this page already holds for an id, if any. */
export function heldSession(sessionId: string): FittSession | undefined {
    return sessions.get(sessionId.toLowerCase());
}

/**
 * The passive session resume() opens over a stored record, entered in the
 * same-id map, so a later FittVideo.session(descriptor) with its id returns
 * this object (spec 6.5). An object this page already holds is returned as is.
 */
export function openResumed(
    descriptor: Descriptor,
    options: SessionOptions,
    seams: SessionSeams,
    opening: ResumeOpening,
): FittSession {
    const key = descriptor.session_id.toLowerCase();
    const existing = sessions.get(key);

    if (existing !== undefined) {
        return existing;
    }

    const created = createSession(descriptor, options, seams, opening);
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
            // No Node run ever opens a BroadcastChannel: an open one keeps the process alive.
            locks: null,
            channel: null,
            // No document, no review copy (Plan 9).
            objectUrls: null,
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
        locks:
            typeof navigator !== 'undefined' && navigator.locks !== undefined
                ? navigator.locks
                : null,
        channel:
            typeof BroadcastChannel === 'undefined'
                ? null
                : (name) => new BroadcastChannel(name),
        // The review copy's object URLs (Plan 9), read when called.
        objectUrls:
            typeof URL !== 'undefined' &&
            typeof URL.createObjectURL === 'function'
                ? {
                      create: (blob) => URL.createObjectURL(blob),
                      revoke: (url) => URL.revokeObjectURL(url),
                  }
                : null,
    };
}

/** sessionWith(descriptor, options, browserSeams()). Synchronous and never throws: an invalid descriptor gives a session in phase 'error' with config_invalid. */
export function session(
    descriptor: unknown,
    options: SessionOptions = {},
): FittSession {
    return sessionWith(descriptor, options, browserSeams());
}
