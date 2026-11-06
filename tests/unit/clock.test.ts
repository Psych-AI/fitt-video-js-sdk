import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import { fakeEnvironment } from '../support/fake-env.ts';

test('on the first page the epoch is timeOrigin plus performance.now, and now() counts from it', () => {
    const env = fakeEnvironment({
        timeOrigin: 1_762_400_000_000,
        perf: 1234.6,
    });
    const clock = createClock(env);

    assert.equal(clock.epochMs, 1_762_400_001_234);
    assert.equal(clock.now(), 0);
    env.stall(1000);
    assert.equal(clock.now(), 1000);
    assert.equal(clock.anchorSource(), 'performance');
});

test('after a reload the stored epoch and Date.now give the time, on the wall clock', () => {
    const env = fakeEnvironment({
        timeOrigin: 1_762_500_000_000,
        perf: 50,
        date: 1_762_400_001_234 + 60_000,
    });
    const clock = createClock(env, 1_762_400_001_234);

    assert.equal(clock.epochMs, 1_762_400_001_234);
    assert.equal(clock.now(), 60_000);
    assert.equal(clock.anchorSource(), 'wall_clock');
});

for (const drift of [2001, -2001]) {
    test(`a drift of ${drift} ms between the clocks is a jump with both readings`, () => {
        const env = fakeEnvironment({ perf: 1234 });
        const clock = createClock(env);
        env.stall(1000);
        env.shiftWall(drift);

        assert.deepEqual(clock.check(), {
            performance_ms: 1000,
            wall_ms: 1000 + drift,
        });
        assert.equal(clock.anchorSource(), 'wall_clock');
        assert.equal(clock.check(), null);
    });
}

test('a drift of exactly 2000 ms is not a jump', () => {
    const env = fakeEnvironment({ perf: 1234 });
    const clock = createClock(env);
    env.stall(1000);
    env.shiftWall(2000);

    assert.equal(clock.check(), null);
    assert.equal(clock.anchorSource(), 'performance');
});

test('now() never goes back and is always a whole number of 0 or more, even after a backward jump', () => {
    const env = fakeEnvironment({ perf: 0 });
    const clock = createClock(env);
    env.stall(5000);
    clock.now();
    env.shiftWall(-10_000);
    assert.notEqual(clock.check(), null);
    let last = -1;

    for (let i = 0; i < 100; i++) {
        env.stall(7);
        const time = clock.now();
        assert.ok(
            Number.isInteger(time) && time >= 0 && time >= last,
            `call ${i} gave ${time}`,
        );
        last = time;
    }

    assert.ok(last >= 5000 + 700);
});

test('a reload with the wall clock behind the floor starts from the floor and reports a jump', () => {
    const epoch = 1_762_400_000_000;
    const env = fakeEnvironment({ date: epoch + 50_000 });
    const clock = createClock(env, epoch, 60_000);

    assert.ok(clock.now() >= 60_000);
    assert.notEqual(clock.check(), null);
    env.stall(1000);
    assert.ok(clock.now() >= 61_000);
});
