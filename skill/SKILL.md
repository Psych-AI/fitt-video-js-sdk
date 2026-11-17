---
name: video-sdk-integration
version: 1
description: >-
  Use when wiring Fitt Video recording into a host (source) platform: loading
  @fitt/video-sdk or /sdk/v1/fitt-video.js, the POST /api/v1/sessions
  descriptor hand-off, FittVideo.session, FittVideo.resume, <fitt-recorder>,
  defineFittRecorder, Vue's isCustomElement, start / stop / reset / discard /
  finalise, waitForChecks, waitForReady, mixAudio for conversation takes,
  uploadTranscript, the fitt-* DOM events (fitt-state, fitt-error,
  fitt-event, fitt-milestone, fitt-checks, fitt-ready), iframe
  allow="camera; microphone; fullscreen", and error codes such as
  network_blocked, token_expired, token_refresh_blocked, manifests_blocked,
  permission_denied, too_short; review right after recording with
  session.playback(video), <fitt-recorder review>, data-review, the review
  slot, playback.source, state.playback and playback_in_status (SDK 1.3.0);
  audio-only recording ("tracks": ["audio"], Recipe::answer()->audioOnly(),
  session.playbackTrack, an <audio> review, no_microphone) and the host's
  audio visualizers (session.audio, getInputVolume, getOutputVolume, onFrame,
  session.audio.stream, createAnalyser, --fitt-level, data-speaking,
  data-media, the level slot, the ElevenLabs UI Orb, BarVisualizer and
  LiveWaveform) (SDK 1.4.0).
---

# Fitt Video SDK integration (version 1)

How a host platform records with Fitt Video: its server creates a session
with its API key, its page records with only the descriptor, and its
server learns the outcome from the webhook. This file ships inside the
`@fitt/video-sdk` package (`skill/SKILL.md`) and is the source; the
`.claude/skills/video-sdk-integration/` and
`.agents/skills/video-sdk-integration/` copies in the Fitt Video repo are
byte-for-byte mirrors of it. SDK version 1.x.

## Architecture

- **The host's server** holds the API key (`fvk_...`). It calls
  `POST /api/v1/sessions` (a recipe such as `answer`, `monitor` or
  `conversation`, plus `external_ref`, `tags`, `webhook_url` and the rest)
  and gets `201 {descriptor, session}`. It passes only the `descriptor` to
  the page. The descriptor carries a short-lived upload token for that one
  session, the recording limits, the tracks and the API URL.
- **The page** loads the SDK, calls `FittVideo.session(descriptor)` and
  records. The SDK cuts segments, keeps them in IndexedDB until the server
  has them, refreshes its own token, sends events and finalises. A reload
  resumes the queue.
- **The webhook decides.** The browser can wait for the checks verdict and
  for playback, but it fails open: the host's server must act on the
  webhook, never on what the page reports.

## Quick reference

| Task | Do this |
|---|---|
| Load the SDK | `<script type="module">import { FittVideo } from 'https://<fitt-video-host>/sdk/v1/fitt-video.js';</script>`, or the IIFE `/sdk/v1/fitt-video.iife.js` (sets `window.FittVideo`), or `npm i @fitt/video-sdk` (`import { FittVideo } from '@fitt/video-sdk'`, element from `@fitt/video-sdk/ui`). Pin `/sdk/1.x.y/` for an exact build |
| Start a take | Server: `POST /api/v1/sessions`. Page: `const s = FittVideo.session(descriptor); el.session = s;` then the element's record button, or `await s.prepare(); await s.start();` |
| Stop and hand in | `await s.stop();` then `await s.finalise();` once the candidate is done with every take |
| Record again | `await s.reset();` from `stopped` or `rejected`, then `start()` again |
| Review the take right after stop | Create the session with `playback_in_status: true`, then `await s.finalise();` at stop and `await s.playback(videoEl);` (or `<fitt-recorder review>`). See "Review right after recording" |
| Retake after finalise | A new session from your server (`POST /api/v1/sessions` again), then `FittVideo.session(newDescriptor)` |
| Throw the session away | `await s.discard();` |
| Wait for the verdict | `const checks = await s.waitForChecks({ timeoutMs: 60000 });` `checks.verdict` is `accept`, `reject`, `unknown` or null. Act on the webhook, not on this |
| Get a playback URL | `const url = await s.waitForReady();` (the playback track, `s.playbackTrack`) or `await s.waitForReady({ track: 'camera' });` Needs `playback_in_status: true` on `POST /api/v1/sessions`. Rejects `playback_not_enabled` with an empty `detail` when the session has no `playback_in_status`, and with `detail.reason: 'timeout'` when no URL came in time. Rejects `track_failed` with `detail.reason` (the track's `failure_reason`, for example `no_decodable_run`) as soon as the status shows the track failed |
| Get a playback URL on your server | `GET /api/v1/videos/{id}/playback` with the API key: `200 {url, expires_at, mime_type}`, valid for the space's `playback_url_lifetime_s`; `409 not_ready`, `410 expired` |
| Get a still frame on your server | `GET /api/v1/videos/{id}/frame?t_ms=` with the API key: `200 image/jpeg` at session time `t_ms`; `409 not_ready`, `409 no_video`, `422 out_of_range`, `410 expired`, `409 discarded`, `503 frame_failed` (ffmpeg gave no frame; retry later) |
| Record audio only | Server: `{"recipe": "answer", "tracks": ["audio"]}` (or `conversation`), or `Recipe::answer()->audioOnly()`. Page: unchanged; review with `s.playback(audioEl)`. See "Audio only" |
| Draw a level ring, bars or an Orb | Use `--fitt-level` and `data-speaking` on the element, or `s.audio` (`getInputVolume`, `getOutputVolume`, `onFrame`, `stream`, `createAnalyser`). Never call `getUserMedia`. See "Visualizers" |
| Mix interviewer audio | `s.mixAudio(remoteStreamOrTrackOrAudioElement, { role: 'interviewer' });` after `prepare()`, and again after each `reset()` |
| Reload safety | On page load: `const entries = await FittVideo.resume();` and handle each entry (below) before creating anything new |
| Handle an error | Read `s.state.error?.code` (or listen to `fitt-error`) and show the row in the error table below |
| Re-mint a token | Server: `POST /api/v1/sessions/{id}/upload-token` with the API key; page: `FittVideo.session(newDescriptor)` (same id, same object, the new token is swapped in) |

## The descriptor hand-off

- Never send the API key to the page. The page needs only the
  descriptor, and the descriptor is only good for its own session.
- Render the descriptor into the page (or fetch it from your own server)
  and call `FittVideo.session(descriptor, options?)`. Calling it again
  with the same `session_id` returns the same object and takes a newer
  token from the new descriptor; an older token is ignored.
- Pass the descriptor as you hold it: a Vue or Inertia reactive prop is
  fine, the SDK keeps its own plain copy (1.0.1) and never reads your
  object again, so later changes to it do nothing.
- `options` can only narrow what the descriptor allows: fewer signal
  groups, lower bitrates, a shorter `enforce.stay_on_page.grace_ms`,
  `upload.transport: 'post'`, `checks: { wait, timeoutMs }`. A value that
  would widen the descriptor is ignored with a console warning. `ui` and
  `enforce` keys other than `stay_on_page` are ignored with a warning in 1.0.

## Loading

- **Hosted, as a module:** `/sdk/v1/fitt-video.js` is served with
  `Access-Control-Allow-Origin: *` and `text/javascript`, so any origin can
  import it. It defines `<fitt-recorder>` on load. `v1` follows the current
  1.x build (cached 5 minutes); `/sdk/1.x.y/` is one exact build, cached for
  a year. Only the current build is served: an older pin answers 404.
- **Hosted, classic script:** `/sdk/v1/fitt-video.iife.js` sets
  `window.FittVideo` (with `defineFittRecorder`).
- **npm:** `@fitt/video-sdk` (`.`: `FittVideo`, `FittVideoError` and the
  types; `./ui`: `defineFittRecorder`). Call `defineFittRecorder()` once on
  the client. Nothing touches the DOM at import, so server-side rendering
  is safe.

## On page load: `FittVideo.resume()`

`FittVideo.resume()` returns one `{session_id, state, session}` per session
stored on this device. Call it before creating a new session, so a
reloaded or crashed page picks up where it was.

| `state` | What it means | What the host does |
|---|---|---|
| `interrupted` | A take was open or stopping when the page went | Offer Continue (`FittVideo.session(descriptor)` then `start()`: the take continues with no countdown), Finalise, Reset or Discard |
| `finalising` | Stop had completed; the SDK drains and finalises by itself | Nothing; show "uploading" |
| `discarding` | A discard never landed; it is being finished | Nothing |
| `resume_expired` | The token lapsed while the page was away | Re-mint from your server and call `FittVideo.session(descriptor)` |
| `owned_elsewhere` | Another tab of this browser holds the session | `session` is null; tell the candidate to use the other tab |

Every entry but `owned_elsewhere` carries its session object, and its
`finalise()`, `reset()` and `discard()` work with no descriptor at hand.

## The element

```html
<fitt-recorder controls="full" start-label="Go">
  <div slot="instructions">Look at the camera and answer the question.</div>
  <div slot="error">Something went wrong.</div>
  <div slot="checking">Checking your recording...</div>
  <div slot="no-audio">We can't hear you. Check your microphone.</div>
  <div slot="rejected">Please record again.</div>
  <div slot="controls"><!-- your own buttons --></div>
</fitt-recorder>
<script type="module">
  const el = document.querySelector('fitt-recorder');
  el.session = FittVideo.session(descriptor);
</script>
```

- **Property:** `session` (set it as a DOM property, not an attribute).
- **Attributes:** `controls` (`none` draws only the view; `minimal` adds
  record, stop and the timer; `full`, the default, adds the countdown, the
  progress bar with its markers, the remaining time, the meter and the
  device picker; there is no retake button, so put "record again" in the
  `rejected` or `controls` slot and call `session.reset()`), `start-label` (shown for a second at the
  start), `mirror="false"` (the preview is mirrored by default; the
  recording never is).
- **Slots:** `instructions` (idle, ready), `error` (while `data-error` is
  set), `checking` (stopped, checks pending), `no-audio` (microphone
  silent), `rejected` (verdict reject), `controls` (always).
- **Parts** for `::part()`: `view`, `record`, `stop`, `timer`, `countdown`,
  `progress`, `marker-min`, `marker-warning`, `remaining`, `meter`,
  `picker`, `picker-toggle`, `picker-list`, `picker-option`.
- **Data attributes** on the element: `data-phase`, `data-upload`
  (`done` only when stopped, uploaded and finalised), `data-audio`
  (`ok` or `silent`), `data-checks`, `data-error`.
- **DOM events** (bubbling, composed): `fitt-state` (the whole state),
  `fitt-error` (`{code, detail?}` once per change), `fitt-event`,
  `fitt-milestone`, `fitt-checks`, `fitt-ready` (`{track, url}`).
- **Vue 3:** tell the compiler the tag is a custom element
  (`compilerOptions.isCustomElement: (tag) => tag.startsWith('fitt-')`)
  and bind the session as a property (`:session.prop="session"`). Render
  the element only after the SDK has defined it. A shadow DOM slot is the
  native `slot="..."` attribute, not a Vue slot.

## The take flow

Phases: `idle`, `preparing`, `ready`, `countdown`, `recording`,
`stopping`, `stopped`, `rejected`, `error`.

- `prepare()` asks for the camera and microphone (the preview and the
  meter run in `ready`). `start()` runs the countdown and resolves at the
  `started` milestone; it rejects `countdown_cancelled` if the countdown is
  cut short. From `stopped` or `rejected`, `start()` needs `reset()` first
  (`invalid_state`).
- `stop()` resolves once every track's manifest has the server's answer,
  so `stopped` means the server knows where the take ends. A take stopped
  before `min_duration_ms` rejects `too_short` and is reset on the server,
  and the phase goes back to `ready`.
- The SDK stops the take itself at `max_duration_ms` plus the extension
  (`forced_stop` milestone), before the session cap (`session_cap_reached`),
  and, with `enforce.stay_on_page`, when the candidate leaves the page for
  longer than the grace.
- `stop({ sealTracks: false })` defers the manifests to `finalise()`.
- `finalise()` hands the session in. After it, `prepare()`, `start()`,
  `reset()` and `discard()` reject `invalid_state`. `waitForChecks()` and
  `waitForReady()` still work.
- Milestones (`onMilestone` or `fitt-milestone`): `countdown_tick`,
  `countdown_last`, `countdown_cancelled`, `started`, `warning`,
  `limit_reached`, `forced_stop`, `too_short`.
- `session.event('my_type', payload)` adds a `host.my_type` event to the
  session's timeline (false when the type is refused).

## Waiting for the verdict

- After `stop()` the SDK polls the status by itself; `waitForChecks()`
  shares that poll. It resolves with `{status, verdict, take, reasons,
  reason?}`, or with a local `{status: 'pending', verdict: 'unknown'}` at the
  timeout (60 s by default). A `reject` verdict moves the phase to
  `rejected`.
- **Fail open.** Network trouble, a timeout or an `unknown` verdict must
  never block the candidate. The webhook to your server is authoritative.
- **The verdict and its reasons.** Only `answer` takes are checked. The
  server writes one verdict per take, once. `reasons` holds codes:
  `no_speech`, `incoherent`, `off_topic` and `audio_incomplete` can
  reject (when the space's `reject_on` lists them); `too_short`,
  `audio_incomplete`, `provider_unavailable` and `over_cap` can give
  `unknown`. A lost upload is `audio_incomplete`, never `no_speech`.
- **It is advisory.** `waitForChecks()` is for the candidate's screen. Act
  on `GET /api/v1/sessions/{id}/checks` from your server, or on the
  `session.checks.completed` webhook.
- **The webhooks.** The platform POSTs the session's `webhook_url` for nine
  events: `session.ready`, `session.failed`, `session.abandoned`,
  `session.discarded`, `video.ready` (once per track), `video.failed`,
  `session.checks.completed`, `transcript.ready` and `analysis.completed`.
  Each carries `X-Fitt-Event-Id`, `X-Fitt-Timestamp` and `X-Fitt-Signature`
  (`sha256=` HMAC-SHA256 of the timestamp, a dot and the raw body, keyed with
  the API key's webhook secret). Verify on your server with
  `fitt/video-sdk`'s `verifyWebhook()`, then route and dedupe on the
  verified body's `type` and `id`. Delivery order is not guaranteed: drop a
  `sequence` below the last one you accepted for the same session and
  `object_key` (`session` for the four session events, `video:{id}`,
  `checks:{take}`, `transcript:{id}`, `analysis:{id}`); never compare across
  objects. The PHP SDK's integration skill has the details.
- **`checks.reason`** (a short sentence from the meaningful check) is in the
  status payload only when the session was created with
  `checks: {expose_reason: true}`. Your server with the API key always sees it on
  `GET /checks`.
- `waitForReady({track})` resolves with a playback URL once the platform
  has one. It needs `playback_in_status: true` on `POST /api/v1/sessions`.
  It rejects `playback_not_enabled` with an empty `detail` when the session
  has no `playback_in_status`, and with `detail.reason: 'timeout'` when no
  URL came in time. It rejects `track_failed` with `detail.reason` (the
  track's `failure_reason`, for example `no_decodable_run`) as soon as the
  status shows the track failed. A timeout means the track is still
  processing: read `tracks[].status` and `failure_reason` from
  `GET /sessions/{id}` or the webhook. A ready track's URL lasts 2 minutes
  and is minted again on each poll.

## Review right after recording (SDK 1.3.0)

In the `answer` recipe (and in `conversation`, since SDK 1.4.0, when the
take fits the budget) the person can watch the take at once after stop,
even while segments still upload.

- **Create the session with `playback_in_status: true`.** Without it the
  page can show only the browser's own copy and never switches to the
  server file (the PHP SDK's `Recipe::answer()` leaves it off).
- **Finalise at stop**, then call `await s.playback(videoEl)` on your own
  `<video controls>`. It plays the server file when it is ready, else a
  seekable copy the browser holds in memory (when the descriptor's
  `playback.local` is true), else it waits for the server file. It
  switches from the copy to the server file only while the video is paused
  or ended, and keeps the place. It never calls `play()`. It resolves
  `'local'` or `'server'`, and rejects `playback_not_enabled`
  (`detail.reason: 'no_local_copy'`) with no copy and no
  `playback_in_status`, or `invalid_state` during a take or on the preview
  element.
- **Or let the element review:** `<fitt-recorder review>`. After stop it
  sets `data-review` (`preparing`, `local`, `server` or `none`) and shows
  your `review` slot for your words ("Record again" stays yours). With
  `controls="full"` or `"minimal"` it hides the camera view and plays the
  take in its own video. With `controls="none"` it binds no player: call
  `s.playback()` on your element, and `data-review` follows it. One
  session has one player: a later `playback()` call replaces the earlier
  one.
- **What to listen to:** the `playback.source` event (`onEvent` or
  `fitt-event`; never uploaded) and `state.playback` in `fitt-state`
  (`source`, `local`, `localBytes`, `localReason`).
- **A retake after finalise is a new session** created by your server.
- **Only the server file after a reload,** for a monitor session, a
  multi-run take, or a take over the server's budget: the copy lives in
  memory for one take with one run, and a reset, a discard, `destroy()`,
  leaving the page or a new session clears it.
- To keep a page server-only, pass `{ playback: { local: false } }` to
  `FittVideo.session()`.

## Audio only (SDK 1.4.0)

The `answer` and `conversation` recipes can record one audio track and no
camera.

- **The host's server creates it:** `Recipe::answer()->audioOnly()` in the
  PHP SDK, or `POST /api/v1/sessions` with
  `{"recipe": "answer", "tracks": ["audio"]}`. `conversation` works the same
  way, with the interviewer on the right channel through `mixAudio()`. The
  one track is recorded at 64 kbps (mono for answer, stereo for
  conversation), and it is the playable file and the checks input.
- **The page changes nothing.** The same calls, the same events.
  `session.playbackTrack` is `'audio'`, so `waitForReady()` with no track
  waits for the audio file, and `session.playback(audioEl)` takes an
  `<audio controls>`.
- **The element** becomes a strip: `data-media="audio"`, height
  `--fitt-recorder-audio-height` (160 px by default), no camera list in the
  picker. With `review` it plays the take in its own `<audio part="review">`.
- **A lower bitrate:** `capture.audio.audio_bitrate_bps` in the session
  options. Never `capture.camera`: there is no camera track.
- **Errors:** a missing device is `no_microphone`, never `no_camera`.
  `device.permission_granted` reports `camera: 'unknown'`.
- **On your server:** `GET /api/v1/videos/{id}/frame` answers
  `409 no_video` for the audio track. The `video.ready` webhook names
  `track: audio`, and that file is the playable one.

## Visualizers: the SDK draws nothing, the host draws

**Never call getUserMedia again: a second capture can mute the first on iOS. Everything below hangs off the SDK's one capture.**

```html
<!-- 1. A mic ring in plain CSS: it inherits --fitt-level (0 to 1) from the recorder. -->
<fitt-recorder controls="full"><span slot="level" class="mic-ring"></span></fitt-recorder>
<style>
  .mic-ring { display: block; width: 56px; height: 56px; border-radius: 50%; border: 2px solid #5fd39a;
    transform: scale(calc(1 + var(--fitt-level, 0) * 0.5)); transition: transform 100ms linear; }
  fitt-recorder[data-speaking] .mic-ring { border-color: #e93544; }
</style>
```

```tsx
// 2. The ElevenLabs UI Orb: the two functions are closures, safe to pass unbound.
// volumeMode must be 'manual': in the default 'auto' the Orb ignores the getters.
<Orb volumeMode="manual" getInputVolume={session.audio.getInputVolume} getOutputVolume={session.audio.getOutputVolume} />
```

```js
// 3. Bars from onFrame: 8 bands, 0 to 1, from 100 Hz to 8 kHz. The array is reused: copy it to keep it.
const bars = [...document.querySelectorAll('.bar')];
const stop = session.audio.onFrame(({ bands }) => {
  bands.forEach((value, i) => { bars[i].style.height = `${Math.max(2, value * 48)}px`; });
});
// stop() when the visual goes away.
```

```tsx
// 4. ElevenLabs UI BarVisualizer (or useMultibandVolume): give it the SDK's microphone stream.
const [stream, setStream] = useState(session.audio.stream);
useEffect(() => session.audio.onChange(() => setStream(session.audio.stream)), [session]);
return <BarVisualizer mediaStream={stream} />;
```

5. **LiveWaveform must not be used as is**: it calls `getUserMedia` itself
   when `active` and takes no stream (research note
   `docs/superpowers/research/2026-11-17-elevenlabs-ui-hooks.txt` in the
   Fitt Video repo). Draw a waveform from `onFrame` or from
   `session.audio.createAnalyser()` instead.

In the Orb, `manualInput` and `inputVolumeRef` win over `getInputVolume`
in manual mode, so do not pass them beside the getters.

**The frame's scales.** `level` is on the meter's curve (0 to 1, the same
curve as `--fitt-level` and `getInputVolume()`). `peak` is the raw largest
absolute sample of the last analyser window (0 to 1, not on the level
curve), so a host that draws both sees `peak` below `level` for quiet
speech.

**The hooks.**

| Hook | What it is |
|---|---|
| `--fitt-level` | A CSS custom property on the element, 0 to 1, updated at 10 Hz in `ready`, `countdown` and `recording`; 0 otherwise. Slotted children inherit it |
| `data-speaking` | On the element while the level is 0.2 or more; off after it stays under 0.1 for 300 ms |
| `level` slot | A host visual: centred in the strip in audio only, over the view's bottom left corner in a video session |
| `session.audio.getInputVolume()` | The microphone now, 0 to 1. A closure |
| `session.audio.getOutputVolume()` | The interviewer side of the D20 mix now, 0 to 1; 0 without a mix. A closure |
| `session.audio.onFrame(cb)` | `{level, peak, bands}` on every animation frame while a listener is attached; returns the unsubscribe |
| `session.audio.stream` | The SDK's microphone-only `MediaStream` (no video track) |
| `session.audio.createAnalyser({fftSize, smoothingTimeConstant})` | A host `AnalyserNode` on the SDK's own context, fed from the microphone |
| `session.audio.context` | The SDK's `AudioContext` |
| `session.audio.onChange(cb)` | Fires after every acquire and release: ask again for `stream` or an analyser |

**The life of the hooks.**

- Null and 0 before `prepare()`, after `stop()` and after `reset()`
  (capture is released at stop).
- 0 before the first click or key press on the page: the browser keeps the
  audio context suspended until a gesture.
- `onFrame` runs only while a listener is attached, and stops while the tab
  is hidden; it starts again when the tab is visible.
- `stream` survives a device switch, not a prepare: listen to `onChange`.
- `getOutputVolume()` is 0 without a conversation mix.
- It all works in video sessions too, and in `ready` before recording.

## Conversation: `mixAudio()`

For the `conversation` recipe, pass the interviewer's audio
(`MediaStreamTrack`, `MediaStream`, `AudioNode` or `HTMLMediaElement`) to
`session.mixAudio(source, { role: 'interviewer' })` after `prepare()`.
The camera track (or the audio track, in an audio-only conversation) then
records the candidate on the left channel and the interviewer on the right. Call it again after every `reset()`, because the
SDK builds a new audio graph with each capture. **Recommend headphones to
the candidate:** interviewer audio played through speakers echoes into the
microphone, and browser echo cancellation is not reliable outside
Chromium.

## Transcripts: `uploadTranscript()`

`session.uploadTranscript({timing, offset_ms?, language?, segments})`
sends a transcript the host already has (`timing` is `exact`,
`approximate` or `none`; each segment has `text` and optional `start_ms`,
`end_ms`, `speaker`, `role`). The browser sends it with its upload token;
the host's server can send the same body to
`POST /api/v1/sessions/{id}/transcript` with its API key. Both answer
`201` with the `GET /transcript` body.

- It is accepted while the session is `open`, `finalising`, `processing`,
  `ready` or `failed`. A discarded session answers `409 discarded`; an
  abandoned or expired one answers `409 session_closed`.
- At most 100,000 segments (`422 validation_failed` over that). A text over
  the 2,000,000-character ceiling answers `413 payload_too_large`.
- Each upload replaces the take's previous uploaded transcript. When the
  upload is the take's primary transcript, the text options (translate,
  summarise, and meaningful when checks are off) are queued again. On a
  session that asked for `transcribe` (an `answer` session does by
  default), the platform's own transcript stays primary, and the upload is
  readable at `GET /transcript?source=uploaded`.
- Read results on your server with the API key:
  `GET /sessions/{id}/transcript`, `/summary`, `/analyses`. A result still
  being made, or still owed while the session processes, answers
  `409 not_ready`; a `404` is final only once the session has closed.
- Ask for an option later with `POST /sessions/{id}/analyses
  {type, take?}` (API key): `202`. It answers `409 not_ready` while the
  take's checks or source track are not done, and `409 rerun_limit` after a
  failed analysis was run again 3 times. A skip by a gate (for example
  `audio_incomplete` or `over_cap`) is final.

## Errors and what to show

`state.error` is `{code, detail?}` or null. Only the codes marked "phase
error" stop recording; the others leave the phase alone. Match on `code`,
never on a message.

| Code | Phase error | What it means | What the host shows or does |
|---|---|---|---|
| `permission_denied` | yes | Camera or microphone permission refused or revoked | How to allow the camera and microphone in this browser, then `prepare()` again |
| `device_busy` | yes | Another app holds the camera | Close other apps that use the camera |
| `no_camera` | yes | No camera found (never in an audio-only session) | Connect a camera |
| `no_microphone` | yes | No microphone found | Connect a microphone |
| `recorder_unsupported` | yes | This browser cannot record | Ask for a current Chrome, Edge, Firefox or Safari |
| `config_invalid` | yes | The descriptor could not be read | A bug in the host: log it |
| `device_disconnected` | no | A device was unplugged; recording resumes when it comes back | "Reconnect your camera" |
| `recorder_error` | no | The recorder failed; a new run was started | Nothing unless it stays set |
| `token_expired` | no | Uploads are paused: the token lapsed | Re-mint from your server, `FittVideo.session(newDescriptor)` |
| `token_refresh_blocked` | no | The token cannot be refreshed (a network that blocks preflights) | Re-mint from your server before it lapses, `FittVideo.session(newDescriptor)` |
| `session_cap_reached` | no | The take was stopped before the session's length cap | "You reached the time limit" |
| `network_blocked` | no | Nothing reaches the platform from this page: the origin is not allowed, or the network blocks it. Segments stay queued | Check the space's allowed origins; ask the candidate to try another network |
| `manifests_blocked` | no | `stop()` resolved, but the end of the take cannot be posted (a network that blocks preflights); it keeps retrying | Let the candidate go on; without the manifests the server's idle close ends the session |
| `manifest_rejected` | no | The server refused a manifest for good; the track waits for the idle close | Log it |
| `events_rejected` | no | The server refused an event batch for good | Log it |
| `stale_take` | no | The server is on a newer take (another tab or a reset); capture stopped | Reload the session state |

Rejected promises carry a `FittVideoError` whose `code` is one of the
above or `too_short`, `countdown_cancelled`, `invalid_state`,
`playback_not_enabled` or `track_failed`.

- **On a network that blocks preflights**, segments still go through the
  preflight-free signed POST, but refresh, manifests, events and finalise
  cannot. `stop()` resolves with `state.error` `manifests_blocked`, the
  manifests keep retrying, and without them the server's idle close ends
  the session about a minute after the token lapses. On
  `token_refresh_blocked` or `token_expired`, re-mint from your own server
  (`POST /sessions/{id}/upload-token`) and call
  `FittVideo.session(descriptor)`.

## Deployment notes

- **Iframes:** a recorder inside an iframe needs
  `allow="camera; microphone; fullscreen"` on the iframe, and the page
  must be served over HTTPS.
- **The space's allowed origins** must list the page's origin
  (scheme, host and port), or every upload is refused and the page ends in
  `network_blocked`.
- **The API path must reach Fitt Video unchanged.** The signed POST signs
  the path the browser sees, so a proxy that strips a path prefix makes
  every POST answer `401 unauthenticated`, which the SDK treats as final.
- **One tab records a session.** A second tab with the same session
  records nothing and passes its descriptor to the first; it takes over
  when the first closes.
- **Firefox** cannot finish `prepare()` in a tab that is not the front tab.
- **Direct uploads (SDK 1.2.0).** When the Fitt Video deployment uploads
  straight to the bucket, the SDK PUTs segments to the media host
  (`cloudfront`, for example `media.video.fitt.ai`) or to the bucket's host
  (`s3`, `oss`), then confirms them with the API. A host page with a
  Content Security Policy adds that host to `connect-src`, beside the Fitt
  Video API host. Corporate network allowlists need the media host too. If
  the bucket is blocked, the SDK steps down to the API on its own, and the
  `upload.transport_fallback` event may now report `from: 'direct'`
  (`{from, to, reason}`). Nothing else changes for a host: the descriptor
  carries everything.

## Never

- Send the API key to the page.
- Depend on an error's message text: match `code`.
- Mirror the recording: only the preview is mirrored.
- Play a take back from your own local blobs or `session.stream`
  recordings: MediaRecorder output has no duration header and seeks badly.
  Use `session.playback(video)` (or an `<audio>` in an audio-only
  session), which builds a seekable copy, or the URL
  from `waitForReady()` or from `GET /api/v1/videos/{id}/playback` on your
  server, or after the `video.ready` webhook.
- Treat the page's verdict as final: the webhook decides.
- Call `getUserMedia` for a visualizer: use `session.audio` or
  `--fitt-level`.
