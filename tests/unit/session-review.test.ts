import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionWith } from '../../src/core/session.ts';
import { MemoryQueueStore, type SegmentRecord } from '../../src/core/store.ts';
import { fakeEnvironment } from '../support/fake-env.ts';
import { fakeMedia } from '../support/fake-media.ts';
import { fakeObjectUrls } from '../support/fake-video.ts';
import { descriptorFixture } from '../support/records.ts';
import { recordTake, rigSeams, sessionRig } from '../support/session-rig.ts';

/** The first four chrome-vp8-kf blobs: a 571-byte head (5 cues) plus 958,475 media bytes. */
const HELD = 959_046;

type RigOptions = NonNullable<Parameters<typeof sessionRig>[0]>;

function answerRig(options: RigOptions = {}) {
    return sessionRig({
        recipe: 'answer',
        chunks: true,
        objectUrls: fakeObjectUrls(),
        ...options,
    });
}

/** Counts putSegment calls on a memory store. */
function counted(store: MemoryQueueStore): () => number {
    let puts = 0;
    const put = store.putSegment.bind(store);
    store.putSegment = async (record: SegmentRecord) => {
        puts++;

        return put(record);
    };

    return () => puts;
}

test('a stopped answer take holds one camera copy in memory, and the state says so', async () => {
    const r = answerRig();
    assert.equal(r.session.state.playback.local, 'empty');
    await recordTake(r, 6000);

    assert.deepEqual(r.session.state.playback, {
        source: 'none',
        local: 'held',
        localBytes: HELD,
        localReason: null,
        objectUrls: 0,
        revoked: 0,
    });
});

test('the copy writes nothing to the store', async () => {
    const withCopy = new MemoryQueueStore();
    const without = new MemoryQueueStore();
    const putsWith = counted(withCopy);
    const putsWithout = counted(without);
    const held = answerRig({ store: withCopy });
    await recordTake(held, 6000);
    await recordTake(
        answerRig({ store: without, options: { playback: { local: false } } }),
        6000,
    );

    assert.equal(held.session.state.playback.local, 'held');
    assert.equal(held.session.state.playback.localBytes, HELD);
    assert.ok(putsWith() > 0);
    assert.equal(putsWith(), putsWithout());
});

test('a second run on the take drops the copy and the take still uploads', async () => {
    const r = answerRig({ options: { debug: true } });
    await r.session.prepare();
    const starting = r.session.start();
    await r.env.advance(3000);
    await starting;
    await r.env.advance(2000);
    // The old run's recorder fires stop on a fake timer, so the restart settles only as time moves.
    const restarting = r.session.debug!.restartRun();
    await r.env.advance(10);
    await restarting;
    await r.env.advance(4000);
    const stopping = r.session.stop();
    await r.env.advance(10);
    await stopping;
    await r.env.advance(6000);

    const runs = (await r.store.listRuns(r.descriptor.session_id)).filter(
        (run) => run.track === 'camera',
    );
    assert.deepEqual(
        runs.map((run) => [run.run_index, run.ended_reason]),
        [
            [0, 'device_switch'],
            [1, 'stop'],
        ],
    );
    assert.deepEqual(
        [
            r.session.state.playback.local,
            r.session.state.playback.localReason,
            r.session.state.playback.localBytes,
        ],
        ['off', 'second_run', 0],
    );
    assert.ok(
        r
            .segmentCalls()
            .some((call) => call.url.includes('/tracks/camera/segments/')),
    );
});

const CLEARS: [
    string,
    (r: ReturnType<typeof answerRig>) => Promise<void> | void,
][] = [
    [
        'reset',
        async (r) => {
            const resetting = r.session.reset();
            await r.env.advance(10);
            await resetting;
        },
    ],
    [
        'discard',
        async (r) => {
            const discarding = r.session.discard();
            await r.env.advance(10);
            await discarding;
        },
    ],
    ['destroy', (r) => r.session.destroy()],
    ['unload', (r) => void r.page.win.dispatchEvent(new Event('pagehide'))],
];

for (const [reason, act] of CLEARS) {
    test(`${reason} clears the copy`, async () => {
        const r = answerRig();
        await recordTake(r, 6000);
        await act(r);

        assert.deepEqual(
            [
                r.session.state.playback.local,
                r.session.state.playback.localReason,
                r.session.state.playback.localBytes,
            ],
            ['cleared', reason, 0],
        );
    });
}

test('a too_short stop clears the copy as a reset', async () => {
    const r = answerRig();
    await r.session.prepare();
    const starting = r.session.start();
    await r.env.advance(3000);
    await starting;
    await r.env.advance(2000);
    const stopping = r.session.stop().catch((error: unknown) => error);
    await r.env.advance(10);

    assert.equal(((await stopping) as { code?: string }).code, 'too_short');
    await r.env.advance(100);
    assert.equal(r.session.state.phase, 'ready');
    assert.deepEqual(
        [
            r.session.state.playback.local,
            r.session.state.playback.localReason,
            r.session.state.playback.localBytes,
        ],
        ['cleared', 'reset', 0],
    );
});

test('opening the next session drops the previous copy', async () => {
    const r = answerRig();
    await recordTake(r, 6000);
    const next = descriptorFixture('answer');
    next.session_id = '01jbz8q4w6x0k3m5n7p9r2t4zz';
    const env = fakeEnvironment();
    sessionWith(
        next,
        {},
        rigSeams(env, new MemoryQueueStore(), fakeMedia(env, { chunks: [] })),
    );

    assert.deepEqual(
        [r.session.state.playback.local, r.session.state.playback.localReason],
        ['cleared', 'next_session'],
    );
});

test('a host that turns local playback off, a descriptor that does not allow it, and a page without object URLs never hold a copy', async () => {
    const denied = descriptorFixture('answer');
    denied.playback = { ...denied.playback!, local: false };
    const missing = descriptorFixture('answer');
    delete missing.playback;
    const rigs = [
        answerRig({ options: { playback: { local: false } } }),
        answerRig({ descriptor: denied }),
        answerRig({ descriptor: missing }),
        sessionRig({ recipe: 'answer', chunks: true }),
    ];

    for (const r of rigs) {
        await recordTake(r, 6000);
    }

    assert.deepEqual(
        rigs.map((r) => [
            r.session.state.playback.local,
            r.session.state.playback.localReason,
        ]),
        [
            ['off', 'host_off'],
            ['off', 'not_allowed'],
            ['off', 'not_allowed'],
            ['off', 'unsupported'],
        ],
    );
});
