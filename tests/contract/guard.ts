export type Artisan = (args: string[]) => string;

/**
 * The contract tests run migrate:fresh. Refuse unless the database the CLI
 * resolves with the contract env is `testing`, and refuse a cached config,
 * which ignores the environment.
 */
export function assertTestingDatabase(
    artisan: Artisan,
    configCached: () => boolean,
): void {
    if (configCached()) {
        throw new Error(
            'bootstrap/cache/config.php exists, so the environment is ignored. Run ./vendor/bin/sail artisan config:clear first.',
        );
    }

    const output = artisan([
        'artisan',
        'tinker',
        '--execute',
        'echo config("database.connections.pgsql.database");',
    ]);
    const name = output.trim().split('\n').at(-1)?.trim() ?? '';

    if (name !== 'testing') {
        throw new Error(
            `The contract tests only run against the testing database, not "${name}".`,
        );
    }
}
