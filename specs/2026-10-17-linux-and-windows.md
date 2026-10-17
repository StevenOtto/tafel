# Linux and Windows: research for feature parity

`2026-10-17` · research, then implemented the same day · status:
implemented on Linux and Windows, Windows untested beyond CI (see "Pending
manual checks")

## Question

What does it take to run Tafel on Linux and Windows with the same features
as on macOS? The working assumption was that hand gestures are the main
challenge and that Tauri makes the rest easy.

## Short answer

Update after the research: the recommended backend (option A) turned out to
send usage metrics to Google, so the implementation uses option B, a Rust
port of MediaPipe's pipeline. See "Decisions" and "Implementation" below; the
sections up to "Verification done for this research" are the research as
written before that.

The assumption is half right. Getting hand landmarks on Linux and Windows is
solved and measured below: Google's MediaPipe hand models produce the same 21
joints as Apple Vision, and on the two photos tested the unchanged
`src/core/hand.ts` classified them correctly. The open problem is behavioral parity: the
classifier's thresholds were tuned on Vision landmarks, MediaPipe reports no
per-joint confidence, and no recorded gesture fixtures exist to compare
against. That is calibration work, and it needs real desk recordings.

The rest is mostly as easy as hoped, with one exception. The Rust core
compiles on Linux after about 15 changed lines, and all 63 non-Vision Rust
tests and all 77 frontend tests pass there. Cameras on Linux do not work as
the code stands: WebKitGTK refuses `getUserMedia` with `NotAllowedError`.
Tauri 2.12 adds a permission handler that fixes this (verified with
WebKitGTK's mock camera), but behavior with real cameras through GStreamer is
unverified. Windows uses WebView2, which is Chromium, and is the easier
platform.

## What is macOS-specific today

| Area                     | Where                                                                                                                                 | Linux / Windows                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Hand landmarks           | `src-tauri/src/vision.rs`, `swift/TafelVision`, `build.rs`                                                                            | New backend needed (below)                                                                                         |
| Build gate               | `src-tauri/src/lib.rs:1` (`compile_error!`), `swift-rs` in `Cargo.toml`, Swift linking in `build.rs`                                  | Gate on target OS; done in the experiment below                                                                    |
| Camera capture           | `src/app/cameraSource.ts` (`getUserMedia` in the webview)                                                                             | Works in WebView2; WebKitGTK needs a permission handler and GStreamer plugins                                      |
| Window chrome            | `tauri.conf.json`: `macOSPrivateApi`, `titleBarStyle: Overlay`, `transparent`, `windowEffects: sidebar`                               | `tauri.<os>.conf.json` gives Linux and Windows an opaque window with native decorations                            |
| Styling                  | `src/styles.css:1-5,53` (transparent body over vibrancy), `:77` (toolbar under the traffic lights)                                    | Opaque background and no traffic-light inset on other platforms                                                    |
| Wording                  | "this Mac" in `src/app/ControlApp.tsx:1131,1326,1445`, `README.md`, `site/`                                                           | "this computer"                                                                                                    |
| Session storage location | `app_data_dir()` in `src-tauri/src/lib.rs` (setup)                                                                                    | On Windows this is Roaming AppData; session images belong in `app_local_data_dir()` (same path on macOS and Linux) |
| Release                  | `.github/workflows/release.yml` (one macOS job, Developer ID signing, notarization, DMG); site download button `site/index.html:1401` | Per-OS jobs, packages and signing; per-OS download links                                                           |
| Not portable by nature   | Continuity Camera (`Info.plist`), vibrancy                                                                                            | Accepted gaps; Windows 11 Phone Link can expose an Android phone as a webcam; network cameras work everywhere      |

Portable as is: the MCP server on `127.0.0.1`, the delivery bus, sessions,
settings, network-camera readers and their local-network checks, the gesture
classifier, hold tracker and action gate, Web Audio tones, and IPC.

## Hand landmarks: options

All three options use MediaPipe's hand models (Apache 2.0): a palm detector
(192 x 192 input) and a landmark model (224 x 224 input, 21 joints). Their
joint order matches `JOINT_NAMES` in `src/core/hand.ts` one to one, so index
`i` maps to `JOINT_NAMES[i]`. Coordinates are frame fractions with the origin
top-left, as Tafel already expects.

**A. MediaPipe's native library through Rust FFI (recommended at first,
then rejected: see "Decisions").** MediaPipe
1.x (1.1.1, 2026-10-14) ships a C library, `libmediapipe`, with a versioned
C API (`MpHandLandmarkerCreate`, `MpHandLandmarkerDetectImage`,
`MpHandLandmarkerDetectForVideo`, symbol version `VERS_1.0`). The official
Python package is now a thin `ctypes` wrapper over it. Prebuilt binaries exist
as wheels for Linux x86_64 and aarch64, Windows x64 and arm64, and macOS
arm64 (the library inside was checked for Linux x86_64 and Windows x64). The
header is upstream at `mediapipe/tasks/c/vision/hand_landmarker/hand_landmarker.h`.
It gives the full official pipeline (detection, tracking, XNNPACK) for about
200 lines of FFI and wrapper. Costs: the prebuilt library holds every
MediaPipe task and is large (Windows DLL 62 MB; Linux `.so` 94 MB stripped,
124 MB as shipped). The Linux build links `libEGL.so.1` and `libGLESv2.so.2`
even on CPU. I found no documentation presenting this C API as a supported
desktop SDK, so its stability is an inference from the symbol versioning.
Upstream Bazel builds `libmediapipe.so` from source and already has
vision-only targets for its Apple frameworks, so a smaller vision-only build
looks possible, at the cost of a Bazel build in CI.

**B. Own two-stage pipeline in Rust over ONNX (chosen).** The `.tflite` models convert
to ONNX with `tf2onnx`; outputs match the originals to a relative difference
of 7e-6. Pure-Rust runtimes (`rten` 0.27, `tract` 0.23.9) load and run both
models with no native dependency, and their outputs match ONNX Runtime to 5
significant digits. Costs: Tafel would reimplement anchor decoding (2016
anchors), non-max suppression, the rotated hand crop, projection back to the
frame and tracking, likely 600 to 900 lines, with the risk of subtly worse
landmarks than the official pipeline. Pure Rust is also 2 to 3 times slower
than XNNPACK (table below). The `ort` crate (ONNX Runtime) is faster but is
still a release candidate (2.0.0-rc.14) and ships a native library.

**C. MediaPipe's WebAssembly build in the webview (not recommended).** It
runs under a strict CSP with only `'wasm-unsafe-eval'` added (verified, no
violations). On CPU it takes 76 to 125 ms per frame in Chromium, so one
camera at 10 fps would saturate the webview's main thread. The GPU delegate
would be needed, and WebGL on WebKitGTK is the least reliable part of the
Linux stack. It also widens the webview CSP, a boundary in `AGENTS.md`, and
moves landmark work out of Rust, against the current layering.

**macOS: keep Apple Vision (chosen).** MediaPipe ships only arm64 for
macOS, so Intel Macs would lose gestures. Vision adds nothing to the bundle,
and its behavior is the reference the classifier was tuned on. The cost is
two backends that must stay in parity, which the harness under "Next steps"
addresses.

## Measurements

Environment: this cloud container, Linux x86_64, 4 vCPU Intel Xeon at 2.1
GHz. A current laptop is likely faster per core; treat absolute numbers as an
upper bound, not a prediction. Model files: `hand_landmarker.task`, float16,
7.8 MB.

Per model, median (p50) over 100 to 200 runs on a fixed input:

| Runtime                      | Threads | Palm detector | Landmark model |
| ---------------------------- | ------- | ------------- | -------------- |
| LiteRT (XNNPACK), `.tflite`  | 1       | 9.2 ms        | 7.4 ms         |
| LiteRT (XNNPACK), `.tflite`  | 4       | 3.8 ms        | 3.0 ms         |
| ONNX Runtime 1.31, converted | 1       | 16.3 ms       | 8.4 ms         |
| rten 0.27, converted         | 1       | 28.7 ms       | 21.2 ms        |
| rten 0.27, converted         | 4       | 26.2 ms       | 15.8 ms        |
| tract 0.23.9, converted      | 1       | 32.8 ms       | 25.9 ms        |

End to end, through `libmediapipe` (HandLandmarker, two hands max):

| Input                          | Image mode | Video mode (tracking) | Webview WASM, CPU (image / video) |
| ------------------------------ | ---------- | --------------------- | --------------------------------- |
| One hand, thumbs up, 382 x 406 | 25.3 ms    | 24.5 ms               | 76.2 / 79.2 ms                    |
| Two relaxed hands, 640 x 960   | 33.1 ms    | 22.8 ms               | 124.9 / 79.7 ms                   |

For comparison, `DESIGN.md` gives Apple Vision 20 to 40 ms on Apple silicon.
At 10 fps, 25 ms per frame is 25% of one core per camera on this machine.
Video mode only saves time when both hands are tracked, because MediaPipe
reruns the palm detector while fewer than `num_hands` hands are found.

Classifier check: the landmarks from MediaPipe's own test photos, mapped to
Tafel's joint names and passed through the unmodified `classifyHand` and
`classifyGesture`, gave `thumbs-up` for the thumbs-up photo and `none` for a
photo of two relaxed, half-curled hands. Both are correct. Two images prove
the data path, not parity.

## Parity risks in the gesture path

1. **No per-joint confidence.** Vision scores each joint, and `hand.ts`
   drops joints below 0.3, so an occluded finger yields `none`. MediaPipe
   scores the hand, not the joints, and always returns all 21 joints,
   guessing the hidden ones. Mapping the hand score onto every joint keeps
   the code unchanged but removes that safety net. The likely effect is more
   false positives from pen grips and hands flattening paper.
2. **Thresholds tuned on Vision.** The finger ratios (1.15 and 0.95) and the
   palm fractions (0.6, 0.35, 0.3) came from Vision landmarks. MediaPipe
   places some joints differently (the thumb base in particular), so a
   gesture near a threshold may read differently per OS.
3. **Desk viewpoints.** Cameras look down at the backs of hands. Neither
   model's behavior from that angle is measured here.
4. **No ground truth in the repository.** `fixtures/gestures/` does not
   exist, so `src/core/gesture.recorded.test.ts` is skipped. Parity cannot be
   measured until recordings exist.
5. Chirality is not used by the classifier, so MediaPipe's handedness
   convention (it assumes a mirrored selfie image) does not matter.

## Cameras and permissions

**Linux (WebKitGTK).** Reproduced with the current code under Tauri 2.12.4 and
WebKitGTK 2.52.6: `getUserMedia` fails with `NotAllowedError`, because wry
answers WebKitGTK's `permission-request` signal only when a permission handler
is set, and unanswered requests are denied. `enable-media-stream` is already
on by default in 2.52, and the `tauri://localhost` origin is a secure
context. With Tauri 2.12's `WebviewWindowBuilder::on_permission_request`
returning `Allow` for `PermissionKind::Camera` (and `Default` for everything
else), the same build opened WebKitGTK's mock camera at 2560 x 1440 and
`enumerateDevices` listed both mock devices with labels. Requirements that
follow:

- Upgrade Tauri from 2.11.5 (current `Cargo.lock`) to 2.12.x. The handler
  exists only on the window builder, so the control window moves from
  `tauri.conf.json` to code: keep its config, set `"create": false`, and
  build it in `setup` with `WebviewWindowBuilder::from_config`.
- Real cameras need a GStreamer source in the WebKit process: `v4l2src` from
  gst-plugins-good, or the PipeWire plugin. Package dependencies must declare
  them.
- Unverified until tested on hardware: 1080p MJPEG from V4L2, several cameras
  at once, hot-plug (`devicechange`), and cameras that only one process can
  open at a time under plain V4L2.
- Fallback if WebKitGTK capture proves unreliable: capture in Rust and hand
  frames to the webview, as network cameras already do through
  `latest_network_frame`.
- Known WebKitGTK rendering issues on NVIDIA (blank or grey windows) are
  usually worked around with `WEBKIT_DISABLE_DMABUF_RENDERER=1` on X11. Not
  reproduced here.

**Windows (WebView2).** `getUserMedia` is Chromium's. Without a handler
WebView2 shows its own permission prompt; the same Tauri handler grants it
silently. The origin is `http://tauri.localhost`; `*.localhost` counts as a
secure context in Chromium (not verified on Windows). Windows also has a
system privacy switch for desktop camera access. Before the multi-app camera
option (Windows 11, March 2025 update, opt-in per camera), only one app can
hold a camera, so Tafel and a video call would conflict.

**macOS.** No change needed; whether to apply the same handler there is a
consistency choice, not a fix.

## MCP clients

Claude Desktop runs on Windows and, since mid-2026, on Linux as a beta for
Ubuntu and Debian. Claude Code runs on all three. Whether the Linux desktop
beta renders the MCP App card (`src-tauri/mcp-app/delivery.html`) is
unverified.

## Verification done for this research

All experiments ran outside the working tree, in a scratch copy of `HEAD`
(`f07df21`), so nothing in the repository changed except this file.

- Build split: gated the Swift linking in `build.rs` on
  `CARGO_CFG_TARGET_OS`, moved `swift-rs` under
  `[target.'cfg(target_os = "macos")'.dependencies]`, removed the
  `compile_error!`, and stubbed `vision::detect_hands` on other platforms.
  `cargo test` on Linux: 63 passed, 0 failed (the 3 Vision tests are
  macOS-only). `npm test`: 77 passed, 1 file skipped (no recordings).
  `npx tsc --noEmit`: clean.
- Camera probe: the scratch copy upgraded to Tauri 2.12.4, the window built in
  `setup`, WebKitGTK mock capture devices on, run under Xvfb. Results as
  above, with and without the handler.
- Models: `hand_landmarker.task` from Google's model storage, converted with
  `tf2onnx` 1.17 (opset 17), timed with LiteRT, ONNX Runtime 1.31, `rten`
  0.27.0 and `tract-onnx` 0.23.9. End-to-end runs used `mediapipe` 1.1.1
  from PyPI on MediaPipe's own test images (`thumb_up.jpg`,
  `woman_hands.jpg`); the WASM run used `@mediapipe/tasks-vision` 1.1.1 in
  headless Chromium with the strict CSP plus `'wasm-unsafe-eval'`.
- Not done: any build or run on Windows; any real camera on Linux; any
  native (non-mock) GStreamer capture; Rust FFI to `libmediapipe` (exercised
  through the official Python wrapper over the same C API instead); packaging.

## Decisions (2026-10-17)

The user accepted the recommendations: keep Apple Vision on macOS, use an
opaque window with native decorations on Linux and Windows, and ship option
A's prebuilt library first.

Option A then failed a check made before writing code. MediaPipe 1.1.1's
prebuilt library opens a connection to `play.googleapis.com:443` while it
runs (seen with `strace`: `CONNECT play.googleapis.com:443` through the
proxy), also when, as Tafel would, the caller leaves every host field and the
CA bundle empty. The package's own `NOTICE` says so: "MediaPipe Tasks APIs
send metrics about the performance and utilization of the APIs in your app to
Google." The open-source build swaps in a dummy logger, but Google publishes no
binaries of it. Shipping the prebuilt library would break Tafel's promise that
it never reaches the public internet, so the user chose option B.

## Implementation

- **Models.** `src-tauri/models/` holds the two models as ONNX with float16
  weights (2.3 MB and 5.5 MB), `convert.py` to regenerate them with pinned
  versions and a drift check against the TFLite originals, the Apache 2.0
  license, and a README with provenance. tract cannot load the `.tflite`
  files directly (an unsupported operator), so conversion is needed.
- **Pipeline.** `src-tauri/src/vision/landmarker.rs` ports MediaPipe's image
  mode: letterbox to 192 x 192 with black bars, 2016 SSD anchors, sigmoid
  scores kept from 0.5, weighted non-max suppression at IoU 0.3, the
  palm-to-hand rectangle (rotated from wrist to middle knuckle, shifted half
  a palm toward the fingers, squared, 2.6 times the palm), a bilinear rotated
  crop to 224 x 224 with corners mapped as in MediaPipe's OpenCV path, a
  presence threshold of 0.5, and landmarks projected back through the same
  rectangle. Input values run from 0 to 1, chosen by testing both ranges.
  Handedness is MediaPipe's label as is: on a photo where the true hands are
  known it named them correctly, so the mirrored-selfie caveat in
  MediaPipe's older docs does not apply. Every joint's confidence is the
  hand-presence score. The models are embedded in the binary and load once.
  `detect_hands` stays stateless: no tracking between frames.
- **Backends.** `src-tauri/src/vision.rs` keeps the shared types and tests;
  `vision/apple.rs` holds the unchanged Swift call; the target OS picks one.
  `build.rs` links Swift only for macOS targets; `swift-rs` is a macOS-only
  dependency and `rten`, `rten-tensor` and `image` are non-macOS ones. Dev
  builds optimize the inference crates and turn off their debug assertions,
  which otherwise make inference about 1.5 times slower.
- **Tauri** 2.11.5 → 2.12.4 for the crate, 2.12.4 and 2.12.3 for
  `@tauri-apps/api` and `@tauri-apps/cli`. The npm install also dropped two
  stale `pngjs` entries from the lockfile that `package.json` no longer lists.
- **Window.** `tauri.linux.conf.json` and `tauri.windows.conf.json` replace the
  window with an opaque one with native decorations and `create: false`;
  `lib.rs` builds it in `setup` with `on_permission_request` granting
  `Camera` and leaving every other request to the webview's default. macOS
  still creates its window from `tauri.conf.json`, unchanged.
- **Styling.** `src/core/platform.ts` reads the OS from the user agent,
  `main.tsx` sets `data-platform`, and `styles.css` gives Linux and Windows an
  opaque `--window` background without the traffic-light inset. macOS styles
  are unchanged.
- **Wording.** "this Mac" became "this computer" in the three UI strings and
  the README.
- **Storage.** Sessions and recordings now live under
  `app_local_data_dir()`: the same path as before on macOS and Linux, and on
  Windows it keeps images out of the roaming profile. Settings stay in
  `app_data_dir()`.
- **Packaging.** Linux `.deb` (depends on `gstreamer1.0-plugins-good`) and
  AppImage (bundles the media framework); Windows NSIS installer. Nothing is
  signed yet, and the release workflow and site still ship macOS only.
- **CI.** `.github/workflows/ci.yml` runs `npm test`, `npm run build` and
  `cargo test` on Ubuntu 24.04, Windows 2025 and macOS 15. On Linux and
  Windows it downloads MediaPipe's public thumbs-up photo (SHA-256 pinned) as
  `fixtures/hand.jpg`, so the hand test runs on a real hand.
- **Docs.** README, DESIGN.md, and AGENTS.md, which gains a boundary: do not
  use MediaPipe's runtime.
- **Site.** `site/index.html` says Windows and Linux are in testing (hero
  fine print, link-preview description, FAQ) and "your computer" where it
  said "your Mac". The download stays macOS-only until releases include
  other platforms; the site deploys only when this reaches `main`.

## Verification of the implementation (Linux, this container)

- `cargo test`: 72 passed, 0 failed: 63 existing, 6 new pipeline unit tests,
  and the 3 backend tests now running the port (the hand test on
  `thumb_up.jpg`). `cargo clippy --all-targets`: one existing warning in
  `settings.rs`, none in new code.
- `npm test`: 80 passed (77 existing, 3 new), 1 file skipped (no
  recordings). `npx tsc --noEmit` clean, `npm run build` fine, Prettier clean
  on changed files.
- Landmark accuracy against the official MediaPipe 1.1.1 library in image
  mode, mean (max) distance per joint: thumbs-up photo 5.4 px (10.3 px) on a
  palm about 100 px long; relaxed hands 2.1 px (7.9 px) and 1.6 px (3.4 px).
  The official library's own image-mode and video-mode results differ by
  5.1 px, 1.6 px and 2.1 px on the same photos, so the port is within
  MediaPipe's own variation. Handedness matches on all three hands, and
  Tafel's classifier gives `thumbs-up` and `none`, `none`, as it does on the
  official landmarks.
- Speed, release build, on this 2.1 GHz cloud CPU: 55 ms per frame with one
  hand, 84 ms with two, about 30 ms with none. Convolutions are 83% of the
  detector's time. Debug build: about 92 ms with one hand. MediaPipe's own
  runtime takes 21 to 25 ms for the same frames.
- End to end: the real app (dev build with Vite) under Xvfb, with the
  thumbs-up photo served as a local network camera. The hold fired, and the
  MCP server returned delivery #1 with trigger `thumbs-up`, camera "Desk" and
  its image. A screenshot showed the opaque window, the green ring and the
  delivery in the session strip. The run needed a temporary fix for the
  network-camera bug below, reverted afterwards.
- `npm run tauri build -- --bundles deb`: a 14.2 MB package, 35.7 MB
  installed, depending on `gstreamer1.0-plugins-good`, `libwebkit2gtk-4.1-0`
  and `libgtk-3-0`.

CI on `acb83ae` passed on all three platforms. Windows ran the 72 Rust
tests, including the hand test on the thumbs-up photo through the Rust port;
macOS ran 66, including the Apple Vision tests through the Swift bridge (the
hand photo is fetched only on Linux and Windows). The first Windows run failed
to link `build.rs`: MSVC requires `swift-rs`'s Swift runtime symbols even
when nothing calls them, so `swift-rs` is now a macOS-only build dependency.

## Pending manual checks

- Windows: nothing has run there beyond CI's tests. Needs a real camera, the
  permission handler (no WebView2 prompt expected), styling, and the NSIS
  installer.
- Linux with a real webcam through GStreamer (V4L2 or PipeWire), several
  cameras at once, and hot-plug.
- macOS: behavior should be unchanged (window from config, Vision, same data
  directory); CI only builds and tests it.
- Gesture parity on real desk and wall cameras, from above, and false
  triggers from pen grips now that joints carry no confidence of their own.
- CPU load with two or three cameras at 10 fps on typical laptops.
- Whether the Linux Claude Desktop beta renders the MCP card.
- Before a Windows or Linux release: the site's FAQ says up to four cameras
  run smoothly, which was measured on a Mac with Vision.

## Found along the way, not fixed here

Network cameras lose their URL when settings are saved. The Rust `Camera` in
`src-tauri/src/settings.rs` has no `url` field, so `set_settings` drops it,
and after a restart the camera no longer counts as a network camera. The fix
is an optional `url` field with
`#[serde(default, skip_serializing_if = "Option::is_none")]`. It affects
every platform and is left for a separate change.

## Next steps

1. Watch CI on all three platforms and fix what it finds.
2. Run the pending manual checks.
3. Parity harness: record JPEG sequences of each gesture and of pen grips
   from real cameras (local and untracked), run both backends on a Mac, where
   rten runs too, and tune thresholds if the fire sequences differ.
4. If CPU load is too high: track hands between frames to skip the palm
   detector, or detect less often while no hand is in view.
5. Release: Windows signing and distribution decisions, a release matrix,
   per-OS links on the site.

## Remaining open decisions

1. Order of manual testing: Windows first (more users, Chromium's camera
   stack) or Linux first.
2. Distribution: Linux formats beyond `.deb` and AppImage, and the Windows
   signing route.

## Sources

- Tauri 2.12 changelog, permission handler exposed (#14865):
  https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/CHANGELOG.md
- wry changelog, expanded permission API for WebView2, WKWebView and
  WebKitGTK (#1654): https://github.com/tauri-apps/wry/blob/dev/CHANGELOG.md
- Camera failing on Linux under Tauri, analysis of the unanswered
  permission request (October 2026):
  https://github.com/jfolcini/agaric/issues/5386
- WebKitGTK media setup and GStreamer plugin requirements (September 2026):
  https://github.com/zackees/kernal-api/issues/154
- MediaPipe C API header:
  https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/c/vision/hand_landmarker/hand_landmarker.h
- MediaPipe on PyPI (1.1.1, Apache 2.0): https://pypi.org/project/mediapipe/
- MediaPipe hand landmarker guide:
  https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker
- WebView2 permission prompt default and handling:
  https://v3.wails.io/features/windows/permissions
- Windows 11 multi-app camera:
  https://pureinfotech.com/allow-multiple-apps-use-camera-windows-11/
- Claude Desktop for Linux beta: https://claude.com/download
- MediaPipe base options, "CA bundle to use for usage logging":
  https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/c/core/base_options.h
- MediaPipe's open-source dummy logger:
  https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/core/logging/factory/logging_factory.cc
- Model card for MediaPipe Hands (Lite/Full), Apache 2.0:
  https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf
