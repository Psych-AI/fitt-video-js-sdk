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
    VIDEO_AI_FAKE: 'contract',
    VIDEO_AI_CONCURRENCY: 'sync',
    OPENAI_API_KEY: 'contract',
    AININJA_TOKEN: 'contract',
    AININJA_URL: 'https://aininja.test',
};

/** MinIO in Sail: the bucket the direct server's slot URLs point at. */
export const MINIO = process.env.VIDEO_TEST_S3_ENDPOINT ?? 'http://minio:9000';

/** The second API server, on the s3 driver (Plan 8 Task 11). */
export const DIRECT_API = 'http://127.0.0.1:8126/api/v1';

/**
 * The direct server's environment: the s3 driver on the video disk, on MinIO.
 * The empty presign endpoint is deliberate: artisan serve would otherwise read
 * a developer's .env and sign slot URLs for localhost:<FORWARD_MINIO_PORT>,
 * which Chromium inside the container cannot reach. Empty, browserDisk() signs
 * on MINIO.
 */
export const CONTRACT_DIRECT_ENV: Record<string, string> = {
    ...CONTRACT_ENV,
    APP_URL: 'http://127.0.0.1:8126',
    VIDEO_API_URL: DIRECT_API,
    VIDEO_UPLOAD_DRIVER: 's3',
    VIDEO_STORAGE_DISK: 'video',
    VIDEO_S3_KEY: 'sail',
    VIDEO_S3_SECRET: 'password',
    VIDEO_S3_REGION: 'us-east-1',
    VIDEO_S3_BUCKET: 'fitt-video-contract',
    VIDEO_S3_ENDPOINT: MINIO,
    VIDEO_S3_USE_PATH_STYLE: 'true',
    VIDEO_S3_PRESIGN_ENDPOINT: '',
};
