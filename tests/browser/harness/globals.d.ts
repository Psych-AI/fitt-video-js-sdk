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
    /** element.html: mounts one <fitt-recorder> over a session whose every API call is answered locally. */
    mount(options: {
        recording?: Record<string, number>;
        /** Merged into the descriptor's clock, e.g. a short session_cap_ms. */
        clock?: Record<string, number>;
        /** Merged into the descriptor's playback block, e.g. no local copy. */
        playback?: Record<string, unknown>;
        controls?: string;
        mirror?: string;
        statusBody?: unknown;
        startLabel?: string;
        /** Sets the boolean review attribute (Plan 9). */
        review?: boolean;
        slots?: string[];
    }): void;
    /** element.html: every data-phase value any mounted element took, in order. */
    __phases: string[];
    /** element.html: every data-upload value any mounted element took, in order. */
    __uploads: string[];
    /** element.html: every fitt-* DOM event, with its detail. */
    __events: { type: string; detail: any }[];
    /** element.html: how many audio elements the page created. */
    __audioElements: number;
}
