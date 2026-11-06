/** What the harness and the synthetic stream (support/media.ts) put on `window`. */
interface Window {
    internals: typeof import('./internals.ts');
    __fakeMicGain?(gain: number): void;
    __fakeFreezeCamera?(frozen: boolean): void;
    __fakeCameras?: readonly {
        deviceId: string;
        groupId: string;
        kind: 'videoinput';
        label: string;
    }[];
    __dateOffset?: number;
}
