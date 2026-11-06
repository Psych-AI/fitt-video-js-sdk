import type { PageLike } from '../../src/signals/index.ts';

export function fakePage(options: { extended?: boolean } = {}): PageLike {
    const screen = Object.assign(
        new EventTarget(),
        { width: 1920, height: 1080 },
        options.extended === undefined ? {} : { isExtended: options.extended },
    );
    const win = Object.assign(new EventTarget(), {
        innerWidth: 1280,
        innerHeight: 800,
        outerWidth: 1280,
        outerHeight: 880,
        screenX: 0,
        screenY: 0,
        screen,
        devicePixelRatio: 2,
    });
    Object.assign(win, { top: win });
    const doc = Object.assign(new EventTarget(), {
        visibilityState: 'visible',
        hasFocus: () => true,
        fullscreenElement: null,
        getSelection: () => ({ toString: () => 'hello' }),
        documentElement: new EventTarget(),
    });

    const connection = Object.assign(new EventTarget(), {
        effectiveType: '4g',
        type: 'wifi',
    });

    return {
        win,
        doc,
        nav: {
            userAgent: 'test',
            languages: ['en'],
            maxTouchPoints: 0,
            connection,
        },
    };
}
