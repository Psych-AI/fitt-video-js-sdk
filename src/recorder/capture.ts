import type { DescriptorTrack } from '../core/descriptor.ts';
import { FittVideoError, type ErrorCode } from '../core/errors.ts';

/** The part of navigator.mediaDevices the SDK uses. */
export interface MediaDevicesLike {
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
    enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

/** The devices the candidate chose, by deviceId. */
export interface Selection {
    camera?: string;
    microphone?: string;
}

/**
 * The one getUserMedia constraint set (author's call 12): the first track
 * with `capture.video` gives the camera's ideal size and frame rate, and the
 * microphone always asks for the browser's voice processing. A chosen device
 * is asked for exactly.
 */
export function constraintsFor(
    tracks: DescriptorTrack[],
    selected: Selection,
): MediaStreamConstraints {
    const constraints: MediaStreamConstraints = {};
    const video = tracks
        .map((track) =>
            track.kind === 'chunked' ? track.capture.video : undefined,
        )
        .find((capture) => capture !== undefined);
    const audio = tracks.some((track) => track.kind === 'chunked');

    if (video !== undefined) {
        const camera: MediaTrackConstraints = {
            width: { ideal: video.width },
            height: { ideal: video.height },
            frameRate: { ideal: video.frame_rate },
            facingMode: 'user',
        };

        if (selected.camera !== undefined) {
            camera.deviceId = { exact: selected.camera };
        }

        constraints.video = camera;
    }

    if (audio) {
        const microphone: MediaTrackConstraints = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        };

        if (selected.microphone !== undefined) {
            microphone.deviceId = { exact: selected.microphone };
        }

        constraints.audio = microphone;
    }

    return constraints;
}

function errorName(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const name = (error as { name?: unknown }).name;

    return typeof name === 'string' ? name : undefined;
}

/**
 * Maps a capture failure to an SDK code by its name only, never its
 * message. A NotFoundError is the camera when no videoinput is listed, and
 * the microphone otherwise. Anything else, a missing getUserMedia too, is
 * recorder_unsupported.
 */
export function captureError(
    error: unknown,
    devices: MediaDeviceInfo[],
): ErrorCode {
    switch (errorName(error)) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'permission_denied';
        case 'NotReadableError':
        case 'AbortError':
            return 'device_busy';
        case 'NotFoundError':
            return devices.some((device) => device.kind === 'videoinput')
                ? 'no_microphone'
                : 'no_camera';
        default:
            return 'recorder_unsupported';
    }
}

async function failure(
    media: MediaDevicesLike,
    error: unknown,
): Promise<FittVideoError> {
    let devices: MediaDeviceInfo[] = [];

    try {
        devices = await media.enumerateDevices();
    } catch {
        devices = [];
    }

    return new FittVideoError(captureError(error, devices), {
        name: errorName(error) ?? null,
    });
}

/** One getUserMedia call; once more without deviceId on OverconstrainedError. Throws FittVideoError. */
export async function acquire(
    media: MediaDevicesLike,
    tracks: DescriptorTrack[],
    selected: Selection,
): Promise<MediaStream> {
    try {
        return await media.getUserMedia(constraintsFor(tracks, selected));
    } catch (error) {
        const chosen =
            selected.camera !== undefined || selected.microphone !== undefined;

        if (errorName(error) !== 'OverconstrainedError' || !chosen) {
            throw await failure(media, error);
        }
    }

    try {
        return await media.getUserMedia(constraintsFor(tracks, {}));
    } catch (error) {
        throw await failure(media, error);
    }
}

/**
 * The permission's state, or `unknown` when the browser has no Permissions
 * API or refuses the name (Firefox rejects `camera`). It never relies on
 * `onchange`, which Safari never fires.
 */
export async function permissionState(
    permissions: Permissions | undefined,
    name: 'camera' | 'microphone',
): Promise<PermissionState | 'unknown'> {
    if (permissions === undefined) {
        return 'unknown';
    }

    try {
        const status = await permissions.query({
            name: name as PermissionName,
        });

        return status.state;
    } catch {
        return 'unknown';
    }
}
