import type { Environment } from './env.ts';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * A lower-case ULID: 48 bits of milliseconds in 10 Crockford characters, then
 * 16 random characters, each one byte modulo 32 (unbiased, since 256 is a
 * multiple of 32). The server matches ids case-insensitively.
 */
export function ulid(
    env: Pick<Environment, 'dateNow' | 'randomBytes'>,
): string {
    let time = Math.floor(env.dateNow());
    let timePart = '';

    for (let i = 0; i < 10; i++) {
        timePart = CROCKFORD[time % 32] + timePart;
        time = Math.floor(time / 32);
    }

    let randomPart = '';

    for (const byte of env.randomBytes(16)) {
        randomPart += CROCKFORD[byte % 32];
    }

    return timePart + randomPart;
}
