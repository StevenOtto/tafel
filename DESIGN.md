# Tafel — Design Document

Status: living document. Started 2026-08-18; the prototype pipeline was
removed 2026-08-26 (see §1). What is being built next lives in `specs/`.

## 1. Historie

Tafel started (2026-08-18) as a desk-driven UI prototyping instrument: an
overhead camera watched a paper sketch, a settle detector fired when the desk
went still after a change, a Gemini vision call turned the sketch into edit
operations on a canonical UI tree rendered on a second display, and a green
token on the desk "promoted" the result through Google Stitch with a design
system applied — all metered against a per-session cost ceiling, with keys in
the macOS Keychain and hostile markup sandboxed. The same day the project
pivoted to _agent input_ (§3) behind a mode switch.

On 2026-08-26 the prototype pipeline was removed entirely: no Google
dependency, no credentials, no outbound network. Its design (shell choice,
frame pipeline, fast/promote paths, markup isolation, cost ledger, Stitch tool
enumeration, model identifier record) is preserved in the git history of this
file up to commit `9d3d881` and is not summarised further here.

Two decisions from that era still stand:

- **Shell: Tauri 2.** A Rust core owns everything that touches the OS or the
  network; the webview (TypeScript/React) talks to it over named commands.
  `tauri bundle` produces a signed double-clickable `.app`.
- **Acquisition in the webview.** The camera is opened with `getUserMedia`;
  analysis runs on small downscaled frames in TypeScript, behind a
  `FrameSource` seam so recorded fixtures drive the exact same code as the
  live camera.

## 2. Hand gestures (Apple Vision) — built 2026-08-26

The settle detector (fire when the desk goes still) is gone; the user now
says when. Every camera frame goes through three deterministic stages, and
only the first needs the machine:

1. **Landmarks.** The webview samples the video at ~10 fps, downscales to
   640 px, and hands the JPEG to the Rust command `detect_hands`. Rust calls
   a 60-line Swift bridge (`src-tauri/swift/TafelVision`, linked through
   `swift-rs` from `build.rs`) that runs `VNDetectHumanHandPoseRequest` and
   returns up to two hands × 21 joints as JSON, y flipped to image
   convention. On-device, offline, ~20–40 ms on Apple silicon. On Linux and
   Windows the same command runs a Rust port of MediaPipe's hand landmarker
   (`src-tauri/src/vision/landmarker.rs`) over Google's two hand models,
   converted to ONNX and run through rten: palm detection on the
   letterboxed frame, a rotated crop around each palm, 21 joints from the
   crop. Same joint names and coordinates, so stages 2 and 3 are shared;
   MediaPipe scores the hand rather than each joint, so every joint carries
   the hand-presence score. MediaPipe's own runtime is not used because it
   reports usage to Google (`specs/2026-10-17-linux-and-windows.md`).
2. **Gesture.** `src/core/hand.ts` classifies a hand from joint geometry
   only — every rule is a ratio against the palm length, so it is
   distance-invariant: `thumbs-up`, `open-palm`, `peace-sign` (index and
   middle spread in a V), `ok-sign`, `pointing`, else `none`; two thumbs-up
   hands make `two-thumbs-up`. A fist is `none` on purpose, since a pen grip
   looks the same. Unclear evidence yields `none` rather than a guess.
3. **Hold.** `src/core/hold.ts` is a state machine with no clock of its own:
   idle → holding → fired. The hold completes after `holdMs` (setting,
   default 2000) of the same gesture; a release cancels; a dropout ≤ 250 ms
   is bridged but can never itself fire; after firing the gesture must be
   gone ≥ 500 ms before it can fire again. `src/core/actions.ts` maps the
   fired gesture to an action given the camera's state — an open hand pauses,
   and paused cameras only hear the peace sign that resumes them.

**Feedback.** An SVG ring in the video's content box, centred on the
gesturing hand(s), fills linearly and turns green on fire; a label names the
gesture and the remaining time; the status line (`role="status"`,
`aria-live`) announces every fired action; a two-note tone plays on fire
(setting). Mirroring flips only the view — coordinates are mirrored in the
overlay so text stays readable and detection is untouched.

**Fixtures.** Stages 2 and 3 are pure functions over landmark sequences, so
the instrument panel's Record button captures `{t, hands}` per frame as JSONL
and `src/core/gesture.recorded.test.ts` replays recordings without a camera
or Vision. Synthetic landmark sets cover the classifier in
`src/core/hand.test.ts` until recordings exist.

**Multiple cameras.** Each camera is an independent `CameraTile` — its own
stream, detection loop, hold tracker, and ring — so a hold on one never
touches another. The parent orchestrates: it owns the ordered camera set
(persisted in settings, with a per-camera name and mirror flag), the
collection, and an `ActionGate`. Because overlapping cameras can complete the
same gesture at once, the gate dedupes: the first fire wins, a second camera
firing the same gesture within a second is suppressed ("already sent"), and a
camera that just fired rests for a second. `two-thumbs-up` fans out — one
snapshot per watching camera, in set order, naming any paused or disconnected
cameras it skipped. Devices hot-plug via `devicechange`: a dropped camera
shows `Disconnected` and reconnects on its own; the others keep running.

**On-device OCR — removed 2026-09-14.** Snapshots carried Vision-recognised
text for a while (`specs/2026-08-26-vervolg-ocr-on-device.md`). The host
model reads the image itself and handles handwriting far better, and the
recognised lines mostly cluttered the card and the agent's result, so the
pipeline was taken out again (`specs/2026-09-14-ocr-verwijderen.md`). Stored
deliveries from that period still carry a `text` field; it is ignored.

**Per-camera rotation & crop.** Each camera carries a clockwise rotation
(0/90/180/270) and a crop rectangle (frame fractions, min 25% a side),
persisted in its set entry. The frame is rotated once into the tile's display
canvas, so display, detection, the ring, and the snapshot all share one
upright space; the crop bounds only the snapshot (detection still runs on the
whole frame, so a hand outside the crop still triggers). The crop is set by
dragging corner handles on the live view or by numeric fields, and a cropped
snapshot is flagged so the delivery card notes it. See
`specs/2026-08-26-vervolg-camera-rotatie-crop.md`.

**Pointing gesture (attention point).** A `pointing` hold (index out, thumb
tucked — kept clear of thumbs-up and ok) marks a point on that camera: a
marker with a 60 s countdown appears on the tile, and the next snapshot from
that camera carries `focus: {x, y}` plus an extra crop image around the point,
after which the marker clears. Nothing is sent if no snapshot consumes it. The
delivery card draws the marker on the image and shows the crop. See
`specs/2026-08-26-vervolg-wijsgebaar-aandachtspunt.md`.

**Network cameras.** A camera can be a URL (MJPEG stream or snapshot endpoint)
instead of a local device — the route for a tablet or second phone. Frames are
fetched by the Rust core (`netcam.rs`), never the webview, and only from a
loopback / private / link-local / `.local` host; every other host is refused,
so this — the app's only outbound path — can never reach the public internet.
Redirects are refused too: reqwest would otherwise follow them without the
host check. See `specs/2026-08-26-vervolg-netwerkstream-camerabron.md`.

**Persistent readers (2026-09-23).** The first version fetched one frame per
request; an MJPEG stream never ends, so that read timed out and MJPEG never
worked. Now `netcam::Registry` runs one tokio reader per URL, started on the
first request: it holds the stream open, cuts frames out of the chunked body
(`JpegExtractor`, capped at 8 MB), and keeps only the newest with a sequence
number. A non-multipart answer falls back to polling the snapshot endpoint.
No frame for 4 s, or a closed stream, marks the camera unreachable; the
reader retries every 5 s and stops once no tile has asked for 10 s. The
webview polls `latest_network_frame` every 50 ms, a memory read that leaves
out the image when the tile already has that `seq`, so frame rate no longer
depends on round-trip time. The frame is drawn to the same canvas pipeline as
a local camera, so gestures, rotation, crop, and snapshots work identically.
Android phones join this way, or as a USB webcam (UVC) on Android 14+; see
`specs/2026-09-22-android-als-camera.md`.

## 3. Agent-input mode (MCP App) — designed 2026-08-18

Tafel is a general visual input device for agents — Wispr Flow for drawings
instead of voice.

**Interaction model.** MCP is pull-based: a server cannot start a turn in
Claude. The bridge is a blocking tool — `wait_for_delivery` doesn't return
until the user's next delivery, so "I'll sketch it, hold on" becomes: Claude
calls `wait_for_delivery`, the user draws and gives a thumbs-up, and the
snapshot arrives as the tool result.
Within a turn this feels like push.

**Architecture.** The webview reports into a `SketchBus` (Rust): the full
frame on every thumbs-up, plus a ~0.5 fps frame per camera for on-demand
looks (kept per camera, retired when the camera leaves the set). (The original fixed sketch/instruction-zone split was dropped on
2026-08-26: a wall camera has no margin, and the agent reads the whole frame
anyway.) An MCP server (rmcp, Streamable HTTP, bound to 127.0.0.1,
port in settings, default 41625) serves the bus to any MCP client. The server
talks only to the bus — never to settings or the filesystem; the bus in turn
writes every delivery through to the session store (below) and serves the
current session from an in-memory copy.

**Deliveries.** The unit of input is a _delivery_: one or more snapshots,
from one or more cameras, sent by one gesture (thumbs-up = single,
two-thumbs-up = all cameras, ok-sign = open/close a collection accumulated
between the two ok-signs; max 8, expires after 10 min idle). A snapshot
prefers the freshest hand-free frame (≤ 3 s) so the drawing is not covered by
the user's own hand, and carries its camera name, timestamp, and that
hand-free flag. The webview composes the whole delivery (it knows the cameras
and the collection state); the bus only stores, sequences, and serves.

**Tools.** `get_desk` (one current frame per camera, named, stale ones
flagged), `get_latest_delivery`,
`wait_for_delivery` (long-poll; returns early with a "nothing yet" result at
the client-timeout horizon so clients that cap tool-call duration simply call
again), `list_deliveries` and `get_delivery(seq)` (the current session's
history), and `start_session(name)` — the one tool that writes. Image
content blocks carry the JPEGs; `structuredContent` carries per-image camera,
age, and hand-free metadata, and a new delivery emits
`notifications/resources/list_changed` so app-capable hosts refresh the card.

**Sessions.** Deliveries persist in sessions — named, durable sets of work —
under `<app data>/sessions/<id>/` (a `session.json`, a JSON sidecar per
delivery, a JPEG per snapshot; `index.json` names the current one). At most
one session is current and every delivery lands in it; the first delivery
opens a provisional one, so there is no mode to forget. `start_session`
resolves three ways: a provisional current session takes the name and keeps
its deliveries (adoption); a known name reopens that session, folding in any
provisional work; otherwise a new named session opens. A provisional session
expires after 4 h without a delivery; named ones never do. Sequence numbers
are global across sessions and restarts so `wait_for_delivery(after_seq)`
keeps its meaning. Only the app can switch, rename or delete (with
confirmation; files are removed). Folders without a `session.json` — the
removed prototype pipeline left some — are ignored. See
`specs/2026-09-14-sessies.md`.

**MCP App.** Every tool links one UI resource, `ui://tafel/delivery.html`
(mimeType `text/html;profile=mcp-app`, extension `io.modelcontextprotocol/ui`,
spec 2026-01-26), with the ext-apps SDK vendored as an IIFE inside the single
HTML file so hosts that render apps show the sketch inline. Claude Desktop
connects through `mcp-remote` (stdio bridge) because localhost custom
connectors are not supported; verified live 2026-08-18. Claude Desktop cancels
tool calls around the four-minute mark and progress notifications do not
extend that, so a single wait is clamped to 5–180 s.

**Trust model.** The endpoint has no authentication: any local process can
read desk images while the app runs. Pausing stops serving fresh frames.

**Transparency (2026-09-15).** Following Apple's generative-AI guideline
("communicate where your app uses AI", "acknowledge when actions take
effect"), every agent read of camera material is broadcast by the bus as an
`AgentRead` and shown in the window's _Agent_ section; a `get_desk` — the one
read no gesture precedes — is also announced in the status line. Session
changes carry their source (`SessionChange::App` or `::Agent { outcome,
name }`), so the window says out loud when the agent named, reopened or
started a session and stays quiet about its own. The MCP server still only
talks to the bus. See `specs/2026-09-15-hig-generatieve-ai-agent-transparantie.md`.
