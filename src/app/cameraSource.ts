/**
 * Live camera acquisition and per-frame extraction: a small JPEG for hand
 * detection and a reading-resolution desk view for the agent snapshot.
 * Everything works in one upright coordinate space — the frame is rotated
 * once, on the way in — so display, detection, ring, and snapshot agree.
 */

import {
  Rect,
  Rotation,
  SNAPSHOT_MAX_EDGE,
  fitWithin,
} from "../core/cameraSet";

/** Longest side of the frame handed to the hand detector; plenty for hand pose. */
export const DETECTION_MAX_WIDTH = 640;

/** The frame's size after a clockwise rotation. */
export const rotatedSize = (
  width: number,
  height: number,
  rotation: Rotation,
): { width: number; height: number } =>
  rotation % 180 === 0 ? { width, height } : { width: height, height: width };

/**
 * Draws `source` (a video or image) into `ctx`, rotated clockwise, assuming
 * the canvas is already sized to the rotated dimensions. Shared by the live
 * display loop and the sampler so both see the same upright frame.
 */
export const drawRotated = (
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  rotation: Rotation,
): void => {
  ctx.save();
  if (rotation === 90) {
    ctx.translate(height, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(width, height);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(0, width);
    ctx.rotate((3 * Math.PI) / 2);
  }
  ctx.drawImage(source, 0, 0, width, height);
  ctx.restore();
};

export interface FrameCropper {
  /** Downscaled frame for hand detection. */
  detectionJpegB64(): string;
  /** The camera's crop rectangle at reading resolution — the snapshot. */
  deskJpegB64(): string;
  /** An arbitrary region (fractions of the upright frame) — e.g. a focus crop. */
  regionJpegB64(region: Rect): string;
  /** The upright frame's pixel size, for computing square regions. */
  readonly width: number;
  readonly height: number;
}

/** How long the boot waits for the permission-priming camera open. */
const PRIME_TIMEOUT_MS = 5000;

/**
 * WKWebView hides device ids and labels until the page has used a camera
 * once, so on a fresh launch `listCameras` returns nothing. Open the default
 * camera briefly to trigger the permission grant; without this an empty set
 * can never be filled and saved cameras are never seen as present.
 */
export const primeCameraPermission = async (): Promise<void> => {
  const request = navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false,
  });
  // Release the camera whenever it arrives, even after we stopped waiting.
  request
    .then((stream) => stream.getTracks().forEach((track) => track.stop()))
    .catch(() => {
      // No camera or permission denied: the list stays empty, the UI says so.
    });
  // A busy or slow camera must not hold up the rest of the boot.
  const settled = request.then(
    () => undefined,
    () => undefined,
  );
  const timeout = new Promise<void>((resolve) =>
    window.setTimeout(resolve, PRIME_TIMEOUT_MS),
  );
  await Promise.race([settled, timeout]);
};

export const listCameras = async (): Promise<MediaDeviceInfo[]> => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  // Before camera permission is granted, WKWebView returns devices with an
  // empty deviceId and no label — useless as options, so drop them.
  return devices.filter(
    (device) => device.kind === "videoinput" && device.deviceId !== "",
  );
};

export interface OpenedCamera {
  readonly stream: MediaStream;
  /** The id of the device that actually opened (may differ from requested). */
  readonly deviceId: string | null;
}

/**
 * Opens the requested camera, falling back to the system default when the
 * stored id is stale — device ids are origin-scoped, so ids persisted by a
 * dev build don't resolve in the installed app (and vice versa). A stale
 * selection must degrade to "some camera", never to an error.
 */
export const openCamera = async (
  deviceId: string | null,
): Promise<OpenedCamera> => {
  const constraints = (id: string | null): MediaStreamConstraints => ({
    video: {
      ...(id ? { deviceId: { exact: id } } : {}),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    if (!deviceId) throw error;
    stream = await navigator.mediaDevices.getUserMedia(constraints(null));
  }
  const actualId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
  return { stream, deviceId: actualId };
};

const stripDataUrl = (dataUrl: string): string =>
  dataUrl.slice(dataUrl.indexOf(",") + 1);

/**
 * Draws the current frame onto `canvas`, upright (rotation applied), and
 * returns lazy encoders. Detection reads the whole upright frame; the
 * snapshot reads only the crop rectangle of it. The source is any drawable
 * image (a live <video> or a decoded network-camera frame).
 */
export const sampleFrame = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
  rotation: Rotation,
  crop: Rect,
): FrameCropper | null => {
  const vw = sourceWidth;
  const vh = sourceHeight;
  if (vw === 0 || vh === 0) return null;

  const { width, height } = rotatedSize(vw, vh, rotation);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  drawRotated(context, source, vw, vh, rotation);

  // Whole upright frame, downscaled — for hand detection.
  const detectionJpegB64 = (): string => {
    const scaled = document.createElement("canvas");
    scaled.width = Math.min(DETECTION_MAX_WIDTH, width);
    scaled.height = Math.round((scaled.width * height) / width);
    const ctx = scaled.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    return stripDataUrl(scaled.toDataURL("image/jpeg", 0.7));
  };

  // Any rectangle of the upright frame, downscaled to reading resolution.
  const regionJpegB64 = (region: Rect): string => {
    const sx = Math.round(region.x * width);
    const sy = Math.round(region.y * height);
    const sw = Math.max(1, Math.round(region.width * width));
    const sh = Math.max(1, Math.round(region.height * height));
    const out = document.createElement("canvas");
    const size = fitWithin(sw, sh, SNAPSHOT_MAX_EDGE);
    out.width = size.width;
    out.height = size.height;
    const ctx = out.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return stripDataUrl(out.toDataURL("image/jpeg", 0.75));
  };

  return {
    detectionJpegB64,
    deskJpegB64: () => regionJpegB64(crop),
    regionJpegB64,
    width,
    height,
  };
};
