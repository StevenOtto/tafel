/**
 * Typed bridge to the Rust core. The webview reports camera material into
 * the sketch bus, asks for hand landmarks, persists settings, and
 * manages sessions; nothing else crosses the boundary.
 */

import { invoke } from "@tauri-apps/api/core";
import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { Camera } from "../core/cameraSet";
import { DeliveryKind, SnapshotInput } from "../core/delivery";
import { Detection, Gesture } from "../core/hand";
import { Session } from "../core/sessions";

export interface Settings {
  mcpPort: number;
  cameras: Camera[];
  holdMs: number;
  soundOnFire: boolean;
  gesturesEnabled: boolean;
  /** Camera gestures switched off; a gesture added later starts on. */
  disabledGestures: readonly Gesture[];
}

export const getSettings = (): Promise<Settings> => invoke("get_settings");

export const setSettings = (newSettings: Settings): Promise<void> =>
  invoke("set_settings", { newSettings });

/** Deliver a gesture-triggered set of snapshots to the MCP bus. */
export const reportDelivery = (
  kind: DeliveryKind,
  trigger: string,
  snapshots: SnapshotInput[],
  skippedCameras: string[],
): Promise<number> =>
  invoke("report_delivery", { kind, trigger, snapshots, skippedCameras });

/** Refresh one camera's on-demand desk frame (what `get_desk` serves). */
export const reportFrame = (
  cameraId: string,
  cameraName: string,
  frameJpegB64: string,
): Promise<void> =>
  invoke("report_frame", { cameraId, cameraName, frameJpegB64 });

/** A camera left the set: the agent must no longer see its last frame. */
export const retireFrame = (cameraId: string): Promise<void> =>
  invoke("retire_frame", { cameraId });

/** Hand landmarks for one frame: Apple Vision on macOS, MediaPipe's models elsewhere. */
export const detectHands = (jpegB64: string): Promise<Detection> =>
  invoke("detect_hands", { jpegB64 });

/** The newest frame of a network camera; `jpegB64` is null when unchanged. */
export interface NetworkFrame {
  seq: number;
  jpegB64: string | null;
}

/**
 * The newest frame of a local-network camera, from memory: Rust holds the
 * connection. Resolves to null while the first connection is being made;
 * rejects while the camera is unreachable. Pass the last `seq` drawn so an
 * unchanged frame comes back without its image.
 */
export const latestNetworkFrame = (
  url: string,
  afterSeq: number | null,
): Promise<NetworkFrame | null> =>
  invoke("latest_network_frame", { url, afterSeq });

/** Persist a landmark recording as a gesture fixture; resolves to the path. */
export const saveGestureRecording = (
  name: string,
  jsonl: string,
): Promise<string> => invoke("save_gesture_recording", { name, jsonl });

/** The session set as Rust holds it, plus where and how big it is on disk. */
export interface SessionsView {
  readonly sessions: Session[];
  readonly currentId: string | null;
  readonly storage: { readonly path: string; readonly bytes: number };
}

/** One stored delivery for the history panel; images are base64 JPEG. */
export interface DeliveryView {
  readonly seq: number;
  readonly kind: DeliveryKind;
  readonly timestampMs: number;
  readonly cameras: string[];
  readonly images: string[];
}

export const listSessions = (): Promise<SessionsView> =>
  invoke("list_sessions");

/** The deliveries of one session, oldest first. */
export const sessionDeliveries = (id: string): Promise<DeliveryView[]> =>
  invoke("session_deliveries", { id });

export const switchSession = (id: string): Promise<void> =>
  invoke("switch_session", { id });

/** Opens an empty named session and makes it current. */
export const newSession = (name: string): Promise<void> =>
  invoke("new_session", { name });

export const renameSession = (id: string, name: string): Promise<void> =>
  invoke("rename_session", { id, name });

/** Removes the session and its files from disk. */
export const deleteSession = (id: string): Promise<void> =>
  invoke("delete_session", { id });

/** Removes one delivery of the current session from disk. */
export const deleteDelivery = (seq: number): Promise<void> =>
  invoke("delete_delivery", { seq });

/** Why the session set changed: the window itself, or the agent naming work. */
export type SessionChange =
  | { readonly source: "app" }
  | {
      readonly source: "agent";
      readonly outcome: "named" | "reopened" | "opened";
      readonly name: string;
    };

/** Fires when the agent or the window changed the session set. */
export const onSessionsChanged = (
  handler: (change: SessionChange) => void,
): Promise<UnlistenFn> =>
  listen<SessionChange>("sessions-changed", (event) => handler(event.payload));

/** One read of camera material by the agent. */
export type AgentRead =
  | { readonly what: "desk"; readonly atMs: number }
  | { readonly what: "delivery"; readonly seq: number; readonly atMs: number };

/** Fires every time the agent reads the desk or a delivery. */
export const onAgentRead = (
  handler: (read: AgentRead) => void,
): Promise<UnlistenFn> =>
  listen<AgentRead>("agent-read", (event) => handler(event.payload));

/** Publish capture state even when no frames are being sent. */
export const reportCameraState = (
  cameraId: string,
  status: "watching" | "paused" | "disconnected",
): Promise<void> => invoke("report_camera_state", { cameraId, status });

export interface AgentStatus {
  readonly captureState: "watching" | "paused" | "disconnected" | "idle";
  readonly activeWaits: number;
  readonly latestSeq: number | null;
  readonly receivedAtMs: number | null;
  readonly work: {
    readonly state: "working" | "completed" | "needs-input";
    readonly summary: string;
    readonly atMs: number;
  } | null;
}
export const getAgentStatus = (): Promise<AgentStatus> =>
  invoke("get_agent_status");
