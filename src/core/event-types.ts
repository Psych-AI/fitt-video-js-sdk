/**
 * The event type rules of `StoreEventBatchRequest` and the table that maps
 * each type onto the server's signal groups (`config('video.signal_groups')`,
 * author's call 11). `session.*`, `recorder.*`, `enforce.*`, `upload.*` and
 * `host.*` are always on, so a host that leaves `recorder` out still gets the
 * take's own timeline.
 */
export const SIGNAL_GROUPS = [
    'attention',
    'window',
    'screen',
    'fullscreen',
    'keys',
    'clipboard',
    'input',
    'device',
    'net',
    'page',
    'recorder',
] as const;

export type SignalGroup = (typeof SIGNAL_GROUPS)[number];

/** The server's type pattern; it also allows at most 64 characters. */
export const TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** The platform's own types, which the server refuses from any client. */
export const RESERVED_TYPES: ReadonlySet<string> = new Set([
    'upload.events_gap',
    'upload.events_silent',
]);

const MAX_TYPE_LENGTH = 64;

/** The `browser.*` types by group; an unknown `browser.*` type is `input`. */
const BROWSER_GROUPS: Readonly<Record<string, SignalGroup>> = {
    hidden: 'attention',
    visible: 'attention',
    blur: 'attention',
    focus: 'attention',
    page_hidden: 'attention',
    resize: 'window',
    window_moved: 'window',
    screen_changed: 'screen',
    multiple_screens: 'screen',
    fullscreen_enter: 'fullscreen',
    fullscreen_exit: 'fullscreen',
    print_screen: 'keys',
    key_combo: 'keys',
    copy: 'clipboard',
    cut: 'clipboard',
    paste: 'clipboard',
    context_menu: 'clipboard',
    drag_start: 'clipboard',
    drop: 'clipboard',
    pointer_left: 'input',
    idle: 'input',
    screen_locked: 'input',
};

/** Prefixes whose whole family belongs to one group. */
const PREFIX_GROUPS: Readonly<Record<string, SignalGroup>> = {
    device: 'device',
    net: 'net',
    page: 'page',
};

/**
 * The group an event type belongs to, or 'always'. Only the SDK emits
 * types other than `host.*`, so a prefix the table does not know is
 * treated as always on rather than silently dropped.
 */
export function groupOf(type: string): SignalGroup | 'always' {
    const dot = type.indexOf('.');
    const prefix = dot === -1 ? type : type.slice(0, dot);

    if (prefix === 'browser') {
        return BROWSER_GROUPS[type.slice(dot + 1)] ?? 'input';
    }

    return PREFIX_GROUPS[prefix] ?? 'always';
}

/** The host type to send ('host.' added when missing), or null when the server would refuse it. */
export function hostType(type: string): string | null {
    if (RESERVED_TYPES.has(type)) {
        return null;
    }

    const prefixed = type.startsWith('host.') ? type : `host.${type}`;

    if (prefixed.length > MAX_TYPE_LENGTH || !TYPE_PATTERN.test(prefixed)) {
        return null;
    }

    return prefixed;
}
