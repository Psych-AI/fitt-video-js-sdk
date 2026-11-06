/**
 * Whether the recorder's keyframe option was honoured: every media segment but the last
 * lands within the tolerance of the target (author's call 6). Null with fewer than two
 * media segments, so the manifest omits `keyframe_option_honoured`.
 */
export function keyframeOptionHonoured(
    mediaDurationsMs: number[],
    targetMs: number,
    toleranceMs = 250,
): boolean | null {
    if (mediaDurationsMs.length < 2) {
        return null;
    }

    return mediaDurationsMs
        .slice(0, -1)
        .every((duration) => Math.abs(duration - targetMs) <= toleranceMs);
}
