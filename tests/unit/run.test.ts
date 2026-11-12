import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import type { ChunkedTrack } from '../../src/core/descriptor.ts';
import type { RunRecord, SegmentRecord } from '../../src/core/store.ts';
import { createRun, type RecorderFactory } from '../../src/recorder/run.ts';
import {
    fakeEnvironment,
    until,
    type FakeEnvironment,
} from '../support/fake-env.ts';
import { aligned, readSet } from '../support/fixtures.ts';
import { descriptorFixture, SID } from '../support/records.ts';

class FakeRecorder extends EventTarget {
    mimeType: string;
    state = 'inactive';
    private next = 0;
    private readonly env: FakeEnvironment;
    private readonly chunks: Uint8Array[];

    constructor(env: FakeEnvironment, chunks: Uint8Array[], mimeType: string) {
        super();
        this.env = env;
        this.chunks = chunks;
        this.mimeType = mimeType;
    }

    start(timeslice: number): void {
        this.state = 'recording';
        this.env.timers.setTimeout(
            () => this.dispatchEvent(new Event('start')),
            2,
        );
        const tick = (): void => {
            if (
                this.state === 'recording' &&
                this.next < this.chunks.length - 1
            ) {
                this.deliver();
                this.env.timers.setTimeout(tick, timeslice);
            }
        };
        this.env.timers.setTimeout(tick, timeslice);
    }

    stop(): void {
        this.state = 'inactive';
        this.env.timers.setTimeout(() => {
            while (this.next < this.chunks.length) {
                this.deliver();
            }

            this.dispatchEvent(new Event('stop'));
        }, 500);
    }

    private deliver(): void {
        const event = new Event('dataavailable');
        Object.defineProperty(event, 'data', {
            value: new Blob([this.chunks[this.next++] as BlobPart]),
        });
        this.dispatchEvent(event);
    }
}

function rig(
    options: {
        onRecorderError?: () => void;
        /** The error add() rejects with for this record, or null to store it. */
        addFails?: (record: SegmentRecord) => Error | null;
        /** The error putRun() rejects with for this record, or null. */
        putRunFails?: (record: RunRecord) => Error | null;
    } = {},
) {
    const env = fakeEnvironment({ perf: 0 });
    const clock = createClock(env);
    const whole = readSet('chrome-vp8-kf').whole;
    const chunks = Array.from({ length: 60 }, (_, i) =>
        whole.subarray(
            Math.floor((i * whole.length) / 60),
            Math.floor(((i + 1) * whole.length) / 60),
        ),
    );
    const made: { options: MediaRecorderOptions; recorder: FakeRecorder }[] =
        [];
    const factory: RecorderFactory = (_stream, options) => {
        const recorder = new FakeRecorder(env, chunks, options.mimeType ?? '');
        made.push({ options, recorder });

        return recorder;
    };
    const stored: SegmentRecord[] = [];
    /** The nonKeyframeStart argument of each stored add(), in order. */
    const flags: (boolean | undefined)[] = [];
    const events: [string, Record<string, unknown>][] = [];
    const run = createRun({
        env,
        clock,
        sessionId: SID,
        take: 1,
        runIndex: 0,
        track: descriptorFixture('answer').tracks[0] as ChunkedTrack,
        stream: {} as MediaStream,
        mimeType: 'video/webm;codecs=vp8,opus',
        bitrates: { video: 300_000, audio: 32_000 },
        recorderFactory: factory,
        add: async (record, nonKeyframeStart) => {
            const failure = options.addFails?.(record) ?? null;

            if (failure !== null) {
                throw failure;
            }

            stored.push(record);
            flags.push(nonKeyframeStart);
        },
        putRun: async (record) => {
            const failure = options.putRunFails?.(record) ?? null;

            if (failure !== null) {
                throw failure;
            }
        },
        emit: (type, payload) => events.push([type, payload]),
        onRecorderError: options.onRecorderError ?? (() => {}),
        ua: 'Mozilla/5.0 (test)',
    });

    return { env, clock, run, made, stored, flags, events };
}

test('a replayed recording becomes the init at the anchor and media at anchor plus media time', async () => {
    const r = rig();
    r.env.stall(10);
    await r.run.start();
    await r.env.advance(59_000);
    const stopping = r.run.stop('stop');
    await r.env.advance(500);
    const record = await stopping;
    const expected = aligned('chrome-vp8-kf').fragments;

    assert.deepEqual(
        r.made.map((m) => m.options),
        [
            {
                mimeType: 'video/webm;codecs=vp8,opus',
                videoBitsPerSecond: 300_000,
                audioBitsPerSecond: 32_000,
                videoKeyFrameIntervalDuration: 5000,
            },
        ],
    );
    assert.deepEqual(
        [
            record.started_ms,
            record.anchor_ms,
            record.anchor_source,
            record.segmenting,
            record.keyframe_option_honoured,
            record.ended_reason,
        ],
        [10, 12, 'performance', 'cluster', true, 'stop'],
    );
    assert.deepEqual(
        r.stored.map((s) => s.start_ms),
        expected.map((f, i) => (i === 0 ? 12 : 12 + f.start_ms)),
    );
    assert.deepEqual(
        r.stored.map((s) => s.sha256),
        expected.map((f) => f.sha256),
    );
    assert.deepEqual(
        [r.stored[0].kind, r.stored[0].duration_ms, r.stored[0].init],
        [
            'init',
            0,
            {
                anchor_ms: 12,
                anchor_source: 'performance',
                mime: 'video/webm;codecs=vp8,opus',
                started_ms: 10,
            },
        ],
    );
    assert.ok(
        r.stored
            .slice(1)
            .every(
                (s) =>
                    s.kind === 'media' &&
                    s.init === null &&
                    s.run_id === record.run_id,
            ),
    );
    assert.deepEqual(
        r.stored.map((s) => s.seq),
        expected.map((_, i) => i),
    );
});

test('every stored segment hands add() its non-keyframe flag, false for keyframe-led cuts', async () => {
    const r = rig();
    r.env.stall(10);
    await r.run.start();
    await r.env.advance(59_000);
    const stopping = r.run.stop('stop');
    await r.env.advance(500);
    await stopping;

    assert.equal(r.flags.length, r.stored.length);
    assert.ok(r.flags.every((flag) => flag === false));
});

test('stop() resolves only after the last blob, 500 ms later, is cut and stored', async () => {
    const r = rig();
    await r.run.start();
    await r.env.advance(59_000);
    let resolved = false;
    const stopping = r.run.stop('stop').then(() => {
        resolved = true;
    });
    await r.env.advance(499);
    assert.equal(resolved, false);

    await r.env.advance(1);
    await stopping;
    assert.equal(
        r.stored.at(-1)!.sha256,
        aligned('chrome-vp8-kf').fragments.at(-1)!.sha256,
    );
});

test('the run reports recorder.started at the start event and recorder.stopped with its reason', async () => {
    const r = rig();
    await r.run.start();
    await r.env.advance(10);
    const stopping = r.run.stop('stop');
    await r.env.advance(500);
    const record = await stopping;

    assert.deepEqual(
        r.events.filter(
            ([type]) =>
                type === 'recorder.started' || type === 'recorder.stopped',
        ),
        [
            [
                'recorder.started',
                {
                    track: 'camera',
                    run_id: record.run_id,
                    mime_type: 'video/webm;codecs=vp8,opus',
                },
            ],
            [
                'recorder.stopped',
                { track: 'camera', run_id: record.run_id, reason: 'stop' },
            ],
        ],
    );
});

test('a recorder error ends the run with recorder_error, then hands over to the engine', async () => {
    let handedOver = 0;
    const r = rig({ onRecorderError: () => handedOver++ });
    await r.run.start();
    await r.env.advance(2_010);
    const error = new Event('error');
    Object.defineProperty(error, 'error', {
        value: new DOMException('broken', 'UnknownError'),
    });
    r.made[0].recorder.dispatchEvent(error);
    await r.env.advance(500);
    await until(() => handedOver > 0);

    assert.equal(handedOver, 1);
    assert.equal(r.run.record().ended_reason, 'recorder_error');
    assert.deepEqual(
        r.events.find(([type]) => type === 'recorder.error')?.[1],
        { track: 'camera', run_id: r.run.runId, name: 'UnknownError' },
    );
    assert.equal(
        r.stored.at(-1)!.sha256,
        aligned('chrome-vp8-kf').fragments.at(-1)!.sha256,
    );
});

test('a failed store is reported and never fails the take: the later segments are stored and stop() resolves', async () => {
    const quota = () =>
        new DOMException('the disk is full', 'QuotaExceededError');
    const r = rig({
        addFails: (record) => (record.seq === 2 ? quota() : null),
    });
    await r.run.start();
    await r.env.advance(59_000);
    const stopping = r.run.stop('stop');
    await r.env.advance(500);
    const record = await stopping;
    const expected = aligned('chrome-vp8-kf').fragments;

    assert.equal(record.ended_reason, 'stop');
    assert.deepEqual(
        r.events.filter(([type]) => type === 'recorder.store_failed'),
        [
            [
                'recorder.store_failed',
                {
                    track: 'camera',
                    run_id: record.run_id,
                    seq: 2,
                    name: 'QuotaExceededError',
                },
            ],
        ],
    );
    assert.deepEqual(
        r.stored.map((s) => s.seq),
        expected.map((_, i) => i).filter((seq) => seq !== 2),
    );
    assert.ok(r.events.some(([type]) => type === 'recorder.stopped'));
});

test('the last cut and the ended run record failing to store still stop the run with recorder.stopped', async () => {
    const last = aligned('chrome-vp8-kf').fragments.length - 1;
    const failure = () => new DOMException('broken', 'UnknownError');
    const r = rig({
        addFails: (record) => (record.seq === last ? failure() : null),
        putRunFails: (record) =>
            record.ended_reason !== null ? failure() : null,
    });
    await r.run.start();
    await r.env.advance(59_000);
    const stopping = r.run.stop('stop');
    await r.env.advance(500);
    const record = await stopping;

    assert.equal(record.ended_reason, 'stop');
    assert.deepEqual(
        r.events
            .filter(([type]) => type === 'recorder.store_failed')
            .map(([, payload]) => payload.seq),
        [last, null],
    );
    assert.deepEqual(r.events.at(-1), [
        'recorder.stopped',
        { track: 'camera', run_id: record.run_id, reason: 'stop' },
    ]);
});
