import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSilenceDetector } from '../../src/recorder/silence.ts';

function rig() {
    const events: [string, Record<string, unknown>][] = [];
    const states: string[] = [];
    const detector = createSilenceDetector({
        emit: (type, payload) => events.push([type, payload]),
        onState: (state) => states.push(state),
    });

    return { detector, events, states };
}

test('a level below 0.01 for 5000 ms is one device.no_audio, and sound again is one audio_resumed', () => {
    const { detector, events, states } = rig();

    for (let t = 0; t <= 4900; t += 100) {
        detector.sample(0.005, t, 'recording');
    }

    assert.deepEqual(events, []);
    detector.sample(0.005, 5000, 'recording');
    detector.sample(0.005, 5100, 'recording');
    assert.deepEqual(events, [['device.no_audio', { silent_ms: 5000 }]]);
    assert.equal(detector.state(), 'silent');

    detector.sample(0.02, 5200, 'recording');
    detector.sample(0.03, 5300, 'recording');
    assert.deepEqual(
        events.map(([type]: [string, Record<string, unknown>]) => type),
        ['device.no_audio', 'device.audio_resumed'],
    );
    assert.deepEqual(states, ['silent', 'ok']);
});

test('the detector runs in ready and recording only, and restarts its count elsewhere', () => {
    const { detector, events } = rig();

    for (let t = 0; t <= 4000; t += 100) {
        detector.sample(0.001, t, 'ready');
    }

    detector.sample(0.001, 4100, 'countdown');

    for (let t = 4200; t <= 9100; t += 100) {
        detector.sample(0.001, t, 'recording');
    }

    assert.deepEqual(events, []);
    detector.sample(0.001, 9200, 'recording');
    assert.deepEqual(events, [['device.no_audio', { silent_ms: 5000 }]]);
});
