import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffMs } from '../../src/core/backoff.ts';

test('backoff is full jitter from 1 s, doubling, capped at 30 s', () => {
    assert.deepEqual(
        [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffMs(attempt, 0.5)),
        [500, 1000, 2000, 4000, 8000, 15000, 15000],
    );
    assert.equal(backoffMs(3, 0), 0);
    assert.equal(backoffMs(60, 0.999999), 29999);
});
