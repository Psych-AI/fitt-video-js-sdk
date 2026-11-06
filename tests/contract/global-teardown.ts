import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './env.ts';
import { videoDirNames, videoDirsToDelete } from './video-dirs.ts';

/**
 * Deletes the recording folders the run created. DeleteSession does not purge
 * files until Plan 4, so the contract run cleans up after itself.
 */
export default function globalTeardown(): void {
    const folder = `${REPO_ROOT}storage/app/private/videos`;
    const added = videoDirsToDelete(
        videoDirNames(folder),
        process.env.FITT_CONTRACT_VIDEO_DIRS,
    );

    for (const name of added) {
        rmSync(join(folder, name), { recursive: true, force: true });
    }
}
