# Tafel

Desk-driven visual input for agents — Wispr Flow for drawings. One or more
cameras watch your desk and wall; you control each with hand gestures, and the
snapshots you ask for are served to Claude over MCP, with an MCP App card
rendering them inside the conversation.

Hand detection runs on the machine: Apple Vision on macOS, and Google's
MediaPipe hand models run in Rust on Linux and Windows (the models only, not
MediaPipe's runtime, which reports usage to Google). There are no API keys,
and the only network listener is a local MCP endpoint on `127.0.0.1`. The one
outbound path is fetching frames from a network camera you add, and only ever
to a host on your local network (loopback, private, or `.local`) — enforced
in Rust; the app never reaches the public internet.

Runs on macOS 12+. Linux and Windows builds are a preview, and the Windows
installer is not signed yet; see `specs/2026-10-17-linux-and-windows.md` for
what has been verified.

See `DESIGN.md` for the architecture and `specs/` for the dated specs behind
each change (on-device OCR was added in August and removed again in
September: the agent reads the image itself, and better).

## Gestures

Hold a gesture for 2 seconds (adjustable 1–4 s). A ring around your hand
fills while you hold; let go before it completes and nothing happens. A short
tone confirms a fired gesture (can be switched off). To work without gestures,
switch **Gesture recognition** off in Settings: cameras keep watching and
the agent still sees the desk, but no hand fires anything. Below that switch,
each camera gesture can be turned off on its own. A fist does nothing,
because a hand holding a pen looks like one. The rows in the gesture guide always work as buttons, and say
when their camera gesture is off.

| Gesture          | Action                                                   |
| ---------------- | -------------------------------------------------------- |
| 👍 Thumbs up     | Send a snapshot of this camera to the agent              |
| 🙌 Two thumbs up | Send a snapshot of every watching camera                 |
| ✋ Open hand     | Pause this camera — nothing is served until resumed      |
| ✌️ Peace sign    | Resume (the only gesture a paused camera listens to)     |
| 👌 Ok sign       | Start a collection; a second ok sign finishes & sends it |

Each gesture acts on the camera that sees it. When two cameras see the same
gesture within a second only the first acts; the second ring says "already
sent". After firing, a camera rests for a second before it can fire again.
Every row in the **Gestures** guide is also a button: a click does what the
gesture would do, on the first watching camera (pause and resume act on all).

## Cameras

Add cameras from the **Add camera** menu: your built-in camera, a USB camera,
or an iPhone via Continuity Camera. Each camera is a tile in the overview with
its own name, status, and gesture ring; rename, pause, mirror, or remove it
from the tile. The set (names, order, mirroring) is remembered across
restarts. Performance is smooth up to four cameras; beyond that the app says
so and does not guarantee it.

Cameras hot-plug: a newly connected device appears in the menu without a
restart, and a camera that drops shows `Disconnected` while the others keep
running — it reconnects on its own within a few seconds when it returns.

**Network cameras.** Add a phone or IP camera by URL (an MJPEG stream or a
snapshot endpoint) under **Developer → Network camera** in the side panel.
For a tablet or a second phone, run any IP-camera app and paste its URL.
Only local-network URLs are accepted (loopback, private ranges, or
`.local`); anything else is refused. The Rust core holds one connection per
camera: an MJPEG stream stays open and only the newest frame is kept, a
snapshot endpoint is polled. The host is checked before every connection,
redirects are refused, a dropped camera shows `Disconnected` within about
5 s and reconnects on its own, and credentials in the URL are never shown.

**Android phones.** Two routes. Over Wi-Fi, run an IP-camera app at 1080p
and paste its MJPEG URL (for example `http://192.168.1.23:8080/video`).
Reserve the phone's address in your router: Android advertises no `.local`
name, so the URL breaks when the address changes. Over USB, Android 14 or
later on some phones (Pixel among them) can act as a standard USB webcam:
choose **Webcam** in the phone's USB notification and it appears under
**Add camera** like any USB camera. Use a USB 2 cable; Android's
documentation reports that webcam mode fails over USB 3 cables on a Mac.
On macOS 15 and later, allow Tafel under System Settings → Privacy &
Security → Local Network if a network camera stays `Disconnected`. See `specs/2026-09-22-android-als-camera.md`.

**Continuity Camera.** A nearby iPhone appears automatically when eligible.
Wirelessly it must be locked, still, and in landscape, on the same Apple ID
and Wi-Fi/Bluetooth as the Mac; over USB those conditions do not apply. An
iPad is not supported as a Continuity Camera; add a tablet or a second phone
as a network camera instead.

## Running

- Dev: `npm install && npm run tauri dev` (Rust toolchain required). On
  Linux, install the WebKitGTK development packages first (on Debian and
  Ubuntu: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`); cameras also
  need GStreamer's `gstreamer1.0-plugins-good`.
- Build the app bundle: `npm run tauri build` → artifact at
  `src-tauri/target/release/bundle/macos/Tafel.app` (plus a `.dmg`). On
  Linux it builds a `.deb` and an AppImage, on Windows an NSIS installer;
  neither is signed yet.
- Tests: `npm test` (TypeScript) and `cargo test` in `src-tauri/` (Rust).
  Both pass on a machine with no camera. The Rust build compiles the Swift
  bridge in `src-tauri/swift/TafelVision` (Xcode command line tools
  required); the first build fetches `swift-rs` through SwiftPM. With
  Xcode 27, release builds also need `rustup component add llvm-tools`:
  `src-tauri/build.rs` uses its `llvm-objcopy` to re-export swift-rs helpers
  that Swift 6.4 hides in release static libraries.
- Signed and notarized release: needs a **Developer ID Application**
  certificate in the keychain and an app-specific password stored with
  `security add-generic-password -a <apple-id> -s tafel-notarize -w`. Then:

  ```sh
  APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" \
  APPLE_ID=<apple-id> \
  APPLE_PASSWORD="$(security find-generic-password -s tafel-notarize -a <apple-id> -w)" \
  APPLE_TEAM_ID=<TEAMID> npm run tauri build
  ```

  Store the password from Terminal itself (the prompt needs a real terminal).
  If the DMG step fails, rerun with `-- --bundles dmg`. Notarize the DMG
  too: `xcrun notarytool submit <dmg> --apple-id … --team-id … --password …
--wait`, then `xcrun stapler staple <dmg>`.

  The build signs with the hardened runtime and `src-tauri/Entitlements.plist`
  (camera access), then notarizes and staples the app. Check with
  `spctl -a -vvv -t exec` on the app and `xcrun stapler validate` on app and DMG.

- Releases: pushing a tag such as `v0.3.0` runs
  `.github/workflows/release.yml`. It checks the tag matches the version in
  `src-tauri/tauri.conf.json`, then builds on macOS, Windows and Linux
  runners: the signed and notarized `Tafel.dmg`, an unsigned
  `Tafel-Setup.exe`, and `Tafel.AppImage` and `Tafel.deb` (built on Ubuntu
  22.04 for older distributions). Once all three succeed it publishes one
  GitHub release with those files and `SHA256SUMS.txt`, under the stable
  names the website links to. Pull requests that change the workflow or the
  Linux and Windows bundle settings, and manual runs, build the Windows and
  Linux packages as workflow artifacts without publishing. Bump the version
  first, then tag: `git tag v0.3.0 && git push origin v0.3.0`. The workflow
  needs these repository secrets, all for the macOS build:

  | Secret                       | Value                                                              |
  | ---------------------------- | ------------------------------------------------------------------ |
  | `APPLE_CERTIFICATE`          | `base64 -i DeveloperID.p12`, the exported Developer ID certificate |
  | `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12`                      |
  | `KEYCHAIN_PASSWORD`          | Any random string, for the runner's temporary keychain             |
  | `APPLE_ID`                   | The Apple ID used for notarization                                 |
  | `APPLE_PASSWORD`             | Its app-specific password                                          |
  | `APPLE_TEAM_ID`              | The team ID, for example from the certificate name                 |

  Export the certificate from Keychain Access: My Certificates → the
  "Developer ID Application" entry → Export, as `.p12`.

- Website: `site/` is the static landing page, with no build step. Preview
  it with `python3 -m http.server --directory site` and open
  `http://localhost:8000`. `.github/workflows/pages.yml` deploys it to
  GitHub Pages on every push to `main` that touches `site/`. The
  download button links to `releases/latest/download/` plus the file name for
  the visitor's system (macOS by default), and the install steps link every
  file. Merge site changes that link new files only together with a release
  that contains them. Files in
  `site/examples/` are agent-made example pages and media, kept as they
  were made.

### Connecting an agent

Snapshots you trigger with a thumbs up feed a local MCP server (Streamable HTTP, `127.0.0.1` only,
port in settings, default `41625`; shown under **Developer → Agent connection**). The server can read only camera
material — never settings or the filesystem. Note the trust model: the
endpoint has no authentication, so any process on this machine can read the
desk images while the app runs; pause watching to stop serving fresh frames.

The **Agent** section of the side panel shows what a connected agent has read:
when it last looked at the desk and which delivery it last read, with the age
ticking live. A look at the live desk (`get_desk`, the one read no gesture
precedes) is also said in the status line, as is the agent naming a session
("The agent named this session 'Kiosk'"). The same section states the deal
in three sentences: while a camera is watching, a connected agent can look at
your desk at any time and receives what you send; Pause stops both; sent
snapshots stay on this computer until you delete them.

It also shows whether an agent is **listening** (a `wait_for_delivery` call is
open) and what happened to the latest prompt: saved locally, delivered to the
agent, or — when the agent acknowledges it — working, needs input, or
completed. Pausing every camera ends any open wait at once with a "paused"
result, so the card and the agent stop listening; pausing one camera only
removes that camera from the live desk. Resuming does not restart an agent
whose turn has ended: ask it to listen again. **Copy visual-prompting
instructions** copies the session contract to paste into a chat.

Connect the Claude desktop app (Settings → Developer → Edit Config), then
restart Claude:

```json
{
  "mcpServers": {
    "tafel": {
      "command": "npx",
      "args": ["mcp-remote", "http://127.0.0.1:41625/mcp", "--allow-http"]
    }
  }
}
```

Tools: `get_desk` (one current photo per camera, each named), `get_latest_delivery` (most recent
delivery), `wait_for_delivery` (blocks until your next delivery — say "I'll
sketch it" to Claude, draw, thumbs up, and the snapshot lands in the
conversation; Claude hosts cancel tool calls around four minutes, so the wait
caps at 180 s and asks to be called again), `list_deliveries` and
`get_delivery` (revisit earlier deliveries in the current session),
`start_session` (names the session, see below), `get_tafel_status` (capture
state, open waits, and the cursor for a first wait) and `acknowledge_delivery`
(the agent reports working / needs-input / completed for one delivery, shown
on the card and in the app). `start_session` and `acknowledge_delivery` are
the only tools that write, and neither touches images.
A delivery is one or more snapshots: thumbs up sends one, two thumbs all
cameras, an ok-sign starts/finishes a collection. Results render as an MCP
App card (`ui://tafel/delivery.html`) inside Claude, showing every image sent
with its capture time; click an image to enlarge it. The card says "Delivered
to agent" on receipt and only says "Working on your prompt" once the agent has
acknowledged it.

**Visual prompting.** The server instructions teach the agent to treat a
delivery as a prompt — combine handwriting, arrows, layout and the
conversation, act instead of describing, keep reference material (a
photographed book or screen) as context. Hosts that support MCP prompts offer
**Start visual prompting** (`start_visual_prompting`) to begin a continuous
session. The same workflow is packaged as a portable agent skill in
`skills/tafel-visual-prompting/`; its `references/workflow.md` is the single
source embedded in the server instructions, the prompt and the app's copy
button.

### Sessions

Deliveries are stored on disk in **sessions** — named sets of work that
survive a restart — under the app data directory
(`~/Library/Application Support/nl.steven.tafel/sessions/`, one folder per
session with a JPEG per snapshot and a JSON sidecar per delivery). There is
always at most one _current_ session and every delivery lands in it. You never
have to open one: the first delivery opens an unnamed session, and the agent
names it when the conversation has a topic by calling `start_session("Kiosk
redesign")`. An unnamed session takes the name and keeps what you already
sent; a name used before reopens that session (folding in anything you
sketched since); otherwise a new session starts. An unnamed session that sees
no delivery for four hours is over — the next delivery starts a fresh one. A
named session stays current until you switch.

Switch, name/rename and delete sessions from the **Session** menu above the
delivery history in the app; deleting asks first and really removes the files.
Open a delivery to see it large with its camera names, or to **Remove** it
from the session (files included). Removing or deleting takes the files off
this computer; anything the agent already received stays in that conversation, and
the confirmation says so.
The agent can only start and name sessions. The panel shows where sessions are
stored and how much space they take. Nothing is pruned automatically. Note the
change in privacy posture: desk photos now persist on disk until you delete
their session.

## Tests

- `src/core/hand.test.ts` classifies synthetic landmark sets for each gesture
  and a neutral hand; `src/core/hold.test.ts` proves the 2 s hold fires once,
  a release at 1.9 s fires nothing, a ≤ 2-frame dropout is bridged, and
  re-arming needs 500 ms of absence; `src/core/actions.test.ts` covers the
  gesture → action table incl. the paused state.
- `src/core/gesture.recorded.test.ts` replays every recording under
  `fixtures/gestures/` (see below) through the same classifier and tracker.
- `src-tauri/src/vision.rs` runs the platform's hand detector (Apple Vision
  on macOS, the Rust MediaPipe port elsewhere) on a blank image (0 hands), on
  garbage bytes (clean error) and — when you drop a photo at
  `src-tauri/fixtures/hand.jpg` — on a real hand (≥ 1 hand, 21 joints).
  `src-tauri/src/vision/landmarker.rs` covers the port's anchors, crop
  geometry, palm merging and image sampling. CI runs both suites on macOS,
  Linux and Windows, with MediaPipe's public thumbs-up photo as the hand.
- `src-tauri/src/settings.rs` proves the camera selection survives a restart
  and that a settings file from the earlier prototype-era app still loads.
- `src-tauri/src/sessions.rs` covers the session rules on a temp dir: the
  first delivery opens a session, deliveries and `seq` survive a reopen,
  naming adopts, a repeated name reopens, the four-hour expiry, delete, and
  that prototype-era folders without a `session.json` are left alone.
- `src-tauri/src/bus.rs` and `src-tauri/src/mcp_server.rs` cover the sketch
  bus and the tool results, plus a wire-level smoke test over the real HTTP
  transport.

```sh
npm test
(cd src-tauri && cargo test)
```

## Fixtures

Real gesture recordings make the tests match your hands and your light. In
the app, type a name under **Record fixture**, press **Record**, perform the
gesture (hold it, release it, do the thing you want tested), press **Stop**.
The landmark sequence lands in the app data dir under `recordings/`. Then:

```sh
mkdir -p fixtures/gestures/thumbs-up-once
cp "~/Library/Application Support/nl.steven.tafel/recordings/<file>.jsonl" \
   fixtures/gestures/thumbs-up-once/frames.jsonl
cat > fixtures/gestures/thumbs-up-once/expected.json <<'JSON'
{ "fires": [{ "gesture": "thumbs-up", "atMs": 2600, "toleranceMs": 300 }] }
JSON
npm test
```

## Security posture

- No credentials exist anywhere in the app.
- The only outbound request is a network-camera frame fetch, made by the Rust
  core and refused unless the URL's host is loopback, private (RFC 1918),
  link-local, or `.local`. Redirects are never followed, so a camera cannot
  send the app to another host. With no network camera added, the app makes
  no outbound request at all.
- The webview's CSP restricts webview connections to the IPC transport;
  network-camera frames arrive as data URLs, not webview fetches.
- The MCP server reads only the delivery bus; it binds to loopback and rmcp's
  transport rejects non-loopback hosts.

## License

The code is released under the [MIT License](LICENSE). The images, videos
and brand files in `site/` and `brand/` are licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): reuse them with
credit to Steven Otto.
