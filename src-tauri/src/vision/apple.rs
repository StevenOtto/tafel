//! Apple Vision backend. The Swift side (swift/TafelVision) runs
//! `VNDetectHumanHandPoseRequest` and hands back JSON in the shape of
//! `Detection`.

use super::Detection;
use swift_rs::{swift, SRData, SRString};

swift!(fn tafel_detect_hands(image: &SRData) -> SRString);

/// Detects up to two hands in an encoded image (JPEG or PNG).
pub fn detect_hands(image: &[u8]) -> Result<Detection, String> {
    let data: SRData = image.into();
    let json = unsafe { tafel_detect_hands(&data) };
    let detection: Detection = serde_json::from_str(json.as_str()).map_err(|e| e.to_string())?;
    match detection.error {
        Some(error) => Err(error),
        None => Ok(detection),
    }
}
