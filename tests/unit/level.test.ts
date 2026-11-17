import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createSpeakingGate,
    normalisedLevel,
} from '../../src/recorder/level.ts';

test("the level curve is the meter's: 0 at the floor, the square root of rms over 0.25, at most 1", () => {
    assert.equal(normalisedLevel(0), 0);
    assert.equal(normalisedLevel(0.002), 0);
    assert.equal(normalisedLevel(Number.NaN), 0);
    assert.equal(normalisedLevel(0.0625), 0.5);
    assert.equal(normalisedLevel(0.25), 1);
    assert.equal(normalisedLevel(0.9), 1);
});

test('speaking turns on at 0.2 and off only after 300 ms under 0.1', () => {
    const gate = createSpeakingGate();

    assert.equal(gate.update(0.19, 0), false);
    assert.equal(gate.update(0.2, 100), true);
    assert.equal(gate.update(0.15, 200), true);
    assert.equal(gate.update(0.05, 300), true);
    // Back between the thresholds: the 300 ms start again at the next quiet level.
    assert.equal(gate.update(0.12, 550), true);
    assert.equal(gate.update(0.05, 600), true);
    assert.equal(gate.update(0.05, 899), true);
    assert.equal(gate.update(0.05, 900), false);

    gate.update(0.5, 1000);
    gate.reset();
    assert.equal(gate.update(0, 1001), false);
});
