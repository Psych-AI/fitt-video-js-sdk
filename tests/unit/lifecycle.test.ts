import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/core/clock.ts';
import type { RecordingLimits } from '../../src/core/descriptor.ts';
import { FittVideoError } from '../../src/core/errors.ts';
import type { Lifecycle, Milestone } from '../../src/core/lifecycle.ts';
import { createLifecycle } from '../../src/core/lifecycle.ts';
import type { Phase } from '../../src/core/state.ts';
import { createState } from '../../src/core/state.ts';
import { fakeEnvironment, settle, until } from '../support/fake-env.ts';

const ANSWER: RecordingLimits = {
    countdown_ms: 3000,
    min_duration_ms: 5000,
    max_duration_ms: 600_000,
    extension_ms: 30_000,
    warning_before_end_ms: 15_000,
};
const MONITOR: RecordingLimits = {
    countdown_ms: 0,
    min_duration_ms: 0,
    max_duration_ms: 7_200_000,
    extension_ms: 0,
    warning_before_end_ms: 0,
};

/** Host listeners that run after the rig has recorded the call. */
interface Hooks {
    onMilestone?(milestone: Milestone, lifecycle: Lifecycle): void;
    onPhase?(phase: Phase, lifecycle: Lifecycle): void;
    onError?(code: string, lifecycle: Lifecycle): void;
}

function rig(
    recording = ANSWER,
    resetTake?: () => Promise<void>,
    hooks: Hooks = {},
) {
    const env = fakeEnvironment({ perf: 0 });
    const clock = createClock(env);
    const milestones: [string, number, number?][] = [];
    const reasons: (string | undefined)[] = [];
    const calls: string[] = [];
    const errors: string[] = [];
    let finishReset: () => void = () => {};
    const lifecycle = createLifecycle({
        env,
        clock,
        recording,
        sessionCapMs: 7_200_000,
        engine: {
            startTake: async (takeStartMs) => {
                calls.push(`start@${takeStartMs}`);
            },
            stopTake: async () => {
                calls.push(`stop@${clock.now()}`);
            },
        },
        resetTake: () => {
            calls.push('reset');

            return (
                resetTake?.() ??
                new Promise((resolve) => {
                    finishReset = resolve;
                })
            );
        },
        sealTracks: async (endMs) => {
            calls.push(`seal@${endMs}`);
        },
        onMilestone: (m) => {
            milestones.push(
                m.remaining_ms === undefined
                    ? [m.name, m.t_ms]
                    : [m.name, m.t_ms, m.remaining_ms],
            );
            reasons.push(m.reason);
            hooks.onMilestone?.(m, lifecycle);
        },
        onPhase: (phase) => hooks.onPhase?.(phase, lifecycle),
        onError: (code) => {
            errors.push(code);
            hooks.onError?.(code, lifecycle);
        },
    });
    lifecycle.setPhase('ready');

    return {
        env,
        clock,
        lifecycle,
        milestones,
        reasons,
        calls,
        errors,
        finishReset: () => finishReset(),
    };
}

const rejectsWith = (code: string) => (error: unknown) =>
    error instanceof FittVideoError && error.code === code;

test('the countdown ticks at 3000 and 2000 remaining, says last at 1000, and start() resolves at started', async () => {
    const r = rig();
    let resolved = false;
    const started = r.lifecycle.start().then(() => {
        resolved = true;
    });
    await r.env.advance(2999);
    assert.equal(resolved, false);
    assert.equal(r.lifecycle.phase(), 'countdown');

    await r.env.advance(1);
    await started;
    assert.deepEqual(r.milestones, [
        ['countdown_tick', 0, 3000],
        ['countdown_tick', 1000, 2000],
        ['countdown_last', 2000, 1000],
        ['started', 3000],
    ]);
    assert.deepEqual(r.calls, ['start@3000']);
    assert.equal(r.lifecycle.phase(), 'recording');
    assert.equal(r.lifecycle.takeStartMs(), 3000);
});

test('warning, limit and forced stop come at the answer limits from the started milestone', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(3000);
    await r.env.advance(630_000);
    await until(() => r.lifecycle.phase() === 'stopped');

    assert.deepEqual(r.milestones.slice(4), [
        ['warning', 588_000, 15_000],
        ['limit_reached', 603_000, 30_000],
        ['forced_stop', 633_000],
    ]);
    assert.equal(r.reasons.at(-1), 'limit');
    assert.deepEqual(r.calls, ['start@3000', 'stop@633000', 'seal@633000']);
});

test('stop() during the countdown cancels it, back to ready, and start() rejects countdown_cancelled', async () => {
    const r = rig();
    const start = r.lifecycle.start();
    await r.env.advance(1500);
    await r.lifecycle.stop();

    await assert.rejects(start, rejectsWith('countdown_cancelled'));
    assert.deepEqual(r.milestones.at(-1), ['countdown_cancelled', 1500]);
    assert.equal(r.lifecycle.phase(), 'ready');
    assert.deepEqual(r.calls, []);
});

test('a host stop below the minimum rejects too_short, resets, and is ready only after the reset answer', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(3000);
    await r.env.advance(4999);
    const stopping = r.lifecycle.stop();
    await settle();

    assert.equal(r.lifecycle.phase(), 'stopping');
    assert.deepEqual(r.calls, ['start@3000', 'stop@7999', 'reset']);

    r.finishReset();
    await assert.rejects(stopping, rejectsWith('too_short'));
    assert.equal(r.lifecycle.phase(), 'ready');
    assert.deepEqual(r.milestones.at(-1), ['too_short', 7999]);
});

test('a host stop at exactly the minimum is accepted and seals', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(3000);
    await r.env.advance(5000);
    await r.lifecycle.stop();

    assert.deepEqual(r.calls, ['start@3000', 'stop@8000', 'seal@8000']);
    assert.equal(r.lifecycle.phase(), 'stopped');
});

test('a forced stop below the minimum keeps the take', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(4000);
    await r.lifecycle.stop({ forced: 'left_page' });

    assert.deepEqual(r.calls, ['start@3000', 'stop@4000', 'seal@4000']);
    assert.deepEqual(
        [r.milestones.at(-1), r.reasons.at(-1)],
        [['forced_stop', 4000], 'left_page'],
    );
});

test('a timer that fires 40 s late raises warning and limit once each, in order, from the real time', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(3000);
    r.env.stall(625_000); // now 628,000: warning was due at 588,000 and the limit at 603,000
    await r.env.advance(0);

    assert.deepEqual(
        r.milestones.slice(4).map(([name]) => name),
        ['warning', 'limit_reached'],
    );
    await r.env.advance(5000);
    assert.deepEqual(
        r.milestones.slice(4).map(([name]) => name),
        ['warning', 'limit_reached', 'forced_stop'],
    );
});

test('a monitor take that starts late is stopped 1 s before the session cap, with session_cap_reached', async () => {
    const r = rig(MONITOR);
    r.env.stall(1_000_000);
    await r.lifecycle.start();
    await r.env.advance(6_198_999);
    assert.equal(r.lifecycle.phase(), 'recording');

    await r.env.advance(1);
    await until(() => r.lifecycle.phase() === 'stopped');
    assert.deepEqual(r.milestones.at(-1), ['forced_stop', 7_199_000]);
    assert.equal(r.reasons.at(-1), 'session_cap');
    assert.deepEqual(r.errors, ['session_cap_reached']);
    assert.ok(r.calls.includes('seal@7199000'));
});

test('a forward wall-clock correction mid-take forces no stop: the limits run on performance.now() within the page', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(3000);
    await r.env.advance(5000);
    r.env.shiftWall(900_000);
    assert.ok(r.clock.check());
    await r.env.advance(580_000); // performance time 588,000: only the warning is due

    assert.deepEqual(
        r.milestones.slice(4).map(([name]) => name),
        ['warning'],
    );
    assert.equal(r.lifecycle.phase(), 'recording');
});

test('start() from stopped rejects invalid_state, and stop({sealTracks: false}) leaves the seal to finalise', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(9000);
    await r.lifecycle.stop({ sealTracks: false });

    assert.deepEqual(r.calls, ['start@3000', 'stop@9000']);
    assert.equal(r.lifecycle.unsealedEndMs(), 9000);
    await assert.rejects(r.lifecycle.start(), rejectsWith('invalid_state'));
});

test('a reset refused as invalid_state on the too_short path leaves the phase stopped and still rejects too_short', async () => {
    const r = rig(ANSWER, () =>
        Promise.reject(
            new FittVideoError('invalid_state', { reason: 'session_closed' }),
        ),
    );
    void r.lifecycle.start();
    await r.env.advance(4000);

    await assert.rejects(r.lifecycle.stop(), rejectsWith('too_short'));
    assert.equal(r.lifecycle.phase(), 'stopped');
    assert.deepEqual(r.calls, ['start@3000', 'stop@4000', 'reset']);
});

test('setPhase(ready) after a stop forgets the take, so the next start() runs a new countdown', async () => {
    const r = rig();
    void r.lifecycle.start();
    await r.env.advance(9000);
    await r.lifecycle.stop({ sealTracks: false });
    r.lifecycle.setPhase('ready');

    assert.equal(r.lifecycle.takeStartMs(), null);
    assert.equal(r.lifecycle.unsealedEndMs(), null);
    void r.lifecycle.start();
    assert.equal(r.lifecycle.phase(), 'countdown');
    assert.deepEqual(r.milestones.at(-1), ['countdown_tick', 9000, 3000]);
});

test('resumeTake() skips the countdown and counts the limits from the stored take start', async () => {
    const r = rig();
    r.env.stall(100_000);
    r.lifecycle.resumeTake(10_000);
    await r.lifecycle.start();

    assert.equal(r.lifecycle.phase(), 'recording');
    assert.deepEqual(r.calls, ['start@10000']);
    assert.deepEqual(r.milestones, []);
    await r.env.advance(495_000); // elapsed 585,000 since the stored start
    assert.deepEqual(r.milestones, [['warning', 595_000, 15_000]]);
});

test('recheck() after a forward clock jump brings the forced stop to 1 s before the cap', async () => {
    const r = rig(MONITOR);
    await r.lifecycle.start();
    await r.env.advance(10_000);
    r.env.shiftWall(7_179_000);
    assert.ok(r.clock.check());
    r.lifecycle.recheck(); // session time is now 7,189,000: the cap is 10 s away

    await r.env.advance(10_000);
    await until(() => r.lifecycle.phase() === 'stopped');
    assert.deepEqual(
        [r.milestones.at(-1), r.reasons.at(-1)],
        [['forced_stop', 7_199_000], 'session_cap'],
    );
    assert.ok(r.calls.includes('seal@7199000'));
});

test('a host stop() from the forced_stop milestone joins the forced stop: one stopTake, one seal, no reset', async () => {
    let hostStop: Promise<void> | null = null;
    const r = rig(ANSWER, () => Promise.resolve(), {
        onMilestone: (m, lifecycle) => {
            if (m.name === 'forced_stop') {
                hostStop = lifecycle.stop();
            }
        },
    });
    void r.lifecycle.start();
    await r.env.advance(4000); // 1 s into the take, below the 5 s minimum
    const forced = r.lifecycle.stop({ forced: 'left_page' });

    assert.ok(hostStop !== null);
    await (hostStop as Promise<void>).then(() => r.calls.push('host done'));
    await forced;
    assert.deepEqual(r.calls, [
        'start@3000',
        'stop@4000',
        'seal@4000',
        'host done',
    ]);
    assert.equal(r.lifecycle.phase(), 'stopped');
});

test('a host stop() from onError on the cap path or from onPhase(stopping) waits for the one seal', async () => {
    const hostStops: Promise<void>[] = [];
    const r = rig(MONITOR, undefined, {
        onError: (_code, lifecycle) => hostStops.push(lifecycle.stop()),
        onPhase: (phase, lifecycle) => {
            if (phase === 'stopping') {
                hostStops.push(lifecycle.stop());
            }
        },
    });
    await r.lifecycle.start();
    await r.env.advance(7_198_999);
    await r.env.advance(1);
    assert.equal(hostStops.length, 2);
    await Promise.all(hostStops).then(() => r.calls.push('host done'));

    assert.deepEqual(r.errors, ['session_cap_reached']);
    assert.deepEqual(r.calls.slice(-3), [
        'stop@7199000',
        'seal@7199000',
        'host done',
    ]);
    assert.equal(r.calls.filter((call) => call.startsWith('seal')).length, 1);
});

test('recheck() after a throttled timer let session time pass the cap stops at once and ends the take 1 s before the cap', async () => {
    const r = rig(MONITOR);
    await r.lifecycle.start();
    await r.env.advance(7_150_000);
    r.env.stall(100_000); // hidden tab: the timer has not run, session time is 7,250,000
    r.lifecycle.recheck(); // a cut arrived on time

    await until(() => r.lifecycle.phase() === 'stopped');
    assert.deepEqual(
        [r.milestones.at(-1), r.reasons.at(-1)],
        [['forced_stop', 7_250_000], 'session_cap'],
    );
    assert.deepEqual(r.calls.slice(-2), ['stop@7250000', 'seal@7199000']);
});

test('createState merges a patch and hands out a frozen copy', () => {
    const seen: string[] = [];
    const state = createState((next) => seen.push(next.phase));
    state.patch({ phase: 'ready' });

    assert.deepEqual(seen, ['ready']);
    assert.equal(state.get().phase, 'ready');
    assert.equal(state.get().upload.bytesSent, 0);
    assert.ok(Object.isFrozen(state.get()));
});
