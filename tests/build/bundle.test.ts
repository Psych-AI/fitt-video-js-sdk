import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const hosted = (file: string): string =>
    readFileSync(new URL(`../../dist/hosted/${file}`, import.meta.url), 'utf8');

test('the IIFE sets FittVideo with the package version and touches no DOM while it loads', () => {
    const context = vm.createContext({});
    vm.runInContext(hosted('fitt-video.iife.js'), context);
    const sdk = context.FittVideo as Record<string, unknown>;

    assert.equal(sdk.VERSION, '1.4.1');
    assert.equal(typeof sdk.session, 'function');
    assert.equal(typeof sdk.resume, 'function');
    assert.equal(typeof sdk.defineFittRecorder, 'function');
});

test('neither hosted file mentions process.env', () => {
    for (const file of ['fitt-video.js', 'fitt-video.iife.js']) {
        assert.ok(!hosted(file).includes('process.env'), file);
    }
});

test('the ES build imports in Node and exports the version', async () => {
    const module = (await import(
        new URL('../../dist/hosted/fitt-video.js', import.meta.url).href
    )) as { VERSION: string };

    assert.equal(module.VERSION, '1.4.1');
});

test('the package README names the public API, the audio-only path and the level hooks', () => {
    const readme = readFileSync(
        new URL('../../README.md', import.meta.url),
        'utf8',
    );

    for (const name of [
        'FittVideo.session(',
        'FittVideo.resume(',
        'defineFittRecorder(',
        'session.prepare(',
        'session.start(',
        'session.stop(',
        'session.finalise(',
        'session.waitForChecks(',
        'session.waitForReady(',
        'session.playback(',
        'session.playbackTrack',
        'session.mixAudio(',
        'session.audio.getInputVolume',
        'session.audio.onFrame(',
        'session.audio.stream',
        '--fitt-level',
        'data-speaking',
        '"tracks": ["audio"]',
    ]) {
        assert.ok(readme.includes(name), `README names ${name}`);
    }

    assert.equal(/[\u2013\u2014]/.test(readme), false);
});
