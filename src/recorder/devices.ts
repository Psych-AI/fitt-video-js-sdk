import type { MediaDevicesLike, Selection } from './capture.ts';

/** The cameras and microphones the browser lists, the choice, and a way to change it. */
export interface DevicesView {
    cameras: MediaDeviceInfo[];
    microphones: MediaDeviceInfo[];
    selected: Selection;
    select(kind: 'camera' | 'microphone', deviceId: string): Promise<void>;
}

/** Labels of the common virtual cameras: a hint, never proof. */
const VIRTUAL_CAMERA = /obs|manycam|virtual|snap camera|xsplit|mmhmm/i;

export interface DeviceList {
    readonly cameras: MediaDeviceInfo[];
    readonly microphones: MediaDeviceInfo[];
    /** Lists the devices again and raises what changed since the last list. */
    refresh(): Promise<void>;
}

/**
 * The engine's device list. The first list is the baseline; each later one
 * raises `device.camera_removed {label}` for a camera that is gone and
 * `device.camera_changed {label}` for one that is new or relabelled (and the
 * microphone equivalents). A camera label that looks like a virtual camera
 * raises `device.virtual_camera_suspected {label}` once per label.
 */
export function createDeviceList(deps: {
    media: MediaDevicesLike;
    emit(type: string, payload: Record<string, unknown>): void;
}): DeviceList {
    let cameras: MediaDeviceInfo[] = [];
    let microphones: MediaDeviceInfo[] = [];
    let listed = false;
    const suspected = new Set<string>();

    function compare(
        kind: 'camera' | 'microphone',
        before: MediaDeviceInfo[],
        after: MediaDeviceInfo[],
    ): void {
        for (const old of before) {
            if (!after.some((device) => device.deviceId === old.deviceId)) {
                deps.emit(`device.${kind}_removed`, { label: old.label });
            }
        }

        for (const device of after) {
            const previous = before.find(
                (old) => old.deviceId === device.deviceId,
            );

            if (previous === undefined || previous.label !== device.label) {
                deps.emit(`device.${kind}_changed`, { label: device.label });
            }
        }
    }

    return {
        get cameras(): MediaDeviceInfo[] {
            return [...cameras];
        },

        get microphones(): MediaDeviceInfo[] {
            return [...microphones];
        },

        async refresh(): Promise<void> {
            let all: MediaDeviceInfo[];

            try {
                all = await deps.media.enumerateDevices();
            } catch {
                return;
            }

            const nextCameras = all.filter(
                (device) => device.kind === 'videoinput',
            );
            const nextMicrophones = all.filter(
                (device) => device.kind === 'audioinput',
            );

            if (listed) {
                compare('camera', cameras, nextCameras);
                compare('microphone', microphones, nextMicrophones);
            }

            cameras = nextCameras;
            microphones = nextMicrophones;
            listed = true;

            for (const camera of cameras) {
                if (
                    VIRTUAL_CAMERA.test(camera.label) &&
                    !suspected.has(camera.label)
                ) {
                    suspected.add(camera.label);
                    deps.emit('device.virtual_camera_suspected', {
                        label: camera.label,
                    });
                }
            }
        },
    };
}
