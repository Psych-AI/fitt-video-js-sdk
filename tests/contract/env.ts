import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(
    new URL('../../../../', import.meta.url),
);

/** The API server's environment. Real variables beat .env, and --no-reload keeps them. */
export const CONTRACT_ENV: Record<string, string> = {
    DB_DATABASE: 'testing',
    APP_URL: 'http://127.0.0.1:8123',
    VIDEO_API_URL: 'http://127.0.0.1:8123/api/v1',
    QUEUE_CONNECTION: 'sync',
    VIDEO_PROCESSING_ENABLED: 'true',
    CACHE_STORE: 'database',
    VIDEO_UPLOAD_DRIVER: 'passthrough',
    VIDEO_POST_MAX_BYTES: '104857600',
    PHP_CLI_SERVER_WORKERS: '4',
    XDEBUG_MODE: 'off',
};
