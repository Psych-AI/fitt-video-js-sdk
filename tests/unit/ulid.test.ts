import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ulid } from '../../src/core/ulid.ts';
import { fakeEnvironment } from '../support/fake-env.ts';

test('ULIDs are 26 lower-case Crockford characters, unique, with the time first', () => {
    const env = fakeEnvironment({ date: 1_762_400_000_000 });
    const seen = new Set<string>();

    for (let i = 0; i < 10_000; i++) {
        const id = ulid(env);
        assert.match(id, /^[0-9a-hjkmnp-tv-z]{26}$/);
        seen.add(id);
    }

    assert.equal(seen.size, 10_000);
    assert.equal(ulid(env).slice(0, 10), '01k9bkkp00');
});
