# @fitt-ai/video-sdk

Records answers, conversations and proctoring sessions in the browser for
Fitt Video. The host's server creates a session with its API key and hands
the page a descriptor; the SDK captures the camera and microphone (or the
microphone alone), cuts segments, keeps them in IndexedDB until the server
has them, uploads, finalises and lets the person review the take. It draws
nothing unless you use the `<fitt-recorder>` element.

The full integration guide, with every error code and the webhook rules, is
[`skill/SKILL.md`](./skill/SKILL.md), shipped inside this package.

## Install

```bash
npm i @fitt-ai/video-sdk
```

```js
import { FittVideo } from '@fitt-ai/video-sdk';
import { defineFittRecorder } from '@fitt-ai/video-sdk/ui';

defineFittRecorder(); // once, on the client
```

Or load the hosted build, with no bundler:

```html
<script type="module">
  import { FittVideo } from 'https://<fitt-video-host>/sdk/v1/fitt-video.js';
  // It defines <fitt-recorder> on load.
</script>
```

`/sdk/v1/fitt-video.iife.js` is the classic script (it sets
`window.FittVideo`, with `defineFittRecorder`). `/sdk/1.x.y/` pins one exact
build. Nothing touches the DOM at import, so server-side rendering is safe.

## A session

Your server calls `POST /api/v1/sessions` with its API key and passes only
the `descriptor` to the page. Never send the API key to the page.

```js
const session = FittVideo.session(descriptor, {
  // Optional, and it can only narrow what the descriptor allows.
  capture: { audio: { audio_bitrate_bps: 48000 } },
});
```

Calling `FittVideo.session(` again with the same `session_id` returns the
same object and takes the newer token.

## Record, stop, hand in

```js
await session.prepare(); // asks for the devices; the preview and the meter run in `ready`
session.attachPreview(videoEl); // optional: your own preview element

await session.start(); // the countdown, then recording
// ...
await session.stop(); // resolves once the server knows where the take ends
await session.finalise(); // hands the session in, once the person is done
```

`session.reset()` records again from `stopped` or `rejected`;
`session.discard()` throws the session away. Listen with
`session.onStatus()`, `session.onEvent()`, `session.onMilestone()` and
`session.onChecks()`.

## The verdict

```js
const checks = await session.waitForChecks({ timeoutMs: 60000 });
// checks.verdict: 'accept', 'reject', 'unknown' or null
```

It fails open and is advisory: your server acts on the
`session.checks.completed` webhook, never on the page.

## Playback

```js
// The playback URL of the playback track, once the server file is ready.
// Needs `playback_in_status: true` on POST /api/v1/sessions.
const url = await session.waitForReady({ timeoutMs: 120000 });

// Or name a track.
const cameraUrl = await session.waitForReady({ track: 'camera' });
```

With no `track`, `session.waitForReady(` waits for
`session.playbackTrack`: `'camera'` in a video session, `'audio'` in an
audio-only session, `null` in a file session (then it rejects
`invalid_state`, reason `no_playback_track`).

### Review right after stop

```js
await session.stop();
await session.finalise();
const source = await session.playback(mediaEl); // 'local' or 'server'
```

`session.playback(` plays the server file when it is ready, else a seekable
copy the browser holds in memory, else it waits for the server file. It
switches to the server file only while the media is paused or ended, and it
never calls `play()`. Pass a `<video controls>`, or an `<audio controls>`
in an audio-only session.

## Conversation: mixAudio()

```js
await session.prepare();
session.mixAudio(interviewerStream, { role: 'interviewer' });
```

The recording holds the person on the left channel and the interviewer on
the right. The source can be a `MediaStream`, a `MediaStreamTrack`, an
`AudioNode` or an `HTMLMediaElement`. Call `session.mixAudio(` again after
every `reset()`. Recommend headphones.

## After a reload: FittVideo.resume()

```js
const entries = await FittVideo.resume();

for (const { session_id, state, session } of entries) {
  // 'interrupted', 'finalising', 'discarding', 'resume_expired' or 'owned_elsewhere'
}
```

Call it on page load, before creating a new session.

## The element: `<fitt-recorder>`

```html
<fitt-recorder controls="full" review start-label="Go">
  <div slot="instructions">Look at the camera and answer the question.</div>
  <div slot="error">Something went wrong.</div>
  <div slot="checking">Checking your recording...</div>
  <div slot="no-audio">We can't hear you. Check your microphone.</div>
  <div slot="rejected">Please record again.</div>
  <div slot="review">Happy with it? <button>Record again</button></div>
  <span slot="level" class="mic-ring"></span>
  <div slot="controls"><!-- your own buttons --></div>
</fitt-recorder>
<script type="module">
  document.querySelector('fitt-recorder').session = FittVideo.session(descriptor);
</script>
```

Call `defineFittRecorder()` once first when you use the npm build.

- **Property:** `session` (a DOM property, not an attribute).
- **Attributes:** `controls` (`none`, `minimal` or `full`, the default),
  `review` (plays the take after stop), `start-label`, `mirror="false"`.
- **Slots:** `instructions`, `error`, `checking`, `no-audio`, `rejected`,
  `review`, `level` (a host visual that inherits `--fitt-level`) and
  `controls`.
- **Data attributes:** `data-phase`, `data-upload`, `data-audio`
  (`ok` or `silent`), `data-checks`, `data-error`, `data-review`,
  `data-media` (`video` or `audio`) and `data-speaking`.
- **DOM events** (bubbling, composed): `fitt-state`, `fitt-error`,
  `fitt-event`, `fitt-milestone`, `fitt-checks`, `fitt-ready`.
- **Vue 3:** `compilerOptions.isCustomElement: (tag) => tag.startsWith('fitt-')`
  and `:session.prop="session"`.

## Audio only

Your server creates the session with one audio track and no camera:

```json
{ "recipe": "answer", "tracks": ["audio"] }
```

(`conversation` the same way; the PHP SDK's
`Recipe::answer()->audioOnly()` sends it.) Nothing else changes in the
browser: the same calls, the same events. The one track is recorded at
64 kbps (mono for `answer`; stereo for `conversation`, with the
interviewer on the right through `mixAudio()`), and it is the playable file
and the checks input.

- `session.playbackTrack` is `'audio'`, and `waitForReady()` with no track
  waits for it.
- Review with an `<audio controls>`: `await session.playback(audioEl)`.
- `<fitt-recorder>` becomes a strip (`data-media="audio"`, height
  `--fitt-recorder-audio-height`, 160 px by default) and reviews in its own
  `<audio part="review">`.
- A missing device is `no_microphone`, never `no_camera`.
- Lower the bitrate with `capture.audio.audio_bitrate_bps`, never
  `capture.camera`.

## Audio levels

The SDK draws nothing; you draw. **Never call `getUserMedia` again:** a
second capture can mute the first on iOS. Every hook below hangs off the
SDK's one capture, in `ready` before recording and in video sessions too.

### In CSS, from the element

`<fitt-recorder>` sets `--fitt-level` (0 to 1) on itself and
`data-speaking` while the person speaks. A child in the `level` slot
inherits the property. It updates at 10 Hz, so give it a transition of
about 100 ms:

```css
.mic-ring {
  transform: scale(calc(1 + var(--fitt-level, 0) * 0.5));
  transition: transform 100ms linear;
}
fitt-recorder[data-speaking] .mic-ring { border-color: #e93544; }
```

### In script: `session.audio`

```js
session.audio.getInputVolume(); // the microphone now, 0 to 1
session.audio.getOutputVolume(); // the interviewer side of a conversation mix, 0 to 1

const stop = session.audio.onFrame(({ level, peak, bands }) => {
  // On every animation frame while a listener is attached and the tab is visible.
});
stop();

const stream = session.audio.stream; // the SDK's microphone stream, no video track
const analyser = session.audio.createAnalyser({ fftSize: 1024 }); // on the SDK's own context
const context = session.audio.context; // the SDK's AudioContext

session.audio.onChange(() => {
  // After every acquire and release: ask again for stream or an analyser.
});
```

- `session.audio.getInputVolume` and `getOutputVolume` are closures, safe to
  pass unbound. `getOutputVolume()` is 0 without a conversation mix.
- In `session.audio.onFrame(`, `level` is on the same curve as
  `--fitt-level`. `peak` is the raw largest absolute sample of the last
  analyser window, 0 to 1, not on the level curve; `level` is on the curve.
  `bands` is 8 values from 100 Hz to 8 kHz, 0 to 1, in one reused
  `Float32Array`: copy it to keep it.
- `session.audio.stream`, `context` and `createAnalyser()` are null before
  `prepare()` and after `stop()` (capture is released at stop), and every
  level is 0 then. They are live again once `reset()` resolves: reset
  acquires capture again and fires `onChange`, so a host holding `stream`
  or an analyser asks again there. Every level is also 0 before the first click or key press on the
  page (the browser keeps the context suspended).
- The stream survives a device switch, not a new prepare: listen to
  `onChange`.
- With the ElevenLabs UI Orb, pass `volumeMode="manual"`: in the default `auto` mode the Orb ignores `getInputVolume` and `getOutputVolume`.
- ElevenLabs UI `BarVisualizer` takes `session.audio.stream` as its
  `mediaStream`. Do not use `LiveWaveform` as is: it calls `getUserMedia`
  itself.

See [`skill/SKILL.md`](./skill/SKILL.md) for ready-to-copy visualizers.
