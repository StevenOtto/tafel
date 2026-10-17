/**
 * The control window. A grid of camera tiles on the left, each running its
 * own gesture pipeline; a calm panel on the right (gesture guide, agent
 * connection, and a folded-away developer section). This component is the
 * orchestrator: it owns the camera set, the collection, the session switcher
 * and delivery history, and the action gate that dedupes overlapping cameras
 * — the per-camera work lives in CameraTile.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { enabledGestures as gesturesOn, statusChange } from "../core/actions";
import { agePhrase } from "../core/age";
import { ActionGate } from "../core/actionGate";
import {
  COMFORTABLE_CAMERA_COUNT,
  Rect,
  addCamera,
  addNetworkCamera,
  availableToAdd,
  isLocalCameraUrl,
  isNetworkCamera,
  removeCamera,
  renameCamera,
  resetView,
  rotateCamera,
  setCrop,
  setMirror,
} from "../core/cameraSet";
import {
  CLOSED_COLLECTION,
  CollectionState,
  DeliveryKind,
  MAX_COLLECTION,
  SnapshotInput,
  addToCollection,
  deliveryIntent,
  isExpired,
  openCollection,
} from "../core/delivery";
import { Gesture, Hand } from "../core/hand";
import { platformFromUserAgent } from "../core/platform";
import {
  Session,
  byRecentActivity,
  formatBytes,
  sessionLabel,
} from "../core/sessions";
import { CameraTile, TileStats, TileStatus } from "./CameraTile";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { FireOutcome } from "./GestureOverlay";
import { listCameras, primeCameraPermission } from "./cameraSource";
import { playFireTone } from "./sound";
import { useDisclosure } from "./useDisclosure";
import {
  DeliveryView,
  AgentStatus,
  getAgentStatus,
  SessionChange,
  Settings,
  deleteDelivery,
  deleteSession,
  getSettings,
  listSessions,
  newSession,
  onAgentRead,
  onSessionsChanged,
  renameSession,
  reportDelivery,
  saveGestureRecording,
  sessionDeliveries,
  setSettings,
  switchSession,
} from "./tauri";

import visualWorkflow from "../../skills/tafel-visual-prompting/references/workflow.md?raw";

const GUIDE: readonly {
  readonly gesture: Gesture;
  readonly glyph: string;
  readonly label: string;
  readonly action: string;
}[] = [
  {
    gesture: "thumbs-up",
    glyph: "👍",
    label: "Thumbs up",
    action: "Send a snapshot",
  },
  {
    gesture: "two-thumbs-up",
    glyph: "🙌",
    label: "Two thumbs",
    action: "All cameras",
  },
  { gesture: "open-palm", glyph: "✋", label: "Open hand", action: "Pause" },
  {
    gesture: "peace-sign",
    glyph: "✌️",
    label: "Peace sign",
    action: "Resume",
  },
  {
    gesture: "ok-sign",
    glyph: "👌",
    label: "Ok sign",
    action: "Start / finish a collection",
  },
];

const NO_GESTURES: readonly Gesture[] = [];

/** Continuity Camera exists only on macOS; elsewhere the hints leave it out. */
const ON_MAC = platformFromUserAgent(navigator.userAgent) === "macos";

/** The inline name field: naming the current session, or starting a new one. */
interface SessionDraft {
  readonly purpose: "rename" | "new";
  readonly name: string;
}

interface DeliveryRecord {
  readonly seq: number;
  readonly kind: DeliveryKind;
  readonly images: readonly string[];
  readonly cameras: readonly string[];
}

const toRecord = (view: DeliveryView): DeliveryRecord => ({
  seq: view.seq,
  kind: view.kind,
  images: view.images.map((b64) => `data:image/jpeg;base64,${b64}`),
  cameras: view.cameras,
});

const deliveryCountPhrase = (count: number): string =>
  count === 1 ? "Its 1 delivery" : `Its ${count} deliveries`;

/** What the agent has read so far this run, for the Agent section. */
interface AgentActivity {
  readonly deskAtMs: number | null;
  readonly delivery: { readonly seq: number; readonly atMs: number } | null;
}

const NO_AGENT_ACTIVITY: AgentActivity = { deskAtMs: null, delivery: null };

const sessionChangePhrase = (change: SessionChange): string | null => {
  if (change.source !== "agent") return null;
  const verb =
    change.outcome === "named"
      ? "named this session"
      : change.outcome === "reopened"
        ? "reopened session"
        : "started session";
  return `The agent ${verb} “${change.name}”`;
};

/** The tail of the storage path, enough to recognise it; full path on hover. */
const shortPath = (path: string): string =>
  `…/${path.split("/").slice(-2).join("/")}`;

const GearIcon = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Zm7.4-3.5a7.6 7.6 0 0 0-.08-1l1.6-1.25a.5.5 0 0 0 .12-.64l-1.52-2.63a.5.5 0 0 0-.6-.22l-1.9.76a5.6 5.6 0 0 0-1.72-1l-.28-2a.5.5 0 0 0-.5-.43h-3.04a.5.5 0 0 0-.5.43l-.28 2a5.6 5.6 0 0 0-1.72 1l-1.9-.76a.5.5 0 0 0-.6.22L3.96 8.11a.5.5 0 0 0 .12.64L5.68 10a7.6 7.6 0 0 0 0 2l-1.6 1.25a.5.5 0 0 0-.12.64l1.52 2.63a.5.5 0 0 0 .6.22l1.9-.76a5.6 5.6 0 0 0 1.72 1l.28 2a.5.5 0 0 0 .5.43h3.04a.5.5 0 0 0 .5-.43l.28-2a5.6 5.6 0 0 0 1.72-1l1.9.76a.5.5 0 0 0 .6-.22l1.52-2.63a.5.5 0 0 0-.12-.64L19.32 13c.05-.33.08-.66.08-1Z"
    />
  </svg>
);

interface Recording {
  readonly startedAt: number;
  readonly lines: string[];
}

export const ControlApp = (): React.JSX.Element => {
  const settingsRef = useRef<Settings | null>(null);
  const collectionRef = useRef<CollectionState>(CLOSED_COLLECTION);
  const statusRef = useRef<Map<string, TileStatus>>(new Map());
  const captureRef = useRef<Map<string, () => SnapshotInput[]>>(new Map());
  const gateRef = useRef(new ActionGate());
  const messageTimerRef = useRef<number | null>(null);
  const settingsWrapRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef<Recording | null>(null);

  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TileStatus>>({});
  const [stats, setStats] = useState<Record<string, TileStats>>({});
  const [forcePaused, setForcePaused] = useState(false);
  const [collection, setCollection] =
    useState<CollectionState>(CLOSED_COLLECTION);
  const [deliveries, setDeliveries] = useState<readonly DeliveryRecord[]>([]);
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [storage, setStorage] = useState<{
    path: string;
    bytes: number;
  } | null>(null);
  /** The rename field's text while renaming; null when not renaming. */
  const [sessionDraft, setSessionDraft] = useState<SessionDraft | null>(null);
  /** The destructive action awaiting the user's confirmation, if any. */
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [lightboxSeq, setLightboxSeq] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [agentActivity, setAgentActivity] =
    useState<AgentActivity>(NO_AGENT_ACTIVITY);
  /** Ticks once a second while there is an agent read to age. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [showLandmarks, setShowLandmarks] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingName, setRecordingName] = useState("gesture");
  const [recordDevice, setRecordDevice] = useState<string>("");
  const [recordingSaved, setRecordingSaved] = useState<string | null>(null);
  const [networkUrl, setNetworkUrl] = useState("");

  const settingsMenu = useDisclosure(160);
  const lightbox = useDisclosure(240);

  const cameras = settings?.cameras ?? [];
  const holdMs = settings?.holdMs ?? 2000;
  const gesturesEnabled = settings?.gesturesEnabled ?? true;
  const disabledGestures = settings?.disabledGestures ?? NO_GESTURES;
  // Stable identity: the tiles restart their hold tracking when it changes.
  const enabledGestures = useMemo(
    () => gesturesOn(disabledGestures),
    [disabledGestures],
  );

  // ----- boot: settings + device list, kept fresh on devicechange -----
  useEffect(() => {
    void (async () => {
      const loaded = await getSettings();
      settingsRef.current = loaded;
      setSettingsState(loaded);
      // List right away (works once permission was granted before), then
      // prime the permission and list again for a first launch.
      setDevices(await listCameras());
      await primeCameraPermission();
      setDevices(await listCameras());
    })();
    const refresh = () => void listCameras().then(setDevices);
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, []);

  // ----- sessions: Rust owns the rules; the window mirrors them -----
  const refreshSessionMeta = useCallback(async () => {
    const view = await listSessions();
    setSessions(view.sessions);
    setCurrentSessionId(view.currentId);
    setStorage(view.storage);
    return view;
  }, []);

  const refreshSessions = useCallback(async () => {
    const view = await refreshSessionMeta();
    const records = view.currentId
      ? await sessionDeliveries(view.currentId)
      : [];
    setDeliveries(records.map(toRecord).reverse());
  }, [refreshSessionMeta]);

  const announce = useCallback((text: string) => {
    setMessage(text);
    if (messageTimerRef.current !== null)
      window.clearTimeout(messageTimerRef.current);
    messageTimerRef.current = window.setTimeout(() => setMessage(null), 2500);
  }, []);

  // The agent naming the user's work is said out loud; the window's own
  // changes only refresh.
  useEffect(() => {
    void refreshSessions();
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onSessionsChanged((change) => {
      void refreshSessions();
      const phrase = sessionChangePhrase(change);
      if (phrase) announce(phrase);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [announce, refreshSessions]);

  // Every agent read lands in the Agent section; a look at the live desk —
  // the one read no gesture preceded — is also said in the status line.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onAgentRead((read) => {
      setAgentActivity((current) =>
        read.what === "desk"
          ? { ...current, deskAtMs: read.atMs }
          : { ...current, delivery: { seq: read.seq, atMs: read.atMs } },
      );
      if (read.what === "desk") announce("Agent looked at the desk");
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [announce]);

  useEffect(() => {
    if (agentActivity.deskAtMs === null && agentActivity.delivery === null)
      return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [agentActivity]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const status = await getAgentStatus();
        if (!disposed) setAgentStatus(status);
      } catch {
        if (!disposed) setAgentStatus(null);
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const current = settingsRef.current;
    if (!current) return;
    const updated = { ...current, ...patch };
    settingsRef.current = updated;
    setSettingsState(updated);
    await setSettings(updated);
  }, []);

  useEffect(
    () => () => {
      if (messageTimerRef.current !== null)
        window.clearTimeout(messageTimerRef.current);
    },
    [],
  );

  // Settings popover: close on Escape or an outside press.
  useEffect(() => {
    if (!settingsMenu.mounted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") settingsMenu.close();
    };
    const onDown = (event: PointerEvent) => {
      if (!settingsWrapRef.current?.contains(event.target as Node))
        settingsMenu.close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [settingsMenu]);

  // Escape closes the enlarged delivery.
  useEffect(() => {
    if (!lightbox.mounted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") lightbox.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const setCollectionState = useCallback((next: CollectionState) => {
    collectionRef.current = next;
    setCollection(next);
  }, []);

  // ----- stable callbacks handed to every tile -----
  const registerCapture = useCallback(
    (deviceId: string, capture: (() => SnapshotInput[]) | null) => {
      if (capture) captureRef.current.set(deviceId, capture);
      else captureRef.current.delete(deviceId);
    },
    [],
  );

  const onStatus = useCallback((deviceId: string, status: TileStatus) => {
    statusRef.current.set(deviceId, status);
    setStatuses((existing) =>
      existing[deviceId] === status
        ? existing
        : { ...existing, [deviceId]: status },
    );
  }, []);

  const onStats = useCallback((deviceId: string, next: TileStats) => {
    setStats((existing) => ({ ...existing, [deviceId]: next }));
  }, []);

  const onSample = useCallback(
    (deviceId: string, hands: readonly Hand[]) => {
      const active = recordingRef.current;
      if (!active || deviceId !== recordDevice) return;
      active.lines.push(
        JSON.stringify({
          t: Math.round(performance.now() - active.startedAt),
          hands,
        }),
      );
    },
    [recordDevice],
  );

  // Snapshots of every watching camera, in set order; paused/disconnected
  // cameras are skipped and named.
  const captureAll = useCallback((): {
    snapshots: SnapshotInput[];
    skipped: string[];
  } => {
    const snapshots: SnapshotInput[] = [];
    const skipped: string[] = [];
    for (const camera of settingsRef.current?.cameras ?? []) {
      const watching = statusRef.current.get(camera.deviceId) === "watching";
      const snaps = watching
        ? (captureRef.current.get(camera.deviceId)?.() ?? [])
        : [];
      if (snaps.length > 0) snapshots.push(...snaps);
      else skipped.push(camera.name);
    }
    return { snapshots, skipped };
  }, []);

  const publish = useCallback(
    async (
      kind: DeliveryKind,
      trigger: string,
      snapshots: SnapshotInput[],
      skipped: string[],
    ): Promise<void> => {
      if (snapshots.length === 0) {
        announce("No watching camera to send");
        return;
      }
      const seq = await reportDelivery(kind, trigger, snapshots, skipped);
      announce(`Visual prompt #${seq} saved locally`);
      setDeliveries((existing) => [
        {
          seq,
          kind,
          images: snapshots.map((s) => `data:image/jpeg;base64,${s.jpegB64}`),
          cameras: snapshots.map((s) => s.cameraName),
        },
        ...existing,
      ]);
      // Counts and storage moved; a newly opened session arrives by event.
      void refreshSessionMeta();
    },
    [announce, refreshSessionMeta],
  );

  const performFire = useCallback(
    async (deviceId: string, gesture: Gesture): Promise<void> => {
      if (settingsRef.current?.soundOnFire) playFireTone();

      // Pause / resume: the tile flips its own status; here we only speak.
      const currentStatus = statusRef.current.get(deviceId);
      const change = statusChange(
        gesture,
        currentStatus === "paused" ? "paused" : "watching",
      );
      if (change) {
        announce(
          change === "paused"
            ? "Paused — show a peace sign to resume"
            : "Watching again",
        );
        return;
      }

      // Pointing marks an attention point on its camera (handled in the tile);
      // there is nothing to deliver now.
      if (gesture === "pointing") {
        announce("Attention point set — it rides the next snapshot");
        return;
      }

      const intent = deliveryIntent(gesture, collectionRef.current);
      switch (intent.type) {
        case "capture-single": {
          const snaps = captureRef.current.get(deviceId)?.() ?? [];
          await publish("single", gesture, snaps, []);
          if (snaps.length > 0) announce("Snapshot sent");
          break;
        }
        case "capture-all": {
          const { snapshots, skipped } = captureAll();
          await publish("all-cameras", gesture, snapshots, skipped);
          announce(
            skipped.length
              ? `All cameras sent · skipped ${skipped.join(", ")}`
              : "All cameras sent",
          );
          break;
        }
        case "open-collection":
          setCollectionState(openCollection(performance.now()));
          announce("Collection open · 0");
          break;
        case "add-to-collection": {
          const adds = intent.all
            ? captureAll().snapshots
            : (captureRef.current.get(deviceId)?.() ?? []);
          if (adds.length === 0) {
            announce("Nothing to add");
            break;
          }
          const next = addToCollection(
            collectionRef.current,
            adds,
            performance.now(),
          );
          setCollectionState(next);
          announce(`Added to collection · ${next.snapshots.length}`);
          break;
        }
        case "publish-collection": {
          const snapshots = [...collectionRef.current.snapshots];
          setCollectionState(CLOSED_COLLECTION);
          await publish("collection", gesture, snapshots, []);
          announce(`Collection of ${snapshots.length} sent`);
          break;
        }
        case "collection-empty":
          setCollectionState(CLOSED_COLLECTION);
          announce("Empty collection — nothing sent");
          break;
        case "collection-full":
          announce(`Collection full (${MAX_COLLECTION})`);
          break;
        case "none":
          break;
      }
    },
    [announce, captureAll, publish, setCollectionState],
  );

  // The gate is synchronous (so the tile knows at once whether to confirm or
  // say "already sent"); the delivery it authorises runs fire-and-forget.
  const onFire = useCallback(
    (deviceId: string, gesture: Gesture): FireOutcome => {
      const outcome = gateRef.current.evaluate(
        deviceId,
        gesture,
        performance.now(),
      );
      if (outcome === "fire") void performFire(deviceId, gesture);
      return outcome;
    },
    [performFire],
  );

  // An open collection can expire while nobody gestures; poll it lightly.
  useEffect(() => {
    if (!collection.open) return;
    const interval = window.setInterval(() => {
      if (isExpired(collectionRef.current, performance.now())) {
        setCollectionState(CLOSED_COLLECTION);
        announce("Collection expired — nothing sent");
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [collection.open, announce, setCollectionState]);

  // ----- camera set operations -----
  const addSelectedCamera = useCallback(
    (deviceId: string) => {
      const device = devices.find((d) => d.deviceId === deviceId);
      if (!device) return;
      void updateSettings({
        cameras: addCamera(
          settingsRef.current?.cameras ?? [],
          deviceId,
          device.label,
        ),
      });
    },
    [devices, updateSettings],
  );

  const addNetwork = useCallback(() => {
    const url = networkUrl.trim();
    if (!isLocalCameraUrl(url)) {
      announce("That URL is not on the local network");
      return;
    }
    void updateSettings({
      cameras: addNetworkCamera(settingsRef.current?.cameras ?? [], url),
    });
    setNetworkUrl("");
  }, [networkUrl, announce, updateSettings]);

  const onRename = useCallback(
    (deviceId: string, name: string) => {
      void updateSettings({
        cameras: renameCamera(
          settingsRef.current?.cameras ?? [],
          deviceId,
          name,
        ),
      });
    },
    [updateSettings],
  );

  const onRemove = useCallback(
    (deviceId: string) => {
      statusRef.current.delete(deviceId);
      captureRef.current.delete(deviceId);
      void updateSettings({
        cameras: removeCamera(settingsRef.current?.cameras ?? [], deviceId),
      });
    },
    [updateSettings],
  );

  const onMirror = useCallback(
    (deviceId: string, mirror: boolean) => {
      void updateSettings({
        cameras: setMirror(
          settingsRef.current?.cameras ?? [],
          deviceId,
          mirror,
        ),
      });
    },
    [updateSettings],
  );

  const onRotate = useCallback(
    (deviceId: string) => {
      void updateSettings({
        cameras: rotateCamera(settingsRef.current?.cameras ?? [], deviceId),
      });
    },
    [updateSettings],
  );

  const onCrop = useCallback(
    (deviceId: string, crop: Rect) => {
      void updateSettings({
        cameras: setCrop(settingsRef.current?.cameras ?? [], deviceId, crop),
      });
    },
    [updateSettings],
  );

  const onResetView = useCallback(
    (deviceId: string) => {
      void updateSettings({
        cameras: resetView(settingsRef.current?.cameras ?? [], deviceId),
      });
    },
    [updateSettings],
  );

  // ----- fixture recorder (scoped to one camera) -----
  const toggleRecording = useCallback(async () => {
    const active = recordingRef.current;
    if (!active) {
      recordingRef.current = { startedAt: performance.now(), lines: [] };
      setRecording(true);
      setRecordingSaved(null);
      return;
    }
    recordingRef.current = null;
    setRecording(false);
    try {
      const path = await saveGestureRecording(
        recordingName,
        active.lines.join("\n") + "\n",
      );
      setRecordingSaved(path);
    } catch {
      setRecordingSaved("could not save");
    }
  }, [recordingName]);

  const openLightbox = useCallback(
    (seq: number) => {
      setLightboxSeq(seq);
      lightbox.open();
    },
    [lightbox],
  );

  const removeDelivery = useCallback(
    async (seq: number) => {
      setConfirm(null);
      try {
        await deleteDelivery(seq);
        lightbox.close();
        announce("Snapshot removed from session");
      } catch (error) {
        announce(String(error));
      }
    },
    [announce, lightbox],
  );

  // A click on a guide row does what the gesture would do — on the first
  // watching camera, deliberately, so the gate is bypassed.
  const triggerGesture = useCallback(
    (gesture: Gesture) => {
      if (gesture === "open-palm") {
        setForcePaused(true);
        announce("Paused — click Peace sign or show one to resume");
        return;
      }
      if (gesture === "peace-sign") {
        setForcePaused(false);
        announce("Watching again");
        return;
      }
      const target = (settingsRef.current?.cameras ?? []).find(
        (camera) => statusRef.current.get(camera.deviceId) === "watching",
      );
      if (!target) {
        announce("No watching camera to send");
        return;
      }
      void performFire(target.deviceId, gesture);
    },
    [announce, performFire],
  );

  const currentSession =
    sessions.find((s) => s.id === currentSessionId) ?? null;

  const chooseSession = useCallback(
    (id: string) => {
      setSessionDraft(null);
      switchSession(id).catch((error) => announce(String(error)));
    },
    [announce],
  );

  const commitRename = useCallback(async () => {
    if (!currentSession || sessionDraft === null) return;
    try {
      await renameSession(currentSession.id, sessionDraft.name);
      setSessionDraft(null);
    } catch (error) {
      announce(String(error));
    }
  }, [announce, currentSession, sessionDraft]);

  const startNewSession = useCallback(async () => {
    if (sessionDraft === null) return;
    try {
      await newSession(sessionDraft.name);
      setSessionDraft(null);
      announce(`Started session “${sessionDraft.name.trim()}”`);
    } catch (error) {
      announce(String(error));
    }
  }, [announce, sessionDraft]);

  const removeSession = useCallback(async () => {
    if (!currentSession) return;
    setConfirm(null);
    try {
      await deleteSession(currentSession.id);
    } catch (error) {
      announce(String(error));
    }
  }, [announce, currentSession]);

  const available = availableToAdd(cameras, devices);
  const watchingCount = cameras.filter(
    (c) => statuses[c.deviceId] === "watching",
  ).length;
  const summary =
    cameras.length === 0
      ? "Add a camera to begin"
      : `${watchingCount} of ${cameras.length} watching`;
  const statusTone = message ? "busy" : watchingCount > 0 ? "idle" : "paused";
  const openRecord = deliveries.find((d) => d.seq === lightboxSeq);
  const recordTarget = recordDevice || cameras[0]?.deviceId || "";

  return (
    <div className="control">
      <header className="control__header" data-tauri-drag-region>
        <div className="control__header-left">
          <h1 className="control__title">Tafel</h1>
          <p
            className={`control__status control__status--${statusTone}`}
            role="status"
            aria-live="polite"
          >
            <span className="control__status-dot" aria-hidden="true" />
            {message ?? summary}
          </p>
        </div>
        <div className="control__header-right">
          <div className="control__camera">
            <label className="control__camera-label" htmlFor="add-camera">
              Add camera
            </label>
            <select
              id="add-camera"
              className="control__camera-select"
              value=""
              disabled={available.length === 0}
              onChange={(event) => {
                if (event.target.value) addSelectedCamera(event.target.value);
              }}
            >
              <option value="">
                {available.length > 0
                  ? "Choose…"
                  : devices.length > 0
                    ? "All cameras added"
                    : "No cameras found"}
              </option>
              {available.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          {cameras.length > 0 && (
            <button
              type="button"
              className={`control__watch-button${forcePaused ? " control__watch-button--resume" : ""}`}
              onClick={() => setForcePaused((value) => !value)}
              aria-pressed={forcePaused}
            >
              {forcePaused ? "Resume all" : "Pause all"}
            </button>
          )}
          <div className="control__settings" ref={settingsWrapRef}>
            <button
              type="button"
              className="control__icon-button"
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsMenu.mounted}
              onClick={() =>
                settingsMenu.mounted
                  ? settingsMenu.close()
                  : settingsMenu.open()
              }
            >
              <GearIcon />
            </button>
            {settingsMenu.mounted && (
              <div
                className="control__popover"
                data-open={settingsMenu.shown}
                role="dialog"
                aria-label="Settings"
              >
                <label className="control__toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={gesturesEnabled}
                    onChange={(event) =>
                      void updateSettings({
                        gesturesEnabled: event.target.checked,
                      })
                    }
                  />
                  Gesture recognition
                </label>
                <fieldset className="control__gesture-settings">
                  <legend>Camera gestures</legend>
                  {[
                    ...GUIDE,
                    { gesture: "pointing" as Gesture, label: "Pointing" },
                  ].map((entry) => (
                    <label className="control__toggle" key={entry.gesture}>
                      <input
                        type="checkbox"
                        checked={enabledGestures.includes(entry.gesture)}
                        disabled={!gesturesEnabled}
                        onChange={(event) =>
                          void updateSettings({
                            disabledGestures: event.target.checked
                              ? disabledGestures.filter(
                                  (gesture) => gesture !== entry.gesture,
                                )
                              : [...disabledGestures, entry.gesture],
                          })
                        }
                      />
                      {entry.label}
                    </label>
                  ))}
                  <p className="control__hint">Buttons always work.</p>
                </fieldset>
                <div className="control__field">
                  <label htmlFor="hold-ms">
                    Hold duration · {(holdMs / 1000).toFixed(1)} s
                  </label>
                  <input
                    id="hold-ms"
                    type="range"
                    min={1000}
                    max={4000}
                    step={250}
                    value={holdMs}
                    onChange={(event) =>
                      void updateSettings({
                        holdMs: Number(event.target.value),
                      })
                    }
                  />
                </div>
                <label className="control__toggle">
                  <input
                    type="checkbox"
                    checked={settings?.soundOnFire ?? true}
                    onChange={(event) =>
                      void updateSettings({ soundOnFire: event.target.checked })
                    }
                  />
                  Sound when a gesture fires
                </label>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="control__body">
        {collection.open && (
          <p className="control__banner control__banner--collection">
            <span>Collection open · {collection.snapshots.length}</span>
            <button
              type="button"
              className="control__inline-button"
              onClick={() => {
                setCollectionState(CLOSED_COLLECTION);
                announce("Collection cancelled");
              }}
            >
              Cancel
            </button>
          </p>
        )}
        {cameras.length > COMFORTABLE_CAMERA_COUNT && (
          <p className="control__banner control__banner--note">
            {cameras.length} cameras — smooth performance is only guaranteed up
            to {COMFORTABLE_CAMERA_COUNT}.
          </p>
        )}

        <div className="control__main">
          {cameras.length === 0 ? (
            <div className="control__empty">
              <p>No cameras yet.</p>
              <p className="control__hint">
                {ON_MAC
                  ? available.length > 0
                    ? "Add one from the menu above — your desk, a wall camera, an iPhone via Continuity Camera."
                    : "Connect a camera (or an iPhone via Continuity Camera) to begin."
                  : available.length > 0
                    ? "Add one from the menu above."
                    : "Connect a camera to begin."}
              </p>
            </div>
          ) : (
            <ul className="tile-grid" aria-label="Cameras">
              {cameras.map((camera) => (
                <CameraTile
                  key={camera.deviceId}
                  camera={camera}
                  present={
                    isNetworkCamera(camera) ||
                    devices.some((d) => d.deviceId === camera.deviceId)
                  }
                  forcePaused={forcePaused}
                  holdMs={holdMs}
                  gesturesEnabled={gesturesEnabled}
                  enabledGestures={enabledGestures}
                  showLandmarks={showLandmarks}
                  onFire={onFire}
                  onStatus={onStatus}
                  onStats={onStats}
                  onSample={onSample}
                  registerCapture={registerCapture}
                  onRename={onRename}
                  onRemove={onRemove}
                  onMirror={onMirror}
                  onRotate={onRotate}
                  onCrop={onCrop}
                  onResetView={onResetView}
                />
              ))}
            </ul>
          )}

          <section className="control__panel" aria-label="Instrument panel">
            <h2 className="control__panel-title">Gestures</h2>
            <ul className="control__guide">
              {GUIDE.map((entry) => (
                <li key={entry.label}>
                  <button
                    type="button"
                    className="control__guide-row"
                    disabled={cameras.length === 0}
                    aria-label={`${entry.label}: ${entry.action} now`}
                    onClick={() => triggerGesture(entry.gesture)}
                  >
                    <span className="control__guide-glyph" aria-hidden="true">
                      {entry.glyph}
                    </span>
                    <span className="control__guide-text">
                      <span className="control__guide-label">
                        {entry.label}
                      </span>
                      <span className="control__guide-action">
                        {entry.action}
                        {!gesturesEnabled ||
                        !enabledGestures.includes(entry.gesture)
                          ? " · camera gesture off"
                          : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="control__hint">
              {gesturesEnabled
                ? "Hold a gesture for the camera, or click a row to do the same."
                : "Gesture recognition is off. Click a row to do the same."}
            </p>

            <h2 className="control__panel-title">Agent</h2>
            <dl className="instrument">
              <div className="instrument__row">
                <dt>Listening</dt>
                <dd>
                  {!agentStatus
                    ? "Status unavailable"
                    : agentStatus.captureState === "paused"
                      ? "Paused in Tafel"
                      : agentStatus.captureState === "disconnected"
                        ? "Cameras disconnected"
                        : agentStatus.captureState === "idle"
                          ? "No active cameras"
                          : agentStatus.activeWaits > 0
                            ? "Waiting for your next prompt"
                            : "No agent waiting"}
                </dd>
              </div>
              <div className="instrument__row">
                <dt>Latest prompt</dt>
                <dd>
                  {!agentStatus || agentStatus.latestSeq === null
                    ? "Not sent yet"
                    : `#${agentStatus.latestSeq} · ${agentStatus.work ? { working: "Working on your prompt", completed: "Completed", "needs-input": "Needs your input" }[agentStatus.work.state] : agentStatus.receivedAtMs !== null ? "Delivered to agent" : "Saved locally"}`}
                </dd>
              </div>
              <div className="instrument__row">
                <dt>Looked at the desk</dt>
                <dd>
                  {agentActivity.deskAtMs === null
                    ? "Not yet"
                    : agePhrase(agentActivity.deskAtMs, nowMs)}
                </dd>
              </div>
              <div className="instrument__row">
                <dt>Read a delivery</dt>
                <dd>
                  {agentActivity.delivery === null
                    ? "Not yet"
                    : `#${agentActivity.delivery.seq} · ${agePhrase(agentActivity.delivery.atMs, nowMs)}`}
                </dd>
              </div>
            </dl>
            {agentStatus?.work && (
              <p className="control__hint">{agentStatus.work.summary}</p>
            )}
            {agentStatus?.activeWaits === 0 && (
              <p className="control__hint">
                Ask your agent to listen with Tafel. Resuming a camera alone
                cannot restart an idle chat.
              </p>
            )}
            <button
              type="button"
              className="control__inline-button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(
                    `Start a continuous Tafel visual-prompting session.\n\n${visualWorkflow}`,
                  )
                  .then(() =>
                    announce(
                      "Visual-prompting instructions copied — paste into your agent chat",
                    ),
                  )
                  .catch(() =>
                    announce(
                      "Could not copy. Use the Start visual prompting prompt in your MCP host.",
                    ),
                  );
              }}
            >
              Copy visual-prompting instructions
            </button>
            <p className="control__hint">
              While a camera is watching, a connected agent can look at your
              desk at any time. Sent prompts wait locally until an agent reads
              them. Pause stops new capture and listening; work already started
              continues. Sent snapshots stay on this computer, in sessions,
              until you delete them.
            </p>

            <details className="control__dev">
              <summary>Developer</summary>
              <h3 className="control__panel-title">Network camera</h3>
              <form
                className="control__field control__field--inline"
                onSubmit={(event) => {
                  event.preventDefault();
                  addNetwork();
                }}
              >
                <label className="control__camera-label" htmlFor="network-url">
                  Stream URL
                </label>
                <input
                  id="network-url"
                  type="url"
                  placeholder="http://192.168…/stream"
                  aria-describedby="network-hint"
                  value={networkUrl}
                  onChange={(event) => setNetworkUrl(event.target.value)}
                />
                <button
                  type="submit"
                  className="control__inline-button"
                  disabled={networkUrl.trim() === ""}
                >
                  Add
                </button>
              </form>
              <p id="network-hint" className="control__hint">
                Install an IP-camera app on the phone and start its server. The
                app then shows the stream URL on screen, like
                http://192.168.1.23:8080/video. Paste it here.
              </p>

              <h3 className="control__panel-title">Agent connection</h3>
              <dl className="instrument">
                <div className="instrument__row">
                  <dt>Endpoint</dt>
                  <dd className="instrument__mono">
                    127.0.0.1:{settings?.mcpPort ?? "—"}
                  </dd>
                </div>
                <div className="instrument__row">
                  <dt>Session</dt>
                  <dd>{currentSession ? sessionLabel(currentSession) : "—"}</dd>
                </div>
                <div className="instrument__row">
                  <dt>Deliveries in session</dt>
                  <dd>{deliveries.length}</dd>
                </div>
                <div className="instrument__row">
                  <dt>Storage</dt>
                  <dd className="instrument__mono" title={storage?.path}>
                    {storage
                      ? `${formatBytes(storage.bytes)} · ${shortPath(storage.path)}`
                      : "—"}
                  </dd>
                </div>
              </dl>
              <p className="control__hint">
                Connect Claude to this endpoint (see README), then use a gesture
                to send what's on the desk.
              </p>
              {cameras.length > 0 && (
                <dl className="instrument">
                  {cameras.map((camera) => (
                    <div className="instrument__row" key={camera.deviceId}>
                      <dt>{camera.name}</dt>
                      <dd>
                        {stats[camera.deviceId]
                          ? `${stats[camera.deviceId].fps.toFixed(0)} fps · ${stats[camera.deviceId].latencyMs.toFixed(0)} ms`
                          : (statuses[camera.deviceId] ?? "—")}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <label className="control__toggle">
                <input
                  type="checkbox"
                  checked={showLandmarks}
                  onChange={(event) => setShowLandmarks(event.target.checked)}
                />
                Show hand landmarks
              </label>
              {cameras.length > 0 && (
                <>
                  <div className="control__field control__field--inline">
                    <label htmlFor="record-device">Camera</label>
                    <select
                      id="record-device"
                      value={recordTarget}
                      disabled={recording}
                      onChange={(event) => setRecordDevice(event.target.value)}
                    >
                      {cameras.map((camera) => (
                        <option key={camera.deviceId} value={camera.deviceId}>
                          {camera.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="control__field control__field--inline">
                    <label htmlFor="recording-name">Fixture</label>
                    <input
                      id="recording-name"
                      type="text"
                      value={recordingName}
                      disabled={recording}
                      onChange={(event) => setRecordingName(event.target.value)}
                    />
                    <button
                      type="button"
                      className={`control__record-button${recording ? " is-recording" : ""}`}
                      onClick={() => void toggleRecording()}
                      aria-pressed={recording}
                    >
                      {recording ? "Stop" : "Record"}
                    </button>
                  </div>
                  <p className="control__hint">
                    {recording
                      ? `Recording ${cameras.find((c) => c.deviceId === recordTarget)?.name ?? ""} — perform the gesture, then stop.`
                      : recordingSaved
                        ? `Saved to ${recordingSaved}`
                        : "Records one camera's landmarks as a replayable fixture."}
                  </p>
                </>
              )}
            </details>
          </section>
        </div>

        <section
          className="control__history"
          aria-label="Sessions and deliveries"
        >
          <div className="control__history-head">
            <div className="control__session">
              <label className="control__camera-label" htmlFor="session-switch">
                Session
              </label>
              <select
                id="session-switch"
                className="control__session-select"
                value={currentSessionId ?? ""}
                onChange={(event) => {
                  if (event.target.value) chooseSession(event.target.value);
                }}
              >
                {currentSessionId === null && (
                  <option value="">None — the next delivery starts one</option>
                )}
                {byRecentActivity(sessions).map((session) => (
                  <option key={session.id} value={session.id}>
                    {sessionLabel(session)} · {session.deliveryCount}
                  </option>
                ))}
              </select>
              {sessionDraft === null && (
                <button
                  type="button"
                  className="control__inline-button"
                  onClick={() => setSessionDraft({ purpose: "new", name: "" })}
                >
                  New
                </button>
              )}
              {currentSession && sessionDraft === null && (
                <>
                  <button
                    type="button"
                    className="control__inline-button"
                    onClick={() =>
                      setSessionDraft({
                        purpose: "rename",
                        name: currentSession.provisional
                          ? ""
                          : currentSession.name,
                      })
                    }
                  >
                    {currentSession.provisional ? "Name" : "Rename"}
                  </button>
                  <button
                    type="button"
                    className="control__inline-button control__inline-button--destructive"
                    onClick={() =>
                      setConfirm({
                        title: `Delete “${sessionLabel(currentSession)}”?`,
                        message: `${deliveryCountPhrase(currentSession.deliveryCount)} will be removed from this computer. Anything the agent already received stays in that conversation. This cannot be undone.`,
                        confirmLabel: "Delete",
                        onConfirm: () => void removeSession(),
                      })
                    }
                  >
                    Delete
                  </button>
                </>
              )}
              {sessionDraft !== null && (
                <form
                  className="control__session-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void (sessionDraft.purpose === "new"
                      ? startNewSession()
                      : commitRename());
                  }}
                >
                  <input
                    type="text"
                    className="control__url-input"
                    aria-label={
                      sessionDraft.purpose === "new"
                        ? "New session name"
                        : "Session name"
                    }
                    placeholder="Kiosk redesign"
                    value={sessionDraft.name}
                    onChange={(event) =>
                      setSessionDraft({
                        ...sessionDraft,
                        name: event.target.value,
                      })
                    }
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="control__inline-button"
                    disabled={sessionDraft.name.trim() === ""}
                  >
                    {sessionDraft.purpose === "new" ? "Start" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="control__inline-button"
                    onClick={() => setSessionDraft(null)}
                  >
                    Cancel
                  </button>
                </form>
              )}
            </div>
          </div>
          {deliveries.length === 0 ? (
            <p className="control__hint">
              {currentSession
                ? "No deliveries in this session yet."
                : "No session yet — start one with New, or your next delivery does."}
            </p>
          ) : (
            <ul className="control__delivery-list">
              {deliveries.map((delivery) => (
                <li key={delivery.seq}>
                  <button
                    type="button"
                    className="control__delivery"
                    onClick={() => openLightbox(delivery.seq)}
                    aria-haspopup="dialog"
                  >
                    <img
                      className="control__delivery-thumb"
                      src={delivery.images[0]}
                      alt=""
                    />
                    <span className="control__delivery-meta">
                      <span>#{delivery.seq}</span>
                      <span>
                        {delivery.kind} · {delivery.images.length} img
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {lightbox.mounted && openRecord && (
        <div
          className="control__lightbox"
          data-open={lightbox.shown}
          role="dialog"
          aria-modal="true"
          aria-label={`Delivery ${openRecord.seq}`}
          onClick={() => lightbox.close()}
        >
          <div
            className="control__lightbox-inner"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="control__lightbox-bar">
              <span>
                Delivery #{openRecord.seq} · {openRecord.kind} ·{" "}
                {openRecord.images.length} image
                {openRecord.images.length === 1 ? "" : "s"} ·{" "}
                {Array.from(new Set(openRecord.cameras)).join(", ")}
              </span>
              <span className="control__lightbox-actions">
                <button
                  type="button"
                  className="control__inline-button control__inline-button--destructive"
                  onClick={() =>
                    setConfirm({
                      title: `Remove delivery #${openRecord.seq}?`,
                      message:
                        "Its images are removed from this computer. Anything the agent already received stays in that conversation. This cannot be undone.",
                      confirmLabel: "Remove",
                      onConfirm: () => void removeDelivery(openRecord.seq),
                    })
                  }
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="control__inline-button"
                  onClick={() => lightbox.close()}
                >
                  Close
                </button>
              </span>
            </div>
            <div className="control__lightbox-grid">
              {openRecord.images.map((src, index) => (
                <figure key={index} className="control__lightbox-figure">
                  <img
                    className="control__lightbox-image"
                    src={src}
                    alt={`Delivery ${openRecord.seq}, image ${index + 1} from ${openRecord.cameras[index] ?? "camera"}`}
                  />
                  <figcaption>
                    {openRecord.cameras[index] ?? "camera"}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </div>
  );
};
