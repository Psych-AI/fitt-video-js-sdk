import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from '../../src/version.ts';

test('VERSION is 1.4.0 and equals the package version', () => {
    const manifest = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    assert.equal(VERSION, '1.4.0');
    assert.equal(manifest.version, VERSION);
});
