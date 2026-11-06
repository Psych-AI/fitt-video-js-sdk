import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the element and hosted modules import in Node without a DOM', async () => {
    const ui = await import('../../src/ui.ts');
    const hosted = await import('../../src/hosted.ts');

    assert.equal(typeof ui.defineFittRecorder, 'function');
    assert.equal(typeof hosted.defineFittRecorder, 'function');
    assert.equal(typeof hosted.FittVideo.session, 'function');
});
