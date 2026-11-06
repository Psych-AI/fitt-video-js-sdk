import { session } from './core/session.ts';
import { VERSION } from './version.ts';

/** The SDK's one global: FittVideo.session(descriptor, options). */
export const FittVideo = { session, VERSION };

export type { TranscriptUpload } from './core/api.ts';
export type { ChecksResult } from './core/checks.ts';
export type { Descriptor, TrackName } from './core/descriptor.ts';
export { FittVideoError } from './core/errors.ts';
export type { ErrorCode, RejectionCode } from './core/errors.ts';
export type { SdkEvent } from './core/events.ts';
export type { Milestone, MilestoneName } from './core/lifecycle.ts';
export type { SessionOptions } from './core/options.ts';
export type { FittSession } from './core/session.ts';
export type { Phase, SessionState } from './core/state.ts';
export type { MixSource } from './recorder/audio.ts';
export type { DevicesView } from './recorder/devices.ts';
export type { ActionResult } from './signals/fullscreen.ts';
export { session, VERSION };
