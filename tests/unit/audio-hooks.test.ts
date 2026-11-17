import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AudioFrame } from '../../src/core/audio-hooks.ts';
import { fakeAudioContext } from '../support/fake-audio.ts';
import { recordTake, sessionRig } from '../support/session-rig.ts';

function audioRig(recipe: string) {
    const audio = fakeAudioContext();
    const r = sessionRig({ recipe, audioContext: () => audio.context });

    return { ...r, audio };
}

test('getInputVolume and getOutputVolume are unbound closures on the normalised curve, 0 before prepare and after stop', async () => {
    const r = audioRig('conversation-audio');
    const { getInputVolume, getOutputVolume } = r.session.audio;
    assert.equal(getInputVolume(), 0);
    assert.equal(getOutputVolume(), 0);

    await r.session.prepare();
    // The graph makes the microphone analyser first, then the interviewer's (author's call 9).
    r.audio.analysers[0].level = 0.0625;
    r.audio.analysers[1].level = 0.015625;
    assert.equal(getInputVolume(), 0.5);
    assert.equal(getOutputVolume(), 0.25);

    // Capture is released at stop: every level reads 0 again.
    await recordTake(r, 6000);
    assert.equal(getInputVolume(), 0);
    assert.equal(getOutputVolume(), 0);
});

test('an audio-only answer has no output side', async () => {
    const r = audioRig('answer-audio');
    await r.session.prepare();

    assert.equal(r.audio.analysers.length, 1);
    assert.equal(r.session.audio.getOutputVolume(), 0);
});

test('onFrame runs only with a listener, stops on a hidden tab, starts again when visible, and reuses its bands', async () => {
    const r = audioRig('conversation-audio');
    await r.session.prepare();
    r.audio.analysers[0].level = 0.0625;
    r.audio.analysers[1].level = 0.015625;
    const frames: AudioFrame[] = [];
    const stop = r.session.audio.onFrame((frame) => frames.push({ ...frame }));

    await r.env.advance(48);
    assert.equal(frames.length, 3);
    // level is on the curve; peak is the raw sample peak (author's call 9).
    assert.deepEqual([frames[0].level, frames[0].peak], [0.5, 0.0625]);
    assert.equal(frames[0].bands, frames[1].bands);
    assert.equal(frames[0].bands.length, 8);

    const doc = r.page.doc as unknown as {
        visibilityState: string;
    } & EventTarget;
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await r.env.advance(64);
    assert.equal(frames.length, 3);

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await r.env.advance(32);
    assert.equal(frames.length, 5);

    stop();
    await r.env.advance(48);
    assert.equal(frames.length, 5);
});

test('the bands are log spaced from 100 Hz to 8 kHz', async () => {
    const r = audioRig('answer-audio');
    await r.session.prepare();
    // 48 kHz over 2048 points: 23.4375 Hz a bin. Bins 0 to 21 are below the fourth band's 517 Hz.
    r.audio.analysers[0].bins = new Uint8Array(1024).fill(255, 0, 22);
    let seen: number[] = [];
    const stop = r.session.audio.onFrame((frame) => {
        seen = Array.from(frame.bands);
    });

    await r.env.advance(16);
    assert.deepEqual(seen, [1, 1, 1, 0, 0, 0, 0, 0]);

    r.audio.analysers[0].bins = new Uint8Array(1024).fill(255);
    await r.env.advance(16);
    assert.deepEqual(seen, [1, 1, 1, 1, 1, 1, 1, 1]);
    stop();
});

test("stream is the graph's microphone-only stream, kept across a device switch, and createAnalyser taps the SDK's context with no second capture", async () => {
    const r = audioRig('answer-audio');
    let changes = 0;
    r.session.audio.onChange(() => {
        changes += 1;
    });
    assert.equal(r.session.audio.stream, null);
    assert.equal(r.session.audio.context, null);
    assert.equal(r.session.audio.createAnalyser(), null);

    await r.session.prepare();
    const stream = r.session.audio.stream;
    assert.ok(stream !== null);
    assert.notEqual(stream, r.session.stream);
    assert.equal(r.session.audio.context, r.audio.context);
    const tap = r.session.audio.createAnalyser({
        fftSize: 512,
        smoothingTimeConstant: 0.5,
    });
    assert.ok(tap !== null);
    assert.deepEqual([tap.fftSize, tap.smoothingTimeConstant], [512, 0.5]);
    assert.equal(r.media.calls(), 1);
    assert.equal(changes, 1);

    // The fake acquires again for any deviceId (fake-media.ts:140-170); mic-1 is the id it lists.
    await r.session.devices.select('microphone', 'mic-1');
    assert.equal(r.media.calls(), 2);
    assert.equal(r.session.audio.stream, stream);

    await recordTake(r, 6000);
    assert.equal(r.session.audio.stream, null);
    assert.ok(changes >= 3);
});

test('reset() after stop acquires capture again: the stream is live and onChange fires once reset resolves', async () => {
    const r = audioRig('answer-audio');
    await r.session.prepare();
    await recordTake(r, 6000);
    assert.equal(r.session.state.phase, 'stopped');
    assert.equal(r.session.audio.stream, null);
    let changes = 0;
    r.session.audio.onChange(() => {
        changes += 1;
    });

    await r.session.reset();

    assert.equal(r.session.state.phase, 'ready');
    assert.ok(r.session.audio.stream !== null);
    assert.equal(r.session.audio.context, r.audio.context);
    assert.ok(r.session.audio.createAnalyser() !== null);
    assert.ok(changes >= 1);
});
