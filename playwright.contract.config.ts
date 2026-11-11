import { defineConfig } from '@playwright/test';
import { PROJECTS } from './tests/browser/projects.ts';
import { CONTRACT_DIRECT_ENV, CONTRACT_ENV, REPO_ROOT } from './tests/contract/env.ts';

export default defineConfig({
    testDir: 'tests/contract',
    outputDir: 'test-results/contract',
    timeout: 120_000,
    workers: 1, // one testing database, shared by both PHP servers
    globalSetup: './tests/contract/global-setup.ts',
    globalTeardown: './tests/contract/global-teardown.ts',
    use: { baseURL: 'http://127.0.0.1:8124' },
    projects: PROJECTS,
    webServer: [
        {
            command:
                'php artisan serve --host=127.0.0.1 --port=8123 --no-reload',
            cwd: REPO_ROOT,
            url: 'http://127.0.0.1:8123/up',
            env: CONTRACT_ENV,
            reuseExistingServer: false,
            timeout: 60_000,
        },
        {
            command: 'vite -c tests/browser/vite.config.ts',
            url: 'http://127.0.0.1:8124/tests/browser/harness/index.html',
            reuseExistingServer: false,
        },
        {
            // The direct rung (Plan 8): the s3 driver on MinIO, on the same testing database.
            command:
                'php artisan serve --host=127.0.0.1 --port=8126 --no-reload',
            cwd: REPO_ROOT,
            url: 'http://127.0.0.1:8126/up',
            env: CONTRACT_DIRECT_ENV,
            reuseExistingServer: false,
            timeout: 60_000,
        },
        {
            command: 'node tests/contract/proxy.ts',
            url: 'http://127.0.0.1:8125/__counts',
            reuseExistingServer: false,
        },
    ],
});
