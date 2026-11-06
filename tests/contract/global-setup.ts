import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CONTRACT_ENV, REPO_ROOT } from './env.ts';
import { assertTestingDatabase } from './guard.ts';
import { videoDirNames } from './video-dirs.ts';

export const VIDEO_DIR = `${REPO_ROOT}storage/app/private/videos`;

function artisan(args: string[]): string {
    return execFileSync('php', args, {
        cwd: REPO_ROOT,
        env: { ...process.env, ...CONTRACT_ENV },
        encoding: 'utf8',
    });
}

/** Creates a space that allows one origin and returns a plaintext key for it. */
function spaceKey(name: string, origin: string): string {
    const space = artisan([
        'artisan',
        'video:space:create',
        name,
        `--origin=${origin}`,
    ]);
    const slug = /^Slug: (.+)$/m.exec(space)?.[1]?.trim();

    if (slug === undefined) {
        throw new Error(`video:space:create printed no slug:\n${space}`);
    }

    const key = artisan(['artisan', 'video:key:create', slug, 'contract']);
    const plaintext = /^(fvk_\S+)$/m.exec(key)?.[1];

    if (plaintext === undefined) {
        throw new Error(`video:key:create printed no key:\n${key}`);
    }

    return plaintext;
}

export default async function globalSetup(): Promise<void> {
    assertTestingDatabase(artisan, () =>
        existsSync(`${REPO_ROOT}bootstrap/cache/config.php`),
    );
    artisan(['artisan', 'migrate:fresh', '--force']);

    process.env.FITT_CONTRACT_KEY = spaceKey(
        'SDK contract',
        'http://127.0.0.1:8124',
    );
    process.env.FITT_CONTRACT_KEY_OTHER = spaceKey(
        'SDK other origin',
        'http://127.0.0.1:8199',
    );
    process.env.FITT_CONTRACT_VIDEO_DIRS = JSON.stringify(
        videoDirNames(VIDEO_DIR),
    );

    // Playwright starts every webServer before global setup, so the guard cannot
    // see the server's database. A key that exists only in testing proves it.
    const me = await fetch('http://127.0.0.1:8123/api/v1/me', {
        headers: {
            Authorization: `Bearer ${process.env.FITT_CONTRACT_KEY}`,
            Accept: 'application/json',
        },
    });

    if (me.status !== 200) {
        throw new Error(
            `The API server on 8123 does not read the testing database (answered ${me.status}); is --no-reload missing?`,
        );
    }
}
