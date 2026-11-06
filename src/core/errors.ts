/** Spec 6.5's eleven codes, then the five this plan adds (author's call 12), none of which enters phase 'error'. */
export const ERROR_CODES = [
    'permission_denied',
    'device_busy',
    'no_camera',
    'no_microphone',
    'device_disconnected',
    'recorder_unsupported',
    'recorder_error',
    'config_invalid',
    'token_expired',
    'session_cap_reached',
    'network_blocked',
    'events_rejected',
    'manifest_rejected',
    'stale_take',
    'token_refresh_blocked',
    'manifests_blocked',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type RejectionCode =
    | 'too_short'
    | 'countdown_cancelled'
    | 'invalid_state'
    | 'playback_not_enabled';

/** The SDK's one error type. Its message is the code itself, so nothing depends on copy. */
export class FittVideoError extends Error {
    readonly code: ErrorCode | RejectionCode;
    readonly detail: Record<string, unknown>;

    constructor(
        code: ErrorCode | RejectionCode,
        detail: Record<string, unknown> = {},
    ) {
        super(code);
        this.name = 'FittVideoError';
        this.code = code;
        this.detail = detail;
    }
}
