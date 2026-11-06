import type { PlaywrightTestProject } from '@playwright/test';
import { devices } from '@playwright/test';

/** The three engines. Chromium and Firefox use their own fake capture devices; WebKit has none (support/media.ts). */
export const PROJECTS: PlaywrightTestProject[] = [
    {
        name: 'chromium',
        use: {
            ...devices['Desktop Chrome'],
            launchOptions: {
                args: [
                    '--use-fake-device-for-media-stream',
                    '--use-fake-ui-for-media-stream',
                ],
            },
        },
    },
    {
        name: 'firefox',
        use: {
            ...devices['Desktop Firefox'],
            launchOptions: {
                firefoxUserPrefs: {
                    'media.navigator.streams.fake': true,
                    'media.navigator.permission.disabled': true,
                },
            },
        },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];
