import type { SessionState } from '../core/state.ts';

/**
 * The element's data-upload value (spec 6.5). `done` needs the take
 * stopped, nothing pending and the finalise acknowledged: a segment the
 * queue abandoned keeps bytesSent below bytesTotal for good, so the bytes
 * never decide it. Delivered, abandoned, rejected and dropped records are
 * settled; only pending records count in `backlog`.
 */
export function uploadAttribute(
    state: SessionState,
): 'idle' | 'active' | 'done' {
    const { upload } = state;

    if (
        state.phase === 'stopped' &&
        upload.backlog === 0 &&
        upload.sessionFinalised
    ) {
        return 'done';
    }

    if (upload.bytesTotal === 0 && upload.backlog === 0) {
        return 'idle';
    }

    return 'active';
}
