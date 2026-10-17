# Tafel

Desktop app (macOS; Linux and Windows builds are a preview) that
turns desk-camera images into visual input for agents. Hand gestures trigger
deliveries; a local MCP server serves them. Sessions persist images on this
computer. OCR and the earlier UI-generation pipeline were removed; do not
infer current features from their historical specs.

## Stack and commands

- React 19, strict TypeScript 5.8, Vite 7, plain CSS, Vitest, npm lockfile.
- Tauri 2 / Rust. Hand landmarks come from a Swift bridge to Apple Vision on
  macOS, and from MediaPipe's hand models run through rten on Linux and
  Windows (`src-tauri/models/`).
- The macOS app requires macOS 12+, Rust, and Xcode command line tools. The
  first native build may fetch SwiftPM dependencies. Linux builds need the
  WebKitGTK development packages (see README); real cameras there also need
  GStreamer's `gstreamer1.0-plugins-good`. Linux and Windows override the
  window and bundle settings in `src-tauri/tauri.<os>.conf.json`. With
  Xcode 27, release builds also need `rustup component add llvm-tools` (see
  `src-tauri/build.rs`).
  After an Xcode upgrade, `cargo clean -p tafel` (add `--release` for the
  release profile) clears build output that points at the old clang.

Run from the repository root unless stated otherwise:

| Purpose                                     | Command                                           |
| ------------------------------------------- | ------------------------------------------------- |
| Install frontend dependencies               | `npm install`                                     |
| Run desktop app                             | `npm run tauri dev`                               |
| Run frontend only                           | `npm run dev` (does not provide native IPC)       |
| Type check                                  | `npx tsc --noEmit`                                |
| Frontend tests                              | `npm test`                                        |
| Frontend build and type check               | `npm run build`                                   |
| Rust tests, including native bridge         | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Build app and DMG                           | `npm run tauri build`                             |
| Check formatting of changed supported files | `npx prettier --check <files>`                    |

There is no lint script. `npm run format` rewrites the whole repository;
prefer formatting only changed files. Tests do not need a camera. Native
tests exercise only the current OS's hand detector, so CI
(`.github/workflows/ci.yml`) runs them on macOS, Linux and Windows. Real
camera, gesture, and MCP-host behavior also needs runtime verification;
distinguish that from automated test results.

## Load context selectively

Start with `git status --short --branch`, then read the relevant source,
its tests, and one existing example before editing. Load only the relevant
sections of `README.md`, `DESIGN.md`, and dated `specs/`.

| Area                                                      | Entry points                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Window, sessions UI, camera orchestration                 | `src/app/ControlApp.tsx`                                                                                                |
| Camera lifecycle, frame pipeline, overlay                 | `src/app/CameraTile.tsx`, `src/app/cameraSource.ts`, `src/app/GestureOverlay.tsx`                                       |
| Gesture classification, hold, pause/resume, deduplication | `src/core/hand.ts`, `src/core/hold.ts`, `src/core/actions.ts`, `src/core/actionGate.ts`                                 |
| Camera, delivery, session models                          | `src/core/cameraSet.ts`, `src/core/delivery.ts`, `src/core/sessions.ts`                                                 |
| Typed frontend IPC and Rust commands                      | `src/app/tauri.ts`, `src-tauri/src/lib.rs`                                                                              |
| Delivery bus and persistent sessions                      | `src-tauri/src/bus.rs`, `src-tauri/src/sessions.rs`                                                                     |
| MCP tools and transport                                   | `src-tauri/src/mcp_server.rs`                                                                                           |
| Network camera readers and URL checks                     | `src-tauri/src/netcam.rs`                                                                                               |
| Hand detection (Apple Vision, MediaPipe port)             | `src-tauri/src/vision.rs`, `src-tauri/src/vision/`, `src-tauri/swift/TafelVision/Sources/TafelVision/HandPose.swift`    |
| Settings and app permissions                              | `src-tauri/src/settings.rs`, `src-tauri/tauri.conf.json`, `src-tauri/Info.plist`, `src-tauri/capabilities/default.json` |
| Styling and accessible dialog example                     | `src/styles.css`, `src/app/ConfirmDialog.tsx`                                                                           |
| Embedded MCP card                                         | `src-tauri/mcp-app/README.md`, `src-tauri/mcp-app/delivery.html`                                                        |
| Website and releases                                      | `site/index.html`, `.github/workflows/pages.yml`, `.github/workflows/release.yml`                                       |

`tasks/plan.md` and `tasks/todo.md` describe the Android-camera work, not a
general backlog. Their completion checkboxes disagree in places, and some
Mac/hardware checks are still recorded as pending. Verify actual source and
test results before using those checkboxes as status. `FUTURE.md` and
`docs/ideas/` contain ideas, not authorization to implement them. If a spec
and current code conflict, identify whether a later spec supersedes it;
surface unresolved conflicts before changing behavior.

## Existing patterns

- Keep deterministic behavior in `src/core/` with colocated `*.test.ts`
  files. `actions.ts` and `actions.test.ts` are a small reference pair.
- Use named exports, functional React components, typed props, and existing
  CSS classes. Follow nearby code rather than introducing another UI stack.
- Keep native calls in `src/app/tauri.ts`; update the matching Rust command,
  serialized types, and callers together. IPC objects use camelCase fields.
- Keep OS, persistence, and network work in Rust. Vision supplies landmarks;
  TypeScript classifies gestures and tracks holds. Preserve explicit time
  inputs in deterministic logic so recordings and tests can replay it.
- Rust unit tests live alongside their modules. Preserve backward-compatible
  loading of existing settings and sessions when changing stored data.
- The MCP card contains a vendored SDK. Read its README before editing;
  avoid loading or rewriting the minified bundle for ordinary UI changes.

## Boundaries

- Preserve the loopback MCP binding, restricted webview CSP, and Rust-side
  local-network camera URL checks with redirects refused.
- Preserve pause behavior: paused cameras must not expose fresh desk frames
  or send deliveries. Disabling gesture recognition is a separate setting.
- Session images persist until explicitly deleted. Preserve deletion
  confirmations; never use the user's real session store as test data.
- Do not commit secrets, camera credentials, private desk images, build
  output, or unrelated changes. The desk photos in `site/examples/` were chosen
  by the user for publication; ask before adding others. Do not widen network access or restore
  removed cloud/OCR pipelines as incidental cleanup.
- Do not use MediaPipe's own runtime (the `mediapipe` packages or their
  prebuilt library): it reports usage metrics to Google. Use the converted
  models in `src-tauri/models/` instead.

## Verification and handoff

Run checks appropriate to changed behavior and report exact outcomes. A
documentation-only change needs reference/command checks, not a native build.
Do not treat historical passing results as verification of current changes.

At a task boundary, record accepted scope, decisions, changed files,
verification commands/results, pending manual checks, and the next step in
the relevant spec or task document. State whether changes are uncommitted.
Preserve the working tree and do not infer commit, push, or release approval.
