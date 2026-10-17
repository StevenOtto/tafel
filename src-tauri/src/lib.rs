mod bus;
mod mcp_server;
mod netcam;
mod sessions;
mod settings;
mod vision;

use base64::Engine;
use bus::{CameraState, DeliveryKind, DeskFrame, FocusPoint, SketchBus, Snapshot};
use serde::{Deserialize, Serialize};
use sessions::{Session, Storage};
use settings::Settings;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

struct AppState {
    settings_path: PathBuf,
    recordings_dir: PathBuf,
    bus: Arc<SketchBus>,
    netcams: netcam::Registry,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as u64
}

fn decode_b64(b64: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    settings::load(&state.settings_path)
}

#[tauri::command]
fn set_settings(state: tauri::State<AppState>, new_settings: Settings) -> Result<(), String> {
    settings::save(&state.settings_path, &new_settings)
}

/// One snapshot as the webview composes it: the image plus the context the
/// agent needs (which camera, when, whether a hand was in the frame).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotInput {
    camera_name: String,
    timestamp_ms: u64,
    hand_free: bool,
    jpeg_b64: String,
    #[serde(default)]
    cropped: bool,
    #[serde(default)]
    focus: Option<FocusPoint>,
}

/// The webview composes a whole gesture-triggered delivery (it knows the
/// cameras, the collection, and which frame was hand-free) and reports it
/// here; the MCP server delivers it to whichever agent is waiting.
#[tauri::command]
fn report_delivery(
    state: tauri::State<AppState>,
    kind: DeliveryKind,
    trigger: String,
    snapshots: Vec<SnapshotInput>,
    skipped_cameras: Vec<String>,
) -> Result<u64, String> {
    let snapshots = snapshots
        .into_iter()
        .map(|s| {
            Ok(Snapshot {
                camera_name: s.camera_name,
                timestamp_ms: s.timestamp_ms,
                hand_free: s.hand_free,
                cropped: s.cropped,
                focus: s.focus,
                jpeg: decode_b64(&s.jpeg_b64)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(state
        .bus
        .publish_delivery(now_ms(), kind, trigger, snapshots, skipped_cameras))
}

/// Hand-pose landmarks for one camera frame (JPEG). Runs on the machine:
/// Apple Vision on macOS, MediaPipe's models elsewhere. Classification
/// happens in the webview.
#[tauri::command]
async fn detect_hands(jpeg_b64: String) -> Result<vision::Detection, String> {
    let jpeg = decode_b64(&jpeg_b64)?;
    tauri::async_runtime::spawn_blocking(move || vision::detect_hands(&jpeg))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether a network-camera URL is on the local network (validation for the
/// add-camera UI; the fetch enforces it again anyway).
#[tauri::command]
fn camera_url_is_local(url: String) -> bool {
    netcam::host_is_local(&url)
}

/// The newest frame of a local-network camera. `jpeg_b64` is left out when
/// `seq` equals the caller's `after_seq`, so an unchanged frame is not
/// re-encoded on every poll.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkFrame {
    seq: u64,
    jpeg_b64: Option<String>,
}

/// Reads memory only: a background reader in `netcam` owns the connection,
/// the app's only outbound one, and only ever to a local host. `None` while
/// the first connection is still being made.
#[tauri::command]
async fn latest_network_frame(
    state: tauri::State<'_, AppState>,
    url: String,
    after_seq: Option<u64>,
) -> Result<Option<NetworkFrame>, String> {
    Ok(state.netcams.latest(&url)?.map(|frame| NetworkFrame {
        seq: frame.seq,
        jpeg_b64: (Some(frame.seq) != after_seq)
            .then(|| base64::engine::general_purpose::STANDARD.encode(frame.jpeg.as_slice())),
    }))
}

/// Instrument panel "Record": persists a landmark sequence (JSONL, one frame
/// per line) so gesture fixtures can be replayed in tests without a camera.
/// Returns the path written.
#[tauri::command]
fn save_gesture_recording(
    state: tauri::State<AppState>,
    name: String,
    jsonl: String,
) -> Result<String, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("recording name must contain letters or digits".to_string());
    }
    std::fs::create_dir_all(&state.recordings_dir).map_err(|e| e.to_string())?;
    let path = state
        .recordings_dir
        .join(format!("{}-{}.jsonl", safe, now_ms()));
    std::fs::write(&path, jsonl).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// The session set as the control window shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsView {
    sessions: Vec<Session>,
    current_id: Option<String>,
    storage: Storage,
}

#[tauri::command]
fn list_sessions(state: tauri::State<AppState>) -> SessionsView {
    SessionsView {
        sessions: state.bus.sessions(),
        current_id: state.bus.current_session().map(|s| s.id),
        storage: state.bus.storage(),
    }
}

/// One delivery as the history panel shows it: images as base64 JPEG.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryView {
    seq: u64,
    kind: DeliveryKind,
    timestamp_ms: u64,
    cameras: Vec<String>,
    images: Vec<String>,
}

#[tauri::command]
fn session_deliveries(state: tauri::State<AppState>, id: String) -> Vec<DeliveryView> {
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    state
        .bus
        .session_deliveries(&id)
        .iter()
        .map(|d| DeliveryView {
            seq: d.seq,
            kind: d.kind,
            timestamp_ms: d.timestamp_ms,
            cameras: d.snapshots.iter().map(|s| s.camera_name.clone()).collect(),
            images: d.snapshots.iter().map(|s| encode(&s.jpeg)).collect(),
        })
        .collect()
}

#[tauri::command]
fn switch_session(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    state.bus.switch_session(&id)
}

#[tauri::command]
fn new_session(state: tauri::State<AppState>, name: String) -> Result<(), String> {
    state.bus.new_session(&name, now_ms())
}

#[tauri::command]
fn rename_session(state: tauri::State<AppState>, id: String, name: String) -> Result<(), String> {
    state.bus.rename_session(&id, &name)
}

#[tauri::command]
fn delete_session(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    state.bus.delete_session(&id)
}

/// Removes one delivery from the current session (files included).
#[tauri::command]
fn delete_delivery(state: tauri::State<AppState>, seq: u64) -> Result<(), String> {
    state.bus.delete_delivery(seq)
}

/// Periodic low-rate frame of one camera, so an agent can look at the desk on
/// demand between deliveries.
#[tauri::command]
fn report_frame(
    state: tauri::State<AppState>,
    camera_id: String,
    camera_name: String,
    frame_jpeg_b64: String,
) -> Result<(), String> {
    state.bus.publish_frame(DeskFrame {
        camera_id,
        camera_name,
        timestamp_ms: now_ms(),
        jpeg: decode_b64(&frame_jpeg_b64)?,
    });
    Ok(())
}

#[tauri::command]
fn report_camera_state(state: tauri::State<AppState>, camera_id: String, status: CameraState) {
    state.bus.set_camera_state(&camera_id, status);
}

#[tauri::command]
fn get_agent_status(state: tauri::State<AppState>) -> serde_json::Value {
    let latest = state.bus.latest_delivery();
    let mut status = state.bus.status(latest.as_ref().map(|d| d.seq));
    status["latestSeq"] = latest.map(|d| d.seq).into();
    status
}

/// A camera left the set; the agent must no longer see its last frame.
#[tauri::command]
fn retire_frame(state: tauri::State<AppState>, camera_id: String) {
    state.bus.retire_frame(&camera_id);
}

/// Forwards one bus broadcast to the window as a Tauri event with the
/// broadcast's payload.
fn forward<T: serde::Serialize + Clone + Send + 'static>(
    app: tauri::AppHandle,
    mut rx: tokio::sync::broadcast::Receiver<T>,
    event: &'static str,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(payload) => {
                    let _ = app.emit(event, payload);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Linux and Windows build the control window here instead of from
/// tauri.conf.json (their platform config sets `create: false`) so that it
/// can grant the camera: WebKitGTK refuses getUserMedia unless the app
/// answers the permission request, and WebView2 would otherwise ask the user
/// itself. macOS keeps the window from the config.
#[cfg(not(target_os = "macos"))]
fn create_control_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::webview::{PermissionKind, PermissionResponse};
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "control")
        .ok_or("no control window in the config")?;
    tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            // Session images and recordings grow without bound, so they stay
            // out of the roaming profile on Windows. On macOS and Linux this
            // is the same directory as `data_dir`.
            let local_dir = app.path().app_local_data_dir()?;
            let bus = Arc::new(SketchBus::new(local_dir.join("sessions")));
            let settings_path = data_dir.join("settings.json");
            let recordings_dir = local_dir.join("recordings");
            mcp_server::spawn(bus.clone(), settings::load(&settings_path).mcp_port);
            // Session changes come from the agent (start_session) as well as
            // from the window; agent reads only from the agent. The window
            // hears both, with who did what in the payload.
            forward(app.handle().clone(), bus.subscribe_sessions_changed(), "sessions-changed");
            forward(app.handle().clone(), bus.subscribe_agent_reads(), "agent-read");
            app.manage(AppState {
                settings_path,
                recordings_dir,
                bus,
                netcams: netcam::Registry::new(),
            });
            #[cfg(not(target_os = "macos"))]
            create_control_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            report_delivery,
            report_frame,
            report_camera_state,
            get_agent_status,
            retire_frame,
            list_sessions,
            session_deliveries,
            switch_session,
            new_session,
            rename_session,
            delete_session,
            delete_delivery,
            detect_hands,
            camera_url_is_local,
            latest_network_frame,
            save_gesture_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
