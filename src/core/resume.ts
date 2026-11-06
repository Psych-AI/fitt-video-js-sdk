import { createClock } from './clock.ts';
import { readDescriptor } from './descriptor.ts';
import { browserEnvironment, type Environment } from './env.ts';
import { phpJsonBytes, type SdkEvent } from './events.ts';
import type { SessionOptions } from './options.ts';
import { planResume, type ResumeDecision } from './resume-plan.ts';
import {
    browserSeams,
    epochKey,
    heldSession,
    openResumed,
    readNumber,
    removeItem,
    seqKey,
    writeItem,
    type FittSession,
    type ResumeOpening,
    type SessionSeams,
} from './session.ts';
import { openStore, type QueueStore, type SessionRecord } from './store.ts';
import { ulid } from './ulid.ts';

// Task 15c adds 'owned_elsewhere'.
export type ResumeState =
    'interrupted' | 'finalising' | 'discarding' | 'resume_expired';

export interface ResumeEntry {
    session_id: string;
    state: ResumeState;
    session: FittSession | null;
}

/** The state each kept decision is reported as; a tombstone and a purge are not reported. */
const STATES: Partial<Record<ResumeDecision, ResumeState>> = {
    discard: 'discarding',
    reset: 'interrupted',
    resume_expired: 'resume_expired',
    finalise: 'finalising',
    interrupted: 'interrupted',
};

/** Deletes a session's runs, segments and batches and keeps its record (author's call 15). */
async function keepRecordOnly(
    store: QueueStore,
    record: SessionRecord,
): Promise<void> {
    await store.deleteSession(record.session_id);
    await store.putSession(record);
}

/**
 * The one batch a lapsed session gets on resume: only
 * `session.resume_expired {session_id}`, frozen at the record's
 * next_batch_seq. The next seq is stored first, in the record and in the
 * synchronous copy, as the batcher's freeze does; no stored batch is edited.
 * It is sent once the host re-attaches with a fresh descriptor.
 */
async function freezeResumeExpired(
    env: Environment,
    store: QueueStore,
    storage: SessionSeams['storage'],
    record: SessionRecord,
): Promise<void> {
    const sessionId = record.session_id;
    const batchSeq = Math.max(
        record.next_batch_seq,
        readNumber(storage, seqKey(sessionId)) ?? 0,
    );
    writeItem(storage, seqKey(sessionId), String(batchSeq + 1));
    await store.putSession({ ...record, next_batch_seq: batchSeq + 1 });
    const clock = createClock(env, record.epoch_ms, record.max_session_ms);
    const payload = { session_id: sessionId };
    const event: SdkEvent = {
        id: ulid(env),
        t_ms: clock.now(),
        type: 'session.resume_expired',
        source: 'browser',
        payload,
    };
    await store.putBatch({
        session_id: sessionId,
        batch_seq: batchSeq,
        take: record.take,
        body: JSON.stringify({
            take: record.take,
            batch_seq: batchSeq,
            sent_at_ms: env.dateNow(),
            clock_epoch_ms: record.epoch_ms,
            events: [event],
        }),
        payload_bytes: phpJsonBytes(payload),
    });
}

/**
 * FittVideo.resume() over given seams (author's call 15, spec 6.5). Every
 * stored session is planned with planResume(): a tombstone is skipped and a
 * purge deleted, neither reported. Every other session is opened as a
 * passive session that captures nothing and is entered in the same-id map,
 * so FittVideo.session(descriptor) with its id returns the same object,
 * which can then capture. An owed discard is sent and nothing else
 * (`discarding`); an owed reset is sent first (`interrupted`); a completed
 * stop drains, then finalises with its stored take end (`finalising`); a
 * lapsed token freezes one `session.resume_expired` batch and sends nothing
 * until a fresh descriptor arrives (`resume_expired`); anything else only
 * drains (`interrupted`).
 */
export async function resumeWith(
    options: SessionOptions,
    seams: SessionSeams,
): Promise<ResumeEntry[]> {
    const env = seams.env ?? browserEnvironment(options.environment);
    const store = seams.store ?? (await openStore(seams.indexedDB)).store;
    const shared: SessionSeams = { ...seams, env, store };
    const entries: ResumeEntry[] = [];

    for (const record of await store.listSessions()) {
        const nowMs = env.dateNow();
        const plan = planResume(record, nowMs);
        const state = STATES[plan];
        const held = heldSession(record.session_id);

        if (held !== undefined) {
            // This page already holds it: reported as it is, nothing stored is touched.
            if (state !== undefined) {
                entries.push({
                    session_id: record.session_id,
                    state,
                    session: held,
                });
            }

            continue;
        }

        if (plan === 'tombstone') {
            // Kept, unreported, until it expires.
            continue;
        }

        if (plan === 'purge' || state === undefined) {
            await store.deleteSession(record.session_id);
            removeItem(seams.storage, epochKey(record.session_id));
            removeItem(seams.storage, seqKey(record.session_id));

            continue;
        }

        const read = readDescriptor(record.descriptor);

        if (!read.ok) {
            console.warn(
                `Fitt Video: the stored session ${record.session_id} has a descriptor this version cannot read; it was not resumed.`,
            );

            continue;
        }

        if (
            (plan === 'discard' || plan === 'reset') &&
            nowMs - record.last_activity_ms >
                record.descriptor.queue.abandon_after_ms
        ) {
            // The owed call outlives the purge; its media does not.
            await keepRecordOnly(store, record);
        }

        if (plan === 'resume_expired') {
            await freezeResumeExpired(env, store, seams.storage, record);
        }

        const opening: ResumeOpening = {
            resume: plan === 'finalise' ? 'finalise' : 'drain',
        };
        entries.push({
            session_id: record.session_id,
            state,
            session: openResumed(read.descriptor, options, shared, opening),
        });
    }

    return entries;
}

/** resumeWith(options, browserSeams()). */
export function resume(options: SessionOptions = {}): Promise<ResumeEntry[]> {
    return resumeWith(options, browserSeams());
}
