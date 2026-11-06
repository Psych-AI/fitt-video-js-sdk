import { existsSync, readdirSync } from 'node:fs';

/**
 * The names under the local recordings folder. A fresh checkout has no such
 * folder, so a missing folder is an empty list rather than ENOENT.
 */
export function videoDirNames(folder: string): string[] {
    if (!existsSync(folder)) {
        return [];
    }

    return readdirSync(folder);
}

/**
 * The folders the teardown deletes: the names present now that the setup did
 * not record. Playwright runs the teardown even when the setup throws, so
 * when nothing was recorded (the guard refused the database) nothing is
 * deleted, never every folder.
 */
export function videoDirsToDelete(
    present: string[],
    recorded: string | undefined,
): string[] {
    if (recorded === undefined) {
        return [];
    }

    const before = new Set<string>(JSON.parse(recorded) as string[]);

    return present.filter((name) => !before.has(name));
}
