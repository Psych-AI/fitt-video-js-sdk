import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertTestingDatabase } from '../contract/guard.ts';
import { videoDirNames, videoDirsToDelete } from '../contract/video-dirs.ts';

test('the contract setup refuses any database but testing, before anything migrates', () => {
    const ran: string[][] = [];
    const artisan = (args: string[]): string => {
        ran.push(args);

        return args.includes('tinker') ? 'video\n' : '';
    };

    assert.throws(
        () => assertTestingDatabase(artisan, () => false),
        /testing database, not "video"/,
    );
    assert.ok(!ran.some((args) => args.includes('migrate:fresh')));
});

test('a cached config is refused, because it ignores the environment', () => {
    assert.throws(
        () =>
            assertTestingDatabase(
                () => 'testing\n',
                () => true,
            ),
        /config:clear/,
    );
});

test('the testing database passes', () => {
    assert.doesNotThrow(() =>
        assertTestingDatabase(
            () => 'testing\n',
            () => false,
        ),
    );
});

test('the video folders of a fresh checkout, where the folder does not exist, are an empty list', () => {
    const root = mkdtempSync(join(tmpdir(), 'fitt-video-dirs-'));

    try {
        assert.deepEqual(videoDirNames(join(root, 'videos')), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an empty video folder is an empty list', () => {
    const root = mkdtempSync(join(tmpdir(), 'fitt-video-dirs-'));

    try {
        mkdirSync(join(root, 'videos'));
        assert.deepEqual(videoDirNames(join(root, 'videos')), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a video folder holding two names lists both', () => {
    const root = mkdtempSync(join(tmpdir(), 'fitt-video-dirs-'));

    try {
        mkdirSync(join(root, 'videos', 'b'), { recursive: true });
        mkdirSync(join(root, 'videos', 'a'));
        assert.deepEqual(videoDirNames(join(root, 'videos')).sort(), [
            'a',
            'b',
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the teardown deletes only the folders the run added', () => {
    assert.deepEqual(
        videoDirsToDelete(['a', 'b', 'c'], JSON.stringify(['a'])),
        ['b', 'c'],
    );
});

test('a setup that stopped before it recorded the folders deletes nothing', () => {
    // Playwright runs the teardown even when the setup throws (the guard refusing a database).
    assert.deepEqual(videoDirsToDelete(['a', 'b'], undefined), []);
});
