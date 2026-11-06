import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import { groupOf, hostType } from '../../src/core/event-types.ts';
import {
    createEventBus,
    phpJsonBytes,
    type SdkEvent,
} from '../../src/core/events.ts';
import { fakeEnvironment } from '../support/fake-env.ts';

function bus(groups: string[] = ['device', 'recorder', 'net', 'attention']) {
    const env = fakeEnvironment();
    const clock = createClock(env);
    const queued: SdkEvent[] = [];
    const order: string[] = [];
    const events = createEventBus({
        env,
        clock,
        groups,
        onQueued: (event) => {
            order.push('queued');
            queued.push(event);
        },
    });
    events.on(() => order.push('listener'));

    return { env, events, queued, order };
}

test('every event has a ULID id and a whole t_ms of 0 or more, and listeners run before it is queued', () => {
    const { env, events, queued, order } = bus();
    env.stall(1234.7);
    const event = events.emit('net.offline');

    assert.ok(event);
    assert.match(event.id, /^[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(event.t_ms, 1234);
    assert.equal(event.source, 'browser');
    assert.deepEqual(queued, [event]);
    assert.deepEqual(order, ['listener', 'queued']);
});

test('host events get the host. prefix and are checked locally', () => {
    const { events, queued } = bus();

    assert.equal(events.host('answer_saved', { question: 7 }), true);
    assert.deepEqual(
        [queued[0].type, queued[0].source, queued[0].payload],
        ['host.answer_saved', 'host', { question: 7 }],
    );
    assert.equal(events.host('question.shown'), true);
    assert.equal(queued[1].type, 'host.question.shown');
    assert.equal(hostType('host.question_shown'), 'host.question_shown');

    for (const refused of [
        'Bad Type',
        'upload.events_gap',
        'upload.events_silent',
        `a${'b'.repeat(60)}`,
        '',
    ]) {
        assert.equal(events.host(refused), false, refused);
    }

    assert.equal(queued.length, 2);
});

test('the answer groups drop browser.copy and keep session.clock_jump and enforce.leave_tick', () => {
    const { events } = bus();

    assert.equal(events.emit('browser.copy', { length: 5 }), null);
    assert.ok(
        events.emit('session.clock_jump', { performance_ms: 1, wall_ms: 3000 }),
    );
    assert.ok(events.emit('enforce.leave_tick', { remaining_ms: 9000 }));
    assert.ok(events.emit('upload.chunk_sent', { track: 'camera', seq: 1 }));
    assert.deepEqual(
        [
            'browser.copy',
            'browser.hidden',
            'browser.idle',
            'device.no_audio',
            'page.duplicate_tab',
            'recorder.milestone',
            'host.x',
        ].map(groupOf),
        [
            'clipboard',
            'attention',
            'input',
            'device',
            'page',
            'always',
            'always',
        ],
    );
});

test('a payload over 16,000 JSON bytes is replaced by its size', () => {
    const { events } = bus();
    const event = events.emit('device.no_audio', { text: 'x'.repeat(15_990) });

    assert.deepEqual(event?.payload, { truncated: true, bytes: 16_001 });
    assert.deepEqual(
        events.emit('device.no_audio', { text: 'x'.repeat(15_989) })?.payload,
        { text: 'x'.repeat(15_989) },
    );
});

test('U+2028 counts 6 bytes and an exponent number 2 more, as PHP json_encode writes them', () => {
    const { events } = bus();

    assert.equal(phpJsonBytes({ a: 1e-7, b: [2e21] }), 26);
    assert.deepEqual(
        events.emit('device.no_audio', { text: '\u2028'.repeat(5000) })
            ?.payload,
        { truncated: true, bytes: 30_011 },
    );
    assert.deepEqual(
        events.emit('device.no_audio', { text: '\u2028'.repeat(2664) })
            ?.payload,
        { text: '\u2028'.repeat(2664) },
    );
});

test('payloads are made well-formed before they are queued, and "" and " " count as the null Laravel makes of them', () => {
    const { events, queued } = bus();

    assert.equal(phpJsonBytes({ a: '', b: ' ' }), 19);
    assert.equal(events.host('quiz.answer', 'text' as never), true);
    assert.deepEqual(queued[0].payload, { value: 'text' });
    assert.equal(
        events.host('quiz.answer', { t: 'a\u0000b', e: '\uD83D' }),
        true,
    );
    assert.deepEqual(queued[1].payload, { t: 'a\uFFFDb', e: '\uFFFD' });
});

test('a payload JSON cannot write is refused, and a listener that throws never costs the event', () => {
    const { events, queued } = bus();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    assert.equal(events.host('quiz.answer', cycle), false);
    assert.equal(queued.length, 0);

    const original = console.error;
    console.error = () => {};
    events.on(() => {
        throw new Error('host bug');
    });

    try {
        assert.ok(events.emit('net.online'));
    } finally {
        console.error = original;
    }

    assert.equal(queued.length, 1);
});
