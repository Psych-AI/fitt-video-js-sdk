import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { FIXTURES_DIR } from '../support/fixtures.ts';
import { openHarness } from './support/measure.ts';
import { installMedia } from './support/media.ts';

/**
 * Records the audio-only answer fixture sets through the SDK's own engine and
 * cutter (Plan 10, author's call 11). It runs only when asked, once, in Sail:
 * Chromium records the harness's synthetic 220 Hz tone, Firefox its native
 * fake microphone. WebKit on Linux has no MediaRecorder; its set is stripped
 * from webkit-mp4 by harness/strip_video_mp4.py.
 */
const SETS: Record<string, string> = {
    chromium: 'chrome-opus-audio',
    firefox: 'firefox-opus-audio',
};

test('capture an audio-only answer fixture set', async ({
    page,
    browserName,
}) => {
    test.skip(
        process.env.FITT_CAPTURE_FIXTURES !== '1',
        'set FITT_CAPTURE_FIXTURES=1 to capture the audio fixture sets',
    );
    test.skip(
        SETS[browserName] === undefined,
        'no MediaRecorder on this engine',
    );
    test.setTimeout(240_000);
    const set = SETS[browserName];
    const source = browserName === 'chromium' ? 'synthetic' : 'native';
    await installMedia(page, browserName, { prefer: source });
    await openHarness(page);
    await page.click('#gesture');
    const take = await page.evaluate(() =>
        window.internals.recordTake({ recipe: 'answer-audio', seconds: 60 }),
    );

    expect(take.runs).toHaveLength(1);
    const run = take.runs[0];
    expect(run.track).toBe('audio');
    const segments = take.segments
        .filter((segment) => segment.run_id === run.run_id)
        .sort((a, b) => a.seq - b.seq);
    expect(segments[0].kind).toBe('init');
    expect(segments.length).toBeGreaterThanOrEqual(12);

    const dir = `${FIXTURES_DIR}${set}`;
    mkdirSync(`${dir}/fragments`, { recursive: true });
    const fragments = segments.map((segment) => {
        const bytes = Buffer.from(segment.base64, 'base64');
        const file = `seq_${String(segment.seq).padStart(5, '0')}.bin`;
        writeFileSync(`${dir}/fragments/${file}`, bytes);

        return {
            seq: segment.seq,
            file,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            start_ms:
                segment.kind === 'init' ? 0 : segment.start_ms - run.anchor_ms,
            duration_ms: segment.duration_ms,
            kind: segment.kind,
        };
    });
    writeFileSync(`${dir}/init.bin`, Buffer.from(segments[0].base64, 'base64'));
    writeFileSync(
        `${dir}/manifest.json`,
        `${JSON.stringify(
            {
                set,
                browser: browserName,
                mimeType: run.mime_type,
                timeslice: null,
                durationMs: 60_000,
                keyframeOpt: false,
                source: `Plan 10 capture-audio.spec.ts: the SDK engine and cutter, ${source === 'synthetic' ? 'the synthetic 220 Hz tone' : 'the native fake microphone'}, answer-audio at 64 kbps mono`,
                result: {
                    supported: true,
                    mimeTypeActual: run.mime_type,
                    ua: run.ua,
                    fragments: fragments.length,
                },
                fragments,
            },
            null,
            2,
        )}\n`,
    );
});
