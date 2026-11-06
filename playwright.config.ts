import { defineConfig } from '@playwright/test';
import { PROJECTS } from './tests/browser/projects.ts';

export default defineConfig({
    testDir: 'tests/browser',
    outputDir: 'test-results/browser',
    timeout: 60_000,
    use: { baseURL: 'http://127.0.0.1:8124' },
    projects: PROJECTS,
    webServer: {
        command: 'vite -c tests/browser/vite.config.ts',
        url: 'http://127.0.0.1:8124/tests/browser/harness/index.html',
        reuseExistingServer: false,
    },
});
