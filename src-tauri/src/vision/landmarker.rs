//! MediaPipe's hand landmarker, ported to Rust over its two models (see
//! models/README.md) and run through rten. It follows MediaPipe's image mode:
//! find palms in the whole frame, crop a rotated square around each, and read
//! 21 joints from the crop. The parameters are MediaPipe's, from
//! hand_detector_graph.cc and hand_landmarks_detector_graph.cc.

use super::{Detection, Hand, HandPoint};
use rten::Model;
use rten_tensor::prelude::*;
use rten_tensor::{NdTensor, Tensor};
use std::f32::consts::PI;
use std::sync::OnceLock;

const DETECTOR_MODEL: &[u8] = include_bytes!("../../models/hand_detector.onnx");
const LANDMARK_MODEL: &[u8] = include_bytes!("../../models/hand_landmarks_detector.onnx");

const DETECTOR_SIZE: usize = 192;
const LANDMARK_SIZE: usize = 224;
const MAX_HANDS: usize = 2;
/// MediaPipe's defaults for the palm and hand-presence thresholds.
const MIN_PALM_SCORE: f32 = 0.5;
const MIN_PRESENCE: f32 = 0.5;
const NMS_MIN_IOU: f32 = 0.3;
/// The hand crop is this many palm boxes wide, shifted half a palm toward the
/// fingers.
const HAND_SCALE: f32 = 2.6;
const HAND_SHIFT_Y: f32 = -0.5;

/// MediaPipe's landmark order, which is also Vision's joint order.
const JOINT_NAMES: [&str; 21] = [
    "wrist",
    "thumbCmc",
    "thumbMp",
    "thumbIp",
    "thumbTip",
    "indexMcp",
    "indexPip",
    "indexDip",
    "indexTip",
    "middleMcp",
    "middlePip",
    "middleDip",
    "middleTip",
    "ringMcp",
    "ringPip",
    "ringDip",
    "ringTip",
    "littleMcp",
    "littlePip",
    "littleDip",
    "littleTip",
];

struct Models {
    detector: Model,
    landmarks: Model,
}

/// Loaded once, on first use; a load failure is kept and reported per call.
fn models() -> Result<&'static Models, String> {
    static MODELS: OnceLock<Result<Models, String>> = OnceLock::new();
    MODELS
        .get_or_init(|| {
            Ok(Models {
                detector: Model::load_static_slice(DETECTOR_MODEL).map_err(|e| e.to_string())?,
                landmarks: Model::load_static_slice(LANDMARK_MODEL).map_err(|e| e.to_string())?,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Detects up to two hands in an encoded image (JPEG or PNG).
pub fn detect_hands(image: &[u8]) -> Result<Detection, String> {
    let rgb = image::load_from_memory(image)
        .map_err(|e| e.to_string())?
        .to_rgb8();
    let frame = Frame {
        width: rgb.width() as usize,
        height: rgb.height() as usize,
        pixels: rgb.as_raw(),
    };
    let models = models()?;
    let mut hands = Vec::new();
    for palm in detect_palms(&models.detector, &frame)?
        .iter()
        .take(MAX_HANDS)
    {
        if let Some(hand) = read_hand(&models.landmarks, &frame, &hand_roi(palm))? {
            hands.push(hand);
        }
    }
    Ok(Detection { hands, error: None })
}

/// Interleaved RGB pixels, row by row.
struct Frame<'a> {
    width: usize,
    height: usize,
    pixels: &'a [u8],
}

/// A rotated rectangle in frame pixels. Rotation is in radians, clockwise on
/// screen because y points down.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Roi {
    cx: f32,
    cy: f32,
    width: f32,
    height: f32,
    rotation: f32,
}

impl Roi {
    /// The frame point at fraction (u, v) of the rectangle, where (0, 0) is
    /// its top-left corner before rotation.
    fn point(&self, u: f32, v: f32) -> (f32, f32) {
        let (sin, cos) = self.rotation.sin_cos();
        let dx = (u - 0.5) * self.width;
        let dy = (v - 0.5) * self.height;
        (self.cx + dx * cos - dy * sin, self.cy + dx * sin + dy * cos)
    }
}

/// Samples `roi` into a size x size RGB tensor with values from 0 to 1,
/// bilinearly. Outside the frame the sample is black (`zero_border`) or the
/// nearest edge pixel. Corners map to corners, as in MediaPipe's OpenCV path.
fn crop(frame: &Frame, roi: &Roi, size: usize, zero_border: bool) -> NdTensor<f32, 4> {
    let pixel = |x: isize, y: isize, channel: usize| -> f32 {
        let inside = x >= 0 && y >= 0 && (x as usize) < frame.width && (y as usize) < frame.height;
        if zero_border && !inside {
            return 0.0;
        }
        let x = x.clamp(0, frame.width as isize - 1) as usize;
        let y = y.clamp(0, frame.height as isize - 1) as usize;
        f32::from(frame.pixels[(y * frame.width + x) * 3 + channel])
    };
    let mut data = Vec::with_capacity(size * size * 3);
    for row in 0..size {
        for column in 0..size {
            let (x, y) = roi.point(column as f32 / size as f32, row as f32 / size as f32);
            let (x0, y0) = (x.floor(), y.floor());
            let (fx, fy) = (x - x0, y - y0);
            let (x0, y0) = (x0 as isize, y0 as isize);
            for channel in 0..3 {
                let top = pixel(x0, y0, channel) * (1.0 - fx) + pixel(x0 + 1, y0, channel) * fx;
                let bottom =
                    pixel(x0, y0 + 1, channel) * (1.0 - fx) + pixel(x0 + 1, y0 + 1, channel) * fx;
                data.push((top * (1.0 - fy) + bottom * fy) / 255.0);
            }
        }
    }
    NdTensor::from_data([1, size, size, 3], data)
}

/// Runs `model` on one image tensor and returns the named outputs, flattened.
fn run<const N: usize>(
    model: &Model,
    input: NdTensor<f32, 4>,
    outputs: [&str; N],
) -> Result<[Vec<f32>; N], String> {
    let input_id = *model.input_ids().first().ok_or("model has no input")?;
    let output_ids = outputs
        .iter()
        .map(|name| model.node_id(name))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let values = model
        .run(vec![(input_id, input.view().into())], &output_ids, None)
        .map_err(|e| e.to_string())?;
    let mut result: [Vec<f32>; N] = std::array::from_fn(|_| Vec::new());
    for (slot, value) in result.iter_mut().zip(values) {
        let tensor: Tensor<f32> = value.try_into().map_err(|e| format!("{e:?}"))?;
        *slot = tensor.to_vec();
    }
    Ok(result)
}

/// A detected palm in frame pixels: its box and seven keypoints (0 is the
/// wrist, 2 the middle finger's knuckle).
#[derive(Clone, Debug, PartialEq)]
struct Palm {
    score: f32,
    xmin: f32,
    ymin: f32,
    xmax: f32,
    ymax: f32,
    keypoints: [(f32, f32); 7],
}

impl Palm {
    fn iou(&self, other: &Palm) -> f32 {
        let width = (self.xmax.min(other.xmax) - self.xmin.max(other.xmin)).max(0.0);
        let height = (self.ymax.min(other.ymax) - self.ymin.max(other.ymin)).max(0.0);
        let intersection = width * height;
        let area = |p: &Palm| (p.xmax - p.xmin) * (p.ymax - p.ymin);
        let union = area(self) + area(other) - intersection;
        if union > 0.0 {
            intersection / union
        } else {
            0.0
        }
    }
}

/// SSD anchor centres for the 192 x 192 palm detector, in MediaPipe's order:
/// a 24 x 24 grid with 2 anchors per cell, then a 12 x 12 grid with 6.
fn anchors() -> &'static [(f32, f32)] {
    static ANCHORS: OnceLock<Vec<(f32, f32)>> = OnceLock::new();
    ANCHORS.get_or_init(|| {
        let mut anchors = Vec::with_capacity(2016);
        for (grid, per_cell) in [(24usize, 2usize), (12, 6)] {
            for y in 0..grid {
                for x in 0..grid {
                    let centre = (
                        (x as f32 + 0.5) / grid as f32,
                        (y as f32 + 0.5) / grid as f32,
                    );
                    anchors.extend(std::iter::repeat_n(centre, per_cell));
                }
            }
        }
        anchors
    })
}

/// Palms in the frame, most confident first, overlapping detections merged.
fn detect_palms(model: &Model, frame: &Frame) -> Result<Vec<Palm>, String> {
    // The whole frame, letterboxed into a square with black bars.
    let side = frame.width.max(frame.height) as f32;
    let letterbox = Roi {
        cx: frame.width as f32 / 2.0,
        cy: frame.height as f32 / 2.0,
        width: side,
        height: side,
        rotation: 0.0,
    };
    let input = crop(frame, &letterbox, DETECTOR_SIZE, true);
    let [boxes, logits] = run(model, input, ["Identity", "Identity_1"])?;
    let scale = DETECTOR_SIZE as f32;
    let mut candidates: Vec<Palm> = anchors()
        .iter()
        .zip(boxes.chunks_exact(18))
        .zip(&logits)
        .filter_map(|((&(ax, ay), raw), &logit)| {
            let score = 1.0 / (1.0 + (-logit.clamp(-100.0, 100.0)).exp());
            if score < MIN_PALM_SCORE {
                return None;
            }
            let to_frame = |u: f32, v: f32| letterbox.point(u, v);
            let (cx, cy) = (raw[0] / scale + ax, raw[1] / scale + ay);
            let (w, h) = (raw[2] / scale, raw[3] / scale);
            let (xmin, ymin) = to_frame(cx - w / 2.0, cy - h / 2.0);
            let (xmax, ymax) = to_frame(cx + w / 2.0, cy + h / 2.0);
            let keypoints = std::array::from_fn(|k| {
                to_frame(raw[4 + 2 * k] / scale + ax, raw[5 + 2 * k] / scale + ay)
            });
            Some(Palm {
                score,
                xmin,
                ymin,
                xmax,
                ymax,
                keypoints,
            })
        })
        .collect();
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok(weighted_nms(candidates))
}

/// MediaPipe's weighted non-max suppression: each palm absorbs the palms that
/// overlap it, averaging box and keypoints by score.
fn weighted_nms(mut remaining: Vec<Palm>) -> Vec<Palm> {
    let mut merged = Vec::new();
    while let Some(top) = remaining.first().cloned() {
        let (overlapping, rest): (Vec<Palm>, Vec<Palm>) = remaining
            .into_iter()
            .partition(|palm| palm.iou(&top) > NMS_MIN_IOU);
        let total: f32 = overlapping.iter().map(|palm| palm.score).sum();
        let average = |value: &dyn Fn(&Palm) -> f32| {
            overlapping
                .iter()
                .map(|palm| value(palm) * palm.score)
                .sum::<f32>()
                / total
        };
        merged.push(Palm {
            score: top.score,
            xmin: average(&|p| p.xmin),
            ymin: average(&|p| p.ymin),
            xmax: average(&|p| p.xmax),
            ymax: average(&|p| p.ymax),
            keypoints: std::array::from_fn(|k| {
                (
                    average(&|p| p.keypoints[k].0),
                    average(&|p| p.keypoints[k].1),
                )
            }),
        });
        remaining = rest;
    }
    merged
}

fn normalize_radians(angle: f32) -> f32 {
    angle - 2.0 * PI * ((angle + PI) / (2.0 * PI)).floor()
}

/// The square around the whole hand, turned so the fingers point up in the
/// crop: rotated by the wrist-to-knuckle direction, shifted toward the
/// fingers and enlarged, as in MediaPipe's palm-to-hand rect transform.
fn hand_roi(palm: &Palm) -> Roi {
    let (wrist, knuckle) = (palm.keypoints[0], palm.keypoints[2]);
    let rotation =
        normalize_radians(PI / 2.0 - (-(knuckle.1 - wrist.1)).atan2(knuckle.0 - wrist.0));
    let (width, height) = (palm.xmax - palm.xmin, palm.ymax - palm.ymin);
    let (sin, cos) = rotation.sin_cos();
    let side = width.max(height) * HAND_SCALE;
    Roi {
        cx: (palm.xmin + palm.xmax) / 2.0 - height * HAND_SHIFT_Y * sin,
        cy: (palm.ymin + palm.ymax) / 2.0 + height * HAND_SHIFT_Y * cos,
        width: side,
        height: side,
        rotation,
    }
}

/// The 21 joints of the hand in `roi`, or None when the model sees no hand.
/// MediaPipe scores the hand, not each joint, so every joint carries the
/// hand-presence score as its confidence.
fn read_hand(model: &Model, frame: &Frame, roi: &Roi) -> Result<Option<Hand>, String> {
    let input = crop(frame, roi, LANDMARK_SIZE, false);
    let [landmarks, presence, handedness] =
        run(model, input, ["Identity", "Identity_1", "Identity_2"])?;
    let presence = presence.first().copied().unwrap_or(0.0);
    if presence < MIN_PRESENCE || landmarks.len() < JOINT_NAMES.len() * 3 {
        return Ok(None);
    }
    let scale = LANDMARK_SIZE as f32;
    let points = JOINT_NAMES
        .iter()
        .zip(landmarks.chunks_exact(3))
        .map(|(name, xyz)| {
            let (x, y) = roi.point(xyz[0] / scale, xyz[1] / scale);
            let point = HandPoint {
                x: f64::from(x) / frame.width as f64,
                y: f64::from(y) / frame.height as f64,
                confidence: f64::from(presence),
            };
            (name.to_string(), point)
        })
        .collect();
    let chirality = if handedness.first().copied().unwrap_or(0.5) > 0.5 {
        "right"
    } else {
        "left"
    };
    Ok(Some(Hand {
        chirality: chirality.to_string(),
        points,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palm(score: f32, xmin: f32, ymin: f32, size: f32) -> Palm {
        Palm {
            score,
            xmin,
            ymin,
            xmax: xmin + size,
            ymax: ymin + size,
            keypoints: [(xmin, ymin); 7],
        }
    }

    #[test]
    fn anchors_match_mediapipe_layout() {
        let anchors = anchors();
        assert_eq!(anchors.len(), 2016);
        assert_eq!(anchors[0], (0.5 / 24.0, 0.5 / 24.0));
        assert_eq!(anchors[1], anchors[0]);
        assert_eq!(anchors[2], (1.5 / 24.0, 0.5 / 24.0));
        assert_eq!(anchors[1152], (0.5 / 12.0, 0.5 / 12.0));
        assert_eq!(anchors[1157], anchors[1152]);
        assert_eq!(anchors[2015], (11.5 / 12.0, 11.5 / 12.0));
    }

    #[test]
    fn roi_point_maps_corners_and_rotates_clockwise() {
        let roi = Roi {
            cx: 50.0,
            cy: 40.0,
            width: 20.0,
            height: 10.0,
            rotation: 0.0,
        };
        assert_eq!(roi.point(0.0, 0.0), (40.0, 35.0));
        assert_eq!(roi.point(0.5, 0.5), (50.0, 40.0));
        let turned = Roi {
            rotation: PI / 2.0,
            ..roi
        };
        // A quarter turn clockwise on screen sends the right edge downward.
        let (x, y) = turned.point(1.0, 0.5);
        assert!((x - 50.0).abs() < 1e-4 && (y - 50.0).abs() < 1e-4);
    }

    #[test]
    fn upright_palm_gives_unrotated_square_above_it() {
        let mut upright = palm(0.9, 100.0, 200.0, 40.0);
        upright.xmax = 150.0; // 50 wide, 40 tall
        upright.keypoints[0] = (125.0, 240.0); // wrist below
        upright.keypoints[2] = (125.0, 200.0); // knuckle above
        let roi = hand_roi(&upright);
        assert!(roi.rotation.abs() < 1e-6);
        assert!((roi.cx - 125.0).abs() < 1e-4);
        assert!((roi.cy - (220.0 - 20.0)).abs() < 1e-4);
        assert!((roi.width - 50.0 * HAND_SCALE).abs() < 1e-3);
        assert_eq!(roi.width, roi.height);
    }

    #[test]
    fn sideways_palm_turns_the_crop_toward_the_fingers() {
        let mut sideways = palm(0.9, 100.0, 100.0, 40.0);
        sideways.keypoints[0] = (140.0, 120.0); // wrist on the right
        sideways.keypoints[2] = (100.0, 120.0); // fingers point left
        let roi = hand_roi(&sideways);
        // Fingers to the left: the crop's "up" points left.
        assert!((roi.rotation - (-PI / 2.0)).abs() < 1e-5);
        assert!(roi.cx < 120.0);
    }

    #[test]
    fn weighted_nms_merges_overlaps_and_keeps_separate_palms() {
        let merged = weighted_nms(vec![
            palm(0.9, 0.0, 0.0, 10.0),
            palm(0.6, 1.0, 1.0, 10.0),
            palm(0.8, 50.0, 50.0, 10.0),
        ]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].score, 0.9);
        assert!((merged[0].xmin - 0.4).abs() < 1e-5); // (0 * 0.9 + 1 * 0.6) / 1.5
        assert_eq!(merged[1].xmin, 50.0);
    }

    #[test]
    fn crop_samples_inside_and_honours_the_border_mode() {
        let pixels = vec![200u8; 4 * 4 * 3];
        let frame = Frame {
            width: 4,
            height: 4,
            pixels: &pixels,
        };
        let inside = Roi {
            cx: 2.0,
            cy: 2.0,
            width: 2.0,
            height: 2.0,
            rotation: 0.0,
        };
        let tensor = crop(&frame, &inside, 4, true);
        assert!(tensor.iter().all(|&v| (v - 200.0 / 255.0).abs() < 1e-6));
        let outside = Roi {
            cx: 100.0,
            cy: 100.0,
            width: 2.0,
            height: 2.0,
            rotation: 0.0,
        };
        assert!(crop(&frame, &outside, 4, true).iter().all(|&v| v == 0.0));
        assert!(crop(&frame, &outside, 4, false)
            .iter()
            .all(|&v| (v - 200.0 / 255.0).abs() < 1e-6));
    }
}
