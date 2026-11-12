/**
 * The shadow root's CSS, laid out as RecorderStates.dc.html and
 * RecorderStatesMore.dc.html draw the element. Every colour and size is a
 * custom property a host can set on fitt-recorder, defaulted from the Fitt
 * tokens the boards use. The view is mirrored here, never the recording.
 */
export const STYLES = `
:host {
    --fitt-recorder-radius: 12px;
    --fitt-recorder-background: #14132e;
    --fitt-recorder-idle-background: #1d1c3d;
    --fitt-recorder-ink: #161443;
    --fitt-recorder-surface: #ffffff;
    --fitt-recorder-overlay: rgba(11, 10, 31, 0.7);
    --fitt-recorder-scrim: rgba(11, 10, 31, 0.35);
    --fitt-recorder-accent: #e93544;
    --fitt-recorder-meter: #5fd39a;
    --fitt-recorder-meter-off: #4a4875;
    --fitt-recorder-warning: #f2b66d;
    --fitt-recorder-marker: #5fd39a;
    --fitt-recorder-disabled: #4a4875;
    --fitt-recorder-disabled-ink: #8b89b3;
    --fitt-recorder-track: rgba(255, 255, 255, 0.25);
    --fitt-recorder-selected: #edf7f7;
    --fitt-recorder-muted-ink: #4e4d6b;
    --fitt-recorder-skeleton: #2a2852;
    --fitt-recorder-inset: 10px;
    /* Clears the browser's own video control bar in review. */
    --fitt-recorder-review-bar: 56px;
    --fitt-recorder-button-size: 44px;
    --fitt-recorder-countdown-size: 88px;
    --fitt-recorder-font: Inter, 'Helvetica Neue', Arial, sans-serif;
    --fitt-recorder-display-font: 'Neue Haas Grotesk Text Pro', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    --fitt-recorder-mono-font: 'JetBrains Mono', ui-monospace, Menlo, monospace;

    display: block;
    position: relative;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    border-radius: var(--fitt-recorder-radius);
    background: var(--fitt-recorder-background);
    color: var(--fitt-recorder-surface);
    font-family: var(--fitt-recorder-font);
    font-size: 12px;
    line-height: 1.4;
    box-sizing: border-box;
    contain: content;
}

:host([data-phase='idle']),
:host([data-phase='preparing']),
:host([data-phase='error']) {
    background: var(--fitt-recorder-idle-background);
}

*,
*::before,
*::after {
    box-sizing: border-box;
}

[hidden] {
    display: none !important;
}

button {
    font: inherit;
    color: inherit;
    margin: 0;
    cursor: pointer;
}

button:disabled {
    cursor: not-allowed;
}

button:focus-visible {
    outline: 2px solid var(--fitt-recorder-surface);
    outline-offset: 2px;
}

[part='view'] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1);
    background: transparent;
}

:host([mirror='false']) [part='view'] {
    transform: none;
}

/* The review video (Plan 9), placed as the view is, never mirrored. */
[part='review'] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    display: none;
}

:host([data-review='local']:not([controls='none'])) [part='review'],
:host([data-review='server']:not([controls='none'])) [part='review'] {
    display: block;
}

:host([data-review='local']:not([controls='none'])) [part='view'],
:host([data-review='server']:not([controls='none'])) [part='view'],
:host([data-review='preparing']:not([controls='none'])) [part='view'] {
    display: none;
}

/* Preparing: the view area pulses as a skeleton with no words (RecorderReview frame 3). */
.review-skeleton {
    position: absolute;
    inset: 0;
    display: none;
    background: var(--fitt-recorder-skeleton);
    pointer-events: none;
    animation: fitt-recorder-pulse 1.6s ease-in-out infinite;
}

:host([data-review='preparing']:not([controls='none'])) .review-skeleton {
    display: block;
}

/*
 * In review the stopped-phase record button and timer step aside, so the
 * browser's own control bar takes every click (RecorderReview frames 1 to 4).
 * The host's controls slot sits above that bar.
 */
:host([data-review='local']:not([controls='none'])) [part='record'],
:host([data-review='server']:not([controls='none'])) [part='record'],
:host([data-review='preparing']:not([controls='none'])) [part='record'],
:host([data-review='local']:not([controls='none'])) [part='timer'],
:host([data-review='server']:not([controls='none'])) [part='timer'],
:host([data-review='preparing']:not([controls='none'])) [part='timer'] {
    display: none;
}

@keyframes fitt-recorder-pulse {
    0%,
    100% {
        opacity: 1;
    }

    50% {
        opacity: 0.45;
    }
}

@media (prefers-reduced-motion: reduce) {
    .review-skeleton {
        animation: none;
    }
}

[part='record'],
[part='stop'] {
    position: absolute;
    left: 50%;
    bottom: var(--fitt-recorder-inset);
    transform: translateX(-50%);
    width: var(--fitt-recorder-button-size);
    height: var(--fitt-recorder-button-size);
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--fitt-recorder-surface);
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

[part='record'] .glyph {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--fitt-recorder-accent);
}

[part='stop'] .glyph {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    background: var(--fitt-recorder-ink);
}

[part='record']:disabled,
[part='stop']:disabled {
    background: var(--fitt-recorder-disabled);
}

[part='record']:disabled .glyph,
[part='stop']:disabled .glyph {
    background: var(--fitt-recorder-disabled-ink);
}

[part='timer'] {
    position: absolute;
    left: var(--fitt-recorder-inset);
    top: var(--fitt-recorder-inset);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 9px;
    border-radius: 999px;
    background: var(--fitt-recorder-overlay);
    font-family: var(--fitt-recorder-mono-font);
    font-weight: 500;
}

[part='timer'] .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fitt-recorder-accent);
}

[part='remaining'] {
    position: absolute;
    right: var(--fitt-recorder-inset);
    bottom: 18px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 9px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: var(--fitt-recorder-overlay);
    font-family: var(--fitt-recorder-mono-font);
    font-weight: 600;
}

[part='remaining'][data-stage='warning'] {
    border-color: var(--fitt-recorder-warning);
    color: var(--fitt-recorder-warning);
}

[part='remaining'][data-stage='grace'] {
    background: var(--fitt-recorder-warning);
    color: var(--fitt-recorder-ink);
}

[part='remaining'] svg {
    display: none;
}

[part='remaining'][data-stage='grace'] svg {
    display: block;
}

[part='progress'] {
    position: absolute;
    left: var(--fitt-recorder-inset);
    right: var(--fitt-recorder-inset);
    bottom: 64px;
    height: 4px;
    border-radius: 999px;
    background: var(--fitt-recorder-track);
}

[part='progress'] .fill {
    width: 0;
    height: 4px;
    border-radius: 999px;
    background: var(--fitt-recorder-surface);
}

[part='progress'][data-stage='warning'] .fill,
[part='progress'][data-stage='grace'] .fill {
    background: var(--fitt-recorder-warning);
}

[part='marker-min'],
[part='marker-warning'] {
    position: absolute;
    top: -3px;
    width: 2px;
    height: 10px;
    margin-left: -1px;
}

[part='marker-min'] {
    background: var(--fitt-recorder-marker);
}

[part='marker-warning'] {
    background: var(--fitt-recorder-warning);
}

[part='meter'] {
    position: absolute;
    left: var(--fitt-recorder-inset);
    bottom: var(--fitt-recorder-inset);
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--fitt-recorder-overlay);
}

:host([data-audio='silent']) [part='meter'] {
    border-color: var(--fitt-recorder-accent);
}

[part='meter'] .bar {
    width: 4px;
    border-radius: 2px;
    background: var(--fitt-recorder-meter-off);
}

[part='meter'] .bar[data-on] {
    background: var(--fitt-recorder-meter);
}

[part='countdown'] {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--fitt-recorder-scrim);
    font-family: var(--fitt-recorder-display-font);
    font-size: var(--fitt-recorder-countdown-size);
    font-weight: 500;
    line-height: 1;
    pointer-events: none;
}

[part='countdown']:empty {
    display: none;
}

[part='picker'] {
    position: absolute;
    right: var(--fitt-recorder-inset);
    top: var(--fitt-recorder-inset);
    left: var(--fitt-recorder-inset);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    pointer-events: none;
}

[part='picker-toggle'] {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--fitt-recorder-overlay);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
}

[part='picker-toggle'][aria-expanded='true'] {
    border-color: var(--fitt-recorder-surface);
}

[part='picker-toggle']:disabled {
    opacity: 0.5;
}

[part='picker'] .panel {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
    border-radius: 10px;
    background: var(--fitt-recorder-surface);
    box-shadow: 0 6px 20px rgba(11, 10, 31, 0.45);
    color: var(--fitt-recorder-ink);
    font-size: 11px;
    pointer-events: auto;
}

[part='picker-list'] {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

[part='picker-list'] > svg {
    margin: 0 0 2px 4px;
    color: var(--fitt-recorder-muted-ink);
}

[part='picker-option'] {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 4px 4px 20px;
    border: none;
    border-radius: 6px;
    background: var(--fitt-recorder-surface);
    color: var(--fitt-recorder-ink);
    font-size: 11px;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

[part='picker-option'] svg {
    display: none;
    flex: 0 0 12px;
}

[part='picker-option'][aria-selected='true'] {
    padding-left: 4px;
    background: var(--fitt-recorder-selected);
    font-weight: 600;
}

[part='picker-option'][aria-selected='true'] svg {
    display: block;
}

.slot {
    position: absolute;
    display: none;
    pointer-events: none;
}

.slot ::slotted(*) {
    pointer-events: auto;
}

.slot-instructions,
.slot-no-audio {
    left: var(--fitt-recorder-inset);
    right: var(--fitt-recorder-inset);
    top: 48px;
}

.slot-review {
    left: var(--fitt-recorder-inset);
    right: var(--fitt-recorder-inset);
    top: var(--fitt-recorder-inset);
}

.slot-error,
.slot-checking,
.slot-rejected {
    left: var(--fitt-recorder-inset);
    right: var(--fitt-recorder-inset);
    top: 50%;
    transform: translateY(-50%);
}

.slot-controls {
    display: block;
    right: var(--fitt-recorder-inset);
    bottom: var(--fitt-recorder-inset);
}

:host([data-review='local']:not([controls='none'])) .slot-controls,
:host([data-review='server']:not([controls='none'])) .slot-controls {
    bottom: var(--fitt-recorder-review-bar);
}

:host([data-phase='idle']) .slot-instructions,
:host([data-phase='ready']) .slot-instructions,
:host([data-error]) .slot-error,
:host([data-phase='stopped'][data-checks='pending']) .slot-checking,
:host([data-audio='silent']) .slot-no-audio,
:host([data-phase='rejected']) .slot-rejected {
    display: block;
}

:host([data-review]) .slot-review {
    display: flex;
}
`;
