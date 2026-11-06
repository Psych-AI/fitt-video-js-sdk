import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireAnswer } from '../../src/core/http.ts';
import { classify, type Verdict } from '../../src/core/responses.ts';

const answer = (status: number, body: unknown = null): WireAnswer => ({
    status,
    body,
    networkError: false,
    timedOut: false,
});
const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
    error: { code, message: 'any', ...extra },
});

const TABLE: [string, WireAnswer, Verdict][] = [
    [
        '201 stored',
        answer(201, { code: 'stored', segment: {} }),
        { kind: 'ok', code: 'stored' },
    ],
    [
        '201 part_stored',
        answer(201, { code: 'part_stored', segment: {} }),
        { kind: 'ok', code: 'part_stored' },
    ],
    [
        '200 already_present',
        answer(200, { code: 'already_present', segment: {} }),
        { kind: 'ok', code: 'already_present' },
    ],
    [
        '409 track_sealed with stored',
        answer(409, envelope('track_sealed', { stored: true })),
        { kind: 'ok', code: 'track_sealed' },
    ],
    [
        '400 hash_mismatch',
        answer(400, envelope('hash_mismatch')),
        { kind: 'retry', code: 'hash_mismatch' },
    ],
    [
        '400 size_mismatch',
        answer(400, envelope('size_mismatch')),
        { kind: 'retry', code: 'size_mismatch' },
    ],
    ['408', answer(408), { kind: 'retry', code: 'http_408' }],
    [
        '500',
        answer(500, envelope('server_error')),
        { kind: 'retry', code: 'server_error' },
    ],
    ['502 with no body', answer(502), { kind: 'retry', code: 'http_502' }],
    [
        '503 join_in_progress',
        answer(503, envelope('join_in_progress')),
        { kind: 'retry', code: 'join_in_progress' },
    ],
    [
        '503 http_error (maintenance)',
        answer(503, envelope('http_error')),
        { kind: 'retry', code: 'http_error' },
    ],
    [
        '200 with no code (a proxy)',
        answer(200, '<html>ok</html>'),
        { kind: 'retry', code: 'http_200' },
    ],
    [
        'a network error',
        { status: 0, body: null, networkError: true, timedOut: false },
        { kind: 'retry', code: 'network' },
    ],
    [
        'a timeout',
        { status: 0, body: null, networkError: true, timedOut: true },
        { kind: 'retry', code: 'timeout' },
    ],
    [
        '429',
        answer(429, envelope('rate_limited', { retry_after: 7 })),
        { kind: 'retry', code: 'rate_limited', waitMs: 7000 },
    ],
    [
        '401 token_expired',
        answer(401, envelope('token_expired', { recoverable: true })),
        { kind: 'refresh', code: 'token_expired', recoverable: true },
    ],
    [
        '401 token_expired, not recoverable',
        answer(401, envelope('token_expired', { recoverable: false })),
        { kind: 'refresh', code: 'token_expired', recoverable: false },
    ],
    [
        '401 unauthenticated',
        answer(401, envelope('unauthenticated')),
        { kind: 'terminal', code: 'unauthenticated', status: 401 },
    ],
    ...[
        'segment_conflict',
        'stale_take',
        'session_closed',
        'discarded',
        'cap_exceeded',
    ].map((code): [string, WireAnswer, Verdict] => [
        `409 ${code}`,
        answer(409, envelope(code)),
        { kind: 'terminal', code, status: 409 },
    ]),
    [
        '409 track_sealed without stored',
        answer(409, envelope('track_sealed')),
        { kind: 'terminal', code: 'track_sealed', status: 409 },
    ],
    ...(
        [
            [404, 'not_found'],
            [411, 'length_required'],
            [413, 'payload_too_large'],
            [415, 'unsupported_media_type'],
            [422, 'validation_failed'],
            [403, 'forbidden'],
        ] as const
    ).map(([status, code]): [string, WireAnswer, Verdict] => [
        `${status} ${code}`,
        answer(status, envelope(code)),
        { kind: 'terminal', code, status },
    ]),
    [
        '403 origin_not_allowed',
        answer(403, envelope('origin_not_allowed')),
        { kind: 'blocked', code: 'origin_not_allowed' },
    ],
    [
        '405',
        answer(405, envelope('method_not_allowed')),
        { kind: 'step_down', reason: 'method' },
    ],
    [
        '403 from a proxy, no envelope',
        answer(403, '<html>Forbidden</html>'),
        { kind: 'step_down', reason: 'proxy' },
    ],
    [
        '404 with an html body (an edge)',
        answer(404, '<html>Not Found</html>'),
        { kind: 'retry', code: 'http_404' },
    ],
    ['400 with no body', answer(400), { kind: 'retry', code: 'http_400' }],
];

for (const [name, given, expected] of TABLE) {
    test(`classify: ${name}`, () => {
        assert.deepEqual(classify(given), expected);
    });
}
