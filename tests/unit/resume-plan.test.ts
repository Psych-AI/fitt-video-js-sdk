import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planResume } from '../../src/core/resume-plan.ts';
import { sessionRecord } from '../support/records.ts';

const NOW = 1_762_400_000_000;
const record = (overrides: Parameters<typeof sessionRecord>[0]) =>
    sessionRecord({
        last_activity_ms: NOW - 1000,
        token_expires_at_ms: NOW + 60_000,
        stop_completed: false,
        ...overrides,
    });

test('a finalised session is a tombstone until its expiry, then a purge', () => {
    assert.equal(
        planResume(
            record({
                finalised: true,
                expires_at_ms: NOW + 1,
                last_activity_ms: NOW - 600_001,
            }),
            NOW,
        ),
        'tombstone',
    );
    assert.equal(
        planResume(record({ finalised: true, expires_at_ms: NOW - 1 }), NOW),
        'purge',
    );
});

test('more than abandon_after_ms without activity is a purge, unless a discard or a reset is owed', () => {
    assert.equal(
        planResume(
            record({
                last_activity_ms: NOW - 600_001,
                stop_completed: true,
                token_expires_at_ms: NOW - 1,
            }),
            NOW,
        ),
        'purge',
    );
    assert.notEqual(
        planResume(record({ last_activity_ms: NOW - 600_000 }), NOW),
        'purge',
    );
});

test('a lapsed token is resume_expired, before finalise or interrupted', () => {
    assert.equal(
        planResume(
            record({ token_expires_at_ms: NOW, stop_completed: true }),
            NOW,
        ),
        'resume_expired',
    );
    assert.equal(
        planResume(
            record({ token_expires_at_ms: NOW, stop_completed: false }),
            NOW,
        ),
        'resume_expired',
    );
});

test('a completed stop is finalised, and anything else is interrupted', () => {
    assert.equal(planResume(record({ stop_completed: true }), NOW), 'finalise');
    assert.equal(
        planResume(record({ stop_completed: false, take_open: true }), NOW),
        'interrupted',
    );
    assert.equal(
        planResume(record({ stop_completed: false, take_open: false }), NOW),
        'interrupted',
    );
});

test('a stop is not finalised when a later take is open or the take was rejected', () => {
    assert.equal(
        planResume(record({ stop_completed: true, take_open: true }), NOW),
        'interrupted',
    );
    assert.equal(
        planResume(
            record({
                stop_completed: true,
                take_open: false,
                take: 1,
                rejected_take: 1,
            }),
            NOW,
        ),
        'interrupted',
    );
});

test('an owed reset is finished first, even past the age limit', () => {
    assert.equal(
        planResume(
            record({ stop_completed: true, pending_reset_take: 1 }),
            NOW,
        ),
        'reset',
    );
    assert.equal(
        planResume(
            record({ pending_reset_take: 1, last_activity_ms: NOW - 600_001 }),
            NOW,
        ),
        'reset',
    );
});

test('a discard that never landed is finished first, before an expired token or a stop', () => {
    assert.equal(
        planResume(
            record({ pending_discard: true, stop_completed: true }),
            NOW,
        ),
        'discard',
    );
    assert.equal(
        planResume(
            record({ pending_discard: true, token_expires_at_ms: NOW - 1 }),
            NOW,
        ),
        'discard',
    );
    assert.equal(
        planResume(
            record({ pending_discard: true, last_activity_ms: NOW - 600_001 }),
            NOW,
        ),
        'discard',
    );
});
