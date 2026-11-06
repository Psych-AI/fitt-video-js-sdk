import type { ChecksResult } from '../core/checks.ts';
import type { TrackName } from '../core/descriptor.ts';
import type { SdkEvent } from '../core/events.ts';
import type { Milestone } from '../core/lifecycle.ts';
import { takeView, type FittSession } from '../core/session.ts';
import type { Phase, SessionState } from '../core/state.ts';
import { STYLES } from './styles.ts';
import { uploadAttribute } from './upload-state.ts';

type Controls = 'none' | 'minimal' | 'full';

/** The host slots (author's call 13 adds no-audio and rejected). */
const SLOTS = [
    'instructions',
    'error',
    'checking',
    'controls',
    'no-audio',
    'rejected',
] as const;

/** How often the timers, the progress bar and the stop rule are drawn again. */
const TICK_MS = 250;

/** How long the host's start-label stays up after `started`. */
const START_LABEL_MS = 1000;

const METER_BARS = 6;
const METER_HEIGHTS = [6, 10, 14, 9, 7, 5];

/** A level at or below this lights no bar. */
const METER_FLOOR = 0.002;

/** The level that lights every bar; bars follow the square root, so speech moves the meter. */
const METER_FULL = 0.25;

const CAMERA_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>';
const MICROPHONE_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z"></path><path d="M19 10v2a7 7 0 01-14 0v-2"></path></svg>';
const SLIDERS_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"></path><circle cx="15" cy="6" r="2"></circle><circle cx="9" cy="12" r="2"></circle><circle cx="17" cy="18" r="2"></circle></svg>';
const CHECK_ICON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>';
const CLOCK_ICON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2 2M9 2h6"></path></svg>';

/** m:ss, or h:mm:ss from an hour. */
export function formatClock(ms: number, round: 'down' | 'up' = 'down'): string {
    const seconds = Math.max(
        0,
        round === 'up' ? Math.ceil(ms / 1000) : Math.floor(ms / 1000),
    );
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, '0');

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
        : `${minutes}:${rest}`;
}

function controlsOf(value: string | null): Controls {
    return value === 'none' || value === 'minimal' ? value : 'full';
}

/** The pieces one controls level draws. */
interface Pieces {
    record: HTMLButtonElement | null;
    stop: HTMLButtonElement | null;
    timer: HTMLElement | null;
    timerDigits: HTMLElement | null;
    countdown: HTMLElement | null;
    remaining: HTMLElement | null;
    remainingDigits: HTMLElement | null;
    progress: HTMLElement | null;
    fill: HTMLElement | null;
    markerMin: HTMLElement | null;
    markerWarning: HTMLElement | null;
    meter: HTMLElement | null;
    bars: HTMLElement[];
    picker: HTMLElement | null;
    toggle: HTMLButtonElement | null;
    panel: HTMLElement | null;
    cameraList: HTMLElement | null;
    microphoneList: HTMLElement | null;
}

const NO_PIECES: Pieces = {
    record: null,
    stop: null,
    timer: null,
    timerDigits: null,
    countdown: null,
    remaining: null,
    remainingDigits: null,
    progress: null,
    fill: null,
    markerMin: null,
    markerWarning: null,
    meter: null,
    bars: [],
    picker: null,
    toggle: null,
    panel: null,
    cameraList: null,
    microphoneList: null,
};

function make<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Record<string, string> = {},
    html = '',
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);

    for (const [name, value] of Object.entries(attributes)) {
        node.setAttribute(name, value);
    }

    if (html !== '') {
        // Only the static icons above; device labels go through textContent.
        node.innerHTML = html;
    }

    return node;
}

/**
 * The element class, built when defineFittRecorder() runs: HTMLElement does
 * not exist in Node or in an SSR render, so nothing here runs at import.
 */
function createRecorderClass(): CustomElementConstructor {
    return class FittRecorderElement extends HTMLElement {
        static get observedAttributes(): string[] {
            return ['controls'];
        }

        #session: FittSession | null = null;
        #bound = false;
        #unsubscribe: (() => void)[] = [];
        #ticker: number | null = null;
        #labelTimer: number | null = null;
        #root: ShadowRoot;
        #view: HTMLVideoElement;
        #firstSlot: HTMLElement;
        #controlNodes: Node[] = [];
        #pieces: Pieces = NO_PIECES;
        #pickerOpen = false;
        #pickerKey = '';
        #lastPhase: Phase | null = null;
        #lastError: string | null = null;
        /** The `started` milestone's time: the take start when the session has no take view. */
        #startedAtMs: number | null = null;
        #elapsedMs = 0;
        #countdownText = '';

        constructor() {
            super();
            this.#root = this.attachShadow({ mode: 'open' });

            const style = make('style');
            style.textContent = STYLES;
            this.#view = make('video', {
                part: 'view',
                playsinline: '',
                muted: '',
                autoplay: '',
            });
            this.#view.muted = true;
            this.#view.playsInline = true;
            this.#view.autoplay = true;
            this.#root.append(style, this.#view);

            const slots = SLOTS.map((name) => {
                const holder = make('div', { class: `slot slot-${name}` });
                holder.append(make('slot', { name }));

                return holder;
            });
            this.#firstSlot = slots[0];
            this.#root.append(...slots);
            this.#build();
        }

        get session(): FittSession | null {
            return this.#session;
        }

        set session(next: FittSession | null) {
            if (next === this.#session) {
                return;
            }

            this.#unbind();
            this.#session = next ?? null;
            this.#lastPhase = null;
            this.#lastError = null;
            this.#startedAtMs = null;
            this.#elapsedMs = 0;
            this.#setCountdown('');

            if (this.#session === null) {
                for (const name of [
                    'phase',
                    'checks',
                    'upload',
                    'audio',
                    'error',
                ]) {
                    delete this.dataset[name];
                }

                this.#draw();

                return;
            }

            this.#bind();
        }

        connectedCallback(): void {
            this.#bind();
        }

        disconnectedCallback(): void {
            this.#unbind();
        }

        attributeChangedCallback(name: string): void {
            if (name === 'controls') {
                this.#build();
                this.#draw();
            }
        }

        /** Subscribes to the session and shows its stream; only while connected. */
        #bind(): void {
            const session = this.#session;

            if (session === null || this.#bound || !this.isConnected) {
                return;
            }

            this.#bound = true;
            // The element mirrors the view with CSS, so the mirror attribute can change at any time.
            session.attachPreview(this.#view, { mirror: false });
            this.#unsubscribe = [
                session.onStatus((state) => this.#apply(state)),
                session.onEvent((event: SdkEvent) =>
                    this.#emit('fitt-event', event),
                ),
                session.onMilestone((milestone) => {
                    this.#milestone(milestone);
                    this.#emit('fitt-milestone', milestone);
                }),
                session.onChecks((checks: ChecksResult) =>
                    this.#emit('fitt-checks', checks),
                ),
                session.onReady((ready: { track: TrackName; url: string }) =>
                    this.#emit('fitt-ready', ready),
                ),
                session.onAudioLevel((level) => this.#level(level)),
            ];
            this.#ticker = window.setInterval(() => this.#draw(), TICK_MS);
            this.#apply(session.state);
        }

        /** Hands the stall watch back to the session, then unsubscribes. Never stops the session (spec 6.2). */
        #unbind(): void {
            const session = this.#session;

            if (!this.#bound || session === null) {
                return;
            }

            this.#bound = false;
            session.detachPreview(this.#view);
            this.#view.srcObject = null;

            for (const unsubscribe of this.#unsubscribe) {
                unsubscribe();
            }

            this.#unsubscribe = [];

            if (this.#ticker !== null) {
                window.clearInterval(this.#ticker);
                this.#ticker = null;
            }

            if (this.#labelTimer !== null) {
                window.clearTimeout(this.#labelTimer);
                this.#labelTimer = null;
            }
        }

        #emit(type: string, detail: unknown): void {
            this.dispatchEvent(
                new CustomEvent(type, {
                    detail,
                    bubbles: true,
                    composed: true,
                }),
            );
        }

        /** Mirrors the state into the data attributes, then dispatches fitt-state. */
        #apply(state: SessionState): void {
            const session = this.#session;

            if (session === null) {
                return;
            }

            const previous = this.#lastPhase;
            this.#lastPhase = state.phase;
            this.dataset.phase = state.phase;
            this.dataset.upload = uploadAttribute(state);
            this.dataset.audio = state.audio;

            if (state.checks === null) {
                delete this.dataset.checks;
            } else {
                this.dataset.checks = state.checks.status;
            }

            const code = state.error?.code ?? null;

            if (code === null) {
                delete this.dataset.error;
            } else {
                this.dataset.error = code;
            }

            if (
                state.phase === 'ready' ||
                state.phase === 'idle' ||
                state.phase === 'countdown'
            ) {
                if (previous !== state.phase) {
                    this.#startedAtMs = null;
                    this.#elapsedMs = 0;
                }
            }

            if (state.phase !== 'countdown' && this.#labelTimer === null) {
                this.#setCountdown('');
            }

            this.#draw();

            if (code !== this.#lastError) {
                this.#lastError = code;

                if (state.error !== null) {
                    this.#emit('fitt-error', state.error);
                }
            }

            this.#emit('fitt-state', state);

            // Never from stopped: a finalised session's tombstone is stopped (Task 15 item 10).
            if (state.phase === 'idle' && previous !== 'idle') {
                session.prepare().catch(() => undefined);
            }
        }

        #milestone(milestone: Milestone): void {
            if (
                milestone.name === 'countdown_tick' ||
                milestone.name === 'countdown_last'
            ) {
                this.#setCountdown(
                    String(Math.ceil((milestone.remaining_ms ?? 0) / 1000)),
                );

                return;
            }

            if (milestone.name === 'countdown_cancelled') {
                this.#setCountdown('');

                return;
            }

            if (milestone.name === 'started') {
                this.#startedAtMs = milestone.t_ms;
                const label = this.getAttribute('start-label') ?? '';

                if (label === '') {
                    this.#setCountdown('');

                    return;
                }

                this.#setCountdown(label);

                if (this.#labelTimer !== null) {
                    window.clearTimeout(this.#labelTimer);
                }

                this.#labelTimer = window.setTimeout(() => {
                    this.#labelTimer = null;
                    this.#setCountdown('');
                }, START_LABEL_MS);
            }
        }

        #setCountdown(text: string): void {
            this.#countdownText = text;

            if (this.#pieces.countdown !== null) {
                this.#pieces.countdown.textContent = text;
            }
        }

        #level(level: number): void {
            const bars = this.#pieces.bars;
            const lit =
                level <= METER_FLOOR
                    ? 0
                    : Math.min(
                          METER_BARS,
                          Math.ceil(Math.sqrt(level / METER_FULL) * METER_BARS),
                      );

            bars.forEach((bar, index) => {
                bar.toggleAttribute('data-on', index < lit);
            });
        }

        /** Builds the pieces of the current controls level, between the view and the slots. */
        #build(): void {
            for (const node of this.#controlNodes) {
                node.parentNode?.removeChild(node);
            }

            this.#controlNodes = [];
            this.#pickerOpen = false;
            this.#pickerKey = '';
            const controls = controlsOf(this.getAttribute('controls'));
            const pieces: Pieces = { ...NO_PIECES, bars: [] };

            if (controls !== 'none') {
                const record = make(
                    'button',
                    { part: 'record', type: 'button', 'aria-label': 'Record' },
                    '<span class="glyph"></span>',
                );
                const stop = make(
                    'button',
                    { part: 'stop', type: 'button', 'aria-label': 'Stop' },
                    '<span class="glyph"></span>',
                );
                record.addEventListener('click', () => {
                    this.#session?.start().catch(() => undefined);
                });
                stop.addEventListener('click', () => {
                    this.#session?.stop().catch(() => undefined);
                });
                const timer = make(
                    'div',
                    { part: 'timer', role: 'timer' },
                    '<span class="dot"></span>',
                );
                const timerDigits = make('span');
                timerDigits.textContent = '0:00';
                timer.append(timerDigits);
                Object.assign(pieces, { record, stop, timer, timerDigits });
            }

            if (controls === 'full') {
                const countdown = make('div', {
                    part: 'countdown',
                    'aria-live': 'assertive',
                });
                countdown.textContent = this.#countdownText;
                const progress = make('div', { part: 'progress' });
                const fill = make('div', { class: 'fill' });
                const markerMin = make('div', { part: 'marker-min' });
                const markerWarning = make('div', { part: 'marker-warning' });
                progress.append(fill, markerMin, markerWarning);
                const remaining = make(
                    'div',
                    { part: 'remaining' },
                    CLOCK_ICON,
                );
                const remainingDigits = make('span');
                remainingDigits.textContent = '0:00';
                remaining.append(remainingDigits);
                const meter = make('div', {
                    part: 'meter',
                    'aria-hidden': 'true',
                });
                const bars = METER_HEIGHTS.map((height) => {
                    const bar = make('span', {
                        class: 'bar',
                        style: `height: ${height}px`,
                    });
                    meter.append(bar);

                    return bar;
                });
                const picker = make('div', { part: 'picker' });
                const toggle = make(
                    'button',
                    {
                        part: 'picker-toggle',
                        type: 'button',
                        'aria-label': 'Choose camera and microphone',
                        'aria-expanded': 'false',
                        'aria-haspopup': 'listbox',
                    },
                    SLIDERS_ICON,
                );
                const panel = make('div', { class: 'panel', hidden: '' });
                const cameraList = make(
                    'div',
                    {
                        part: 'picker-list',
                        role: 'listbox',
                        'aria-label': 'Cameras',
                    },
                    CAMERA_ICON,
                );
                const microphoneList = make(
                    'div',
                    {
                        part: 'picker-list',
                        role: 'listbox',
                        'aria-label': 'Microphones',
                    },
                    MICROPHONE_ICON,
                );
                panel.append(cameraList, microphoneList);
                picker.append(toggle, panel);
                toggle.addEventListener('click', () => {
                    this.#setPicker(!this.#pickerOpen);
                });
                Object.assign(pieces, {
                    countdown,
                    progress,
                    fill,
                    markerMin,
                    markerWarning,
                    remaining,
                    remainingDigits,
                    meter,
                    bars,
                    picker,
                    toggle,
                    panel,
                    cameraList,
                    microphoneList,
                });
            }

            // In the boards' stacking order: the countdown scrim lies under the controls.
            const order = [
                pieces.countdown,
                pieces.progress,
                pieces.meter,
                pieces.timer,
                pieces.remaining,
                pieces.record,
                pieces.stop,
                pieces.picker,
            ].filter((node): node is HTMLElement => node !== null);

            for (const node of order) {
                this.#root.insertBefore(node, this.#firstSlot);
            }

            this.#controlNodes = order;
            this.#pieces = pieces;
        }

        #setPicker(open: boolean): void {
            const { toggle, panel } = this.#pieces;

            if (toggle === null || panel === null) {
                return;
            }

            this.#pickerOpen = open;
            toggle.setAttribute('aria-expanded', String(open));
            panel.hidden = !open;

            if (open) {
                this.#pickerKey = '';
                this.#drawPicker();
            }
        }

        /** The browser's device labels, the chosen one ticked. Drawn only when something changed. */
        #drawPicker(): void {
            const session = this.#session;
            const { cameraList, microphoneList } = this.#pieces;

            if (
                session === null ||
                cameraList === null ||
                microphoneList === null
            ) {
                return;
            }

            const { cameras, microphones, selected } = session.devices;
            const key = JSON.stringify([
                cameras.map((device) => [device.deviceId, device.label]),
                microphones.map((device) => [device.deviceId, device.label]),
                selected,
            ]);

            if (key === this.#pickerKey) {
                return;
            }

            this.#pickerKey = key;
            const fill = (
                list: HTMLElement,
                kind: 'camera' | 'microphone',
                devices: MediaDeviceInfo[],
                chosen: string | undefined,
            ): void => {
                for (const option of [...list.querySelectorAll('button')]) {
                    option.remove();
                }

                devices.forEach((device, index) => {
                    const isChosen =
                        chosen === undefined
                            ? index === 0
                            : chosen === device.deviceId;
                    const option = make(
                        'button',
                        {
                            part: 'picker-option',
                            type: 'button',
                            role: 'option',
                            'aria-selected': String(isChosen),
                        },
                        CHECK_ICON,
                    );
                    // The browser's label; without one, its number in the list.
                    option.append(device.label || String(index + 1));
                    option.addEventListener('click', () => {
                        this.#setPicker(false);
                        session.devices
                            .select(kind, device.deviceId)
                            .catch(() => undefined);
                    });
                    list.append(option);
                });
            };

            fill(cameraList, 'camera', cameras, selected.camera);
            fill(
                microphoneList,
                'microphone',
                microphones,
                selected.microphone,
            );
        }

        /** The timers, the bar, the stop rule and which pieces show, for the current phase. */
        #draw(): void {
            const session = this.#session;
            const pieces = this.#pieces;
            const phase: Phase | 'none' = session?.state.phase ?? 'none';
            const view = session === null ? null : takeView(session);
            const limits = view?.recording ?? null;
            const takeStart = view?.takeStartMs ?? this.#startedAtMs;
            const live = phase === 'recording' || phase === 'stopping';

            if (live && takeStart !== null && session !== null) {
                this.#elapsedMs = Math.max(0, session.now() - takeStart);
            }

            const elapsed = this.#elapsedMs;
            const taking = phase === 'countdown' || live;

            if (pieces.record !== null && pieces.stop !== null) {
                pieces.record.hidden = taking;
                pieces.record.disabled = phase !== 'ready';
                pieces.stop.hidden = !taking;
                pieces.stop.disabled =
                    phase === 'stopping' ||
                    (phase === 'recording' &&
                        limits !== null &&
                        takeStart !== null &&
                        elapsed < limits.min_duration_ms);
            }

            if (pieces.timer !== null && pieces.timerDigits !== null) {
                pieces.timer.hidden = !live && phase !== 'stopped';
                pieces.timerDigits.textContent = formatClock(elapsed);
            }

            if (
                pieces.progress !== null &&
                pieces.fill !== null &&
                pieces.remaining !== null &&
                pieces.remainingDigits !== null &&
                pieces.markerMin !== null &&
                pieces.markerWarning !== null
            ) {
                const max = limits?.max_duration_ms ?? 0;
                const extension = limits?.extension_ms ?? 0;
                const warningMs = limits?.warning_before_end_ms ?? 0;
                const minMs = limits?.min_duration_ms ?? 0;
                const inGrace = max > 0 && elapsed >= max;
                const left = inGrace
                    ? max + extension - elapsed
                    : max - elapsed;
                const stage = inGrace
                    ? 'grace'
                    : warningMs > 0 && max > 0 && left <= warningMs
                      ? 'warning'
                      : 'normal';
                const shown = live && limits !== null && max > 0;

                pieces.progress.hidden = !shown;
                pieces.remaining.hidden = !shown;
                pieces.progress.dataset.stage = stage;
                pieces.remaining.dataset.stage = stage;
                pieces.remainingDigits.textContent = formatClock(left, 'up');
                pieces.fill.style.width = `${max > 0 ? Math.min(100, (elapsed / max) * 100) : 0}%`;
                pieces.markerMin.hidden = minMs <= 0 || max <= 0;
                pieces.markerMin.style.left = `${max > 0 ? Math.min(100, (minMs / max) * 100) : 0}%`;
                pieces.markerWarning.hidden = warningMs <= 0 || max <= 0;
                pieces.markerWarning.style.left = `${max > 0 ? Math.max(0, ((max - warningMs) / max) * 100) : 0}%`;
            }

            if (pieces.meter !== null) {
                pieces.meter.hidden =
                    phase !== 'ready' &&
                    phase !== 'countdown' &&
                    phase !== 'recording';
            }

            if (pieces.picker !== null && pieces.toggle !== null) {
                const devices = session?.devices;
                const listed =
                    devices !== undefined &&
                    devices.cameras.length + devices.microphones.length > 0;
                pieces.picker.hidden = phase !== 'ready';
                pieces.toggle.disabled = !listed;

                if (phase !== 'ready' && this.#pickerOpen) {
                    this.#setPicker(false);
                } else if (this.#pickerOpen) {
                    this.#drawPicker();
                }
            }
        }
    };
}

/**
 * Defines `<fitt-recorder>` (spec 6.4). Nothing touches the DOM until this
 * is called. A name already taken is left alone, so calling it twice is safe.
 */
export function defineFittRecorder(
    registry: CustomElementRegistry = customElements,
    name = 'fitt-recorder',
): void {
    if (registry.get(name) !== undefined) {
        return;
    }

    registry.define(name, createRecorderClass());
}
