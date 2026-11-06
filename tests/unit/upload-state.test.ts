import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionState } from '../../src/core/state.ts';
import { uploadAttribute } from '../../src/ui/upload-state.ts';

const state = (phase: string, upload: Partial<SessionState['upload']>) =>
    ({
        phase,
        upload: {
            bytesSent: 0,
            bytesTotal: 0,
            backlog: 0,
            tracksSealed: 0,
            sessionFinalised: false,
            ...upload,
        },
    }) as unknown as SessionState;

test('data-upload is idle before any segment', () => {
    assert.equal(uploadAttribute(state('ready', {})), 'idle');
});

test('data-upload is active while recording, even with every byte sent', () => {
    assert.equal(
        uploadAttribute(state('recording', { bytesSent: 10, bytesTotal: 10 })),
        'active',
    );
});

test('data-upload is done once stopped, settled and finalised, with a segment abandoned', () => {
    assert.equal(
        uploadAttribute(
            state('stopped', {
                bytesSent: 10,
                bytesTotal: 25,
                sessionFinalised: true,
            }),
        ),
        'done',
    );
});

test('data-upload stays active until the finalise is acknowledged', () => {
    assert.equal(
        uploadAttribute(
            state('stopped', {
                bytesSent: 10,
                bytesTotal: 25,
                sessionFinalised: false,
            }),
        ),
        'active',
    );
});

test('data-upload stays active while a record is pending', () => {
    assert.equal(
        uploadAttribute(
            state('stopped', {
                bytesSent: 10,
                bytesTotal: 25,
                backlog: 1,
                sessionFinalised: true,
            }),
        ),
        'active',
    );
});
