//! Hand-pose detection, on the machine. macOS runs Apple Vision through a
//! Swift bridge (`apple`); Linux and Windows run MediaPipe's hand models in
//! Rust (`landmarker`). Both return the same `Detection`, and classification
//! happens in the webview. Nothing leaves the machine.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[cfg(target_os = "macos")]
mod apple;
#[cfg(target_os = "macos")]
pub use apple::detect_hands;

#[cfg(not(target_os = "macos"))]
mod landmarker;
#[cfg(not(target_os = "macos"))]
pub use landmarker::detect_hands;

/// Frame-fraction coordinates, origin top-left.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HandPoint {
    pub x: f64,
    pub y: f64,
    pub confidence: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Hand {
    /// "left", "right", or "unknown" (before macOS 14 Vision reports none).
    pub chirality: String,
    /// Keyed by joint name: wrist, thumbCmc … littleTip (21 joints).
    pub points: HashMap<String, HandPoint>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Detection {
    pub hands: Vec<Hand>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat grey image has no hands; also proves the backend round-trips.
    #[test]
    fn blank_image_yields_no_hands() {
        let blank = include_bytes!("../fixtures/blank.png");
        let detection = detect_hands(blank).expect("the backend should accept a png");
        assert!(detection.hands.is_empty());
    }

    /// Real hand photo, supplied by the user at src-tauri/fixtures/hand.jpg
    /// (not committed). Skips loudly when absent.
    #[test]
    fn hand_photo_yields_at_least_one_hand() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/hand.jpg");
        let Ok(jpeg) = std::fs::read(&path) else {
            eprintln!("skipped: no hand photo at {}", path.display());
            return;
        };
        let detection = detect_hands(&jpeg).expect("the backend should accept a jpeg");
        assert!(!detection.hands.is_empty(), "expected a hand in {}", path.display());
        let hand = &detection.hands[0];
        assert_eq!(hand.points.len(), 21);
        let wrist = &hand.points["wrist"];
        assert!((0.0..=1.0).contains(&wrist.x) && (0.0..=1.0).contains(&wrist.y));
    }

    #[test]
    fn garbage_bytes_report_an_error_instead_of_crashing() {
        let result = detect_hands(b"not an image");
        assert!(result.is_err());
    }
}
