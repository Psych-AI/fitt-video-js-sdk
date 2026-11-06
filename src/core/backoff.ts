/** The longest wait between two attempts. */
const CAP_MS = 30_000;

/** The first attempt's ceiling. */
const BASE_MS = 1_000;

/**
 * Full jitter: floor(random * min(30000, 1000 * 2^(attempt - 1))).
 * `attempt` counts from 1 and `random` is in [0, 1). There is no attempt cap.
 */
export function backoffMs(attempt: number, random: number): number {
    const exponent = Math.max(0, attempt - 1);
    const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** exponent);

    return Math.floor(random * ceiling);
}
