/** Spec 6.3's order for a track with video. There is no codec option. */
export const CAMERA_TYPES: readonly string[] = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm',
];

/** The audio-only track's order (author's call 12): Opus first, AAC where only MP4 is offered. */
export const AUDIO_TYPES: readonly string[] = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm',
];

/** '' when nothing on the list is supported: MediaRecorder then picks, and the run reports what it chose. */
export function chooseMime(
    kind: 'camera' | 'audio',
    isTypeSupported: (type: string) => boolean,
): string {
    const types = kind === 'camera' ? CAMERA_TYPES : AUDIO_TYPES;

    return types.find((type) => isTypeSupported(type)) ?? '';
}
