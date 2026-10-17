# Hand models (Linux and Windows)

The two ONNX files here are Google's MediaPipe Hand Landmarker models,
converted for `src-tauri/src/vision/landmarker.rs`, which runs them through
[rten](https://github.com/robertknight/rten) on Linux and Windows. macOS uses
Apple Vision instead and does not compile them in.

| File                           | Input                         | Outputs                                                                                                        |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `hand_detector.onnx`           | 1 x 192 x 192 x 3 RGB, 0 to 1 | `Identity`: 2016 x 18 box and keypoint offsets; `Identity_1`: 2016 palm logits                                 |
| `hand_landmarks_detector.onnx` | 1 x 224 x 224 x 3 RGB, 0 to 1 | `Identity`: 21 x 3 landmarks in crop pixels; `Identity_1`: hand presence; `Identity_2`: handedness (1 = right) |

## Provenance

- Source: `hand_landmarker.task` (float16, version 1) from
  `storage.googleapis.com/mediapipe-models`, SHA-256
  `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
- License: Apache License 2.0, per Google's model card for MediaPipe Hands
  (Lite/Full, October 2021). A copy of the license is in `LICENSE`. The model
  card lists gesture recognition and hand control as intended uses.
- Conversion: `convert.py`, with tf2onnx 1.17.0 at opset 17. It stores the
  weights as float16, which is lossless because the source weights are
  float16, and checks the outputs against the original TFLite models
  (relative drift 2.3e-6 for the detector and 1.9e-5 for the landmark model).

Only the model files are used. MediaPipe's own runtime is not part of Tafel:
its prebuilt library sends usage metrics to Google (see
`specs/2026-10-17-linux-and-windows.md`).
