/**
 * Hand landmarks → gesture. Pure geometry over the 21 hand joints (from
 * Apple Vision on macOS, MediaPipe's models elsewhere), no trained classifier:
 * every rule is a ratio against the palm length so it is independent of
 * camera distance, and every rule is testable with synthetic landmark sets.
 */

export const JOINT_NAMES = [
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
] as const;

export type JointName = (typeof JOINT_NAMES)[number];

/** Frame fractions, origin top-left, as delivered by the Rust `detect_hands` command. */
export interface HandPoint {
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

export type Chirality = "left" | "right" | "unknown";

export interface Hand {
  readonly chirality: Chirality;
  readonly points: Partial<Record<JointName, HandPoint>>;
}

export interface Detection {
  readonly hands: readonly Hand[];
}

/** What one hand is doing. */
export type HandPose =
  "thumbs-up" | "open-palm" | "peace-sign" | "ok-sign" | "pointing" | "none";

/** What the frame as a whole signals; adds the two-handed variant. */
export type Gesture = HandPose | "two-thumbs-up";

export const GESTURES: readonly Gesture[] = [
  "thumbs-up",
  "two-thumbs-up",
  "open-palm",
  "peace-sign",
  "ok-sign",
  "pointing",
  "none",
];

/** Joints below this confidence are treated as missing. */
const MIN_CONFIDENCE = 0.3;

type FingerState = "extended" | "curled" | "unclear";

interface Finger {
  readonly mcp: JointName;
  readonly pip: JointName;
  readonly tip: JointName;
}

const FINGERS: readonly Finger[] = [
  { mcp: "indexMcp", pip: "indexPip", tip: "indexTip" },
  { mcp: "middleMcp", pip: "middlePip", tip: "middleTip" },
  { mcp: "ringMcp", pip: "ringPip", tip: "ringTip" },
  { mcp: "littleMcp", pip: "littlePip", tip: "littleTip" },
];

const distance = (a: HandPoint, b: HandPoint): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const joint = (hand: Hand, name: JointName): HandPoint | null => {
  const point = hand.points[name];
  if (!point || point.confidence < MIN_CONFIDENCE) return null;
  return point;
};

/**
 * A finger is extended when its tip is clearly farther from the wrist than
 * its middle joint, curled when it folds back toward the palm; anything in
 * between is unclear and yields no gesture rather than a wrong one.
 */
const fingerState = (
  hand: Hand,
  finger: Finger,
  wrist: HandPoint,
): FingerState | null => {
  const pip = joint(hand, finger.pip);
  const tip = joint(hand, finger.tip);
  if (!pip || !tip) return null;
  const ratio = distance(wrist, tip) / distance(wrist, pip);
  if (ratio > 1.15) return "extended";
  if (ratio < 0.95) return "curled";
  return "unclear";
};

/** Classifies a single hand; `none` whenever the evidence is incomplete. */
export const classifyHand = (hand: Hand): HandPose => {
  const wrist = joint(hand, "wrist");
  const middleMcp = joint(hand, "middleMcp");
  const indexMcp = joint(hand, "indexMcp");
  const indexTip = joint(hand, "indexTip");
  const thumbTip = joint(hand, "thumbTip");
  if (!wrist || !middleMcp || !indexMcp || !indexTip || !thumbTip)
    return "none";

  const palm = distance(wrist, middleMcp);
  if (palm === 0) return "none";

  const states = FINGERS.map((finger) => fingerState(hand, finger, wrist));
  if (states.some((state) => state === null)) return "none";
  const [index, middle, ring, little] = states as FingerState[];

  // Thumb tucked across the palm sits by the index knuckle; extended, it is
  // well away from it.
  const thumbExtended = distance(thumbTip, indexMcp) > 0.6 * palm;
  const thumbTouchesIndex = distance(thumbTip, indexTip) < 0.35 * palm;

  if (
    thumbTouchesIndex &&
    middle === "extended" &&
    ring === "extended" &&
    little === "extended"
  )
    return "ok-sign";

  const allExtended = [index, middle, ring, little].every(
    (state) => state === "extended",
  );
  if (thumbExtended && allExtended) return "open-palm";

  // Index and middle up and spread into a V, the others down. The spread
  // keeps it clear of two fingers resting side by side on a pen.
  const middleTip = joint(hand, "middleTip");
  const spread =
    middleTip !== null && distance(indexTip, middleTip) > 0.3 * palm;
  if (
    spread &&
    index === "extended" &&
    middle === "extended" &&
    ring === "curled" &&
    little === "curled"
  )
    return "peace-sign";

  // Only the index extended, thumb not: pointing. Checked before the curled
  // cases and requiring a tucked thumb keeps it clear of thumbs-up and ok.
  const onlyIndex =
    index === "extended" &&
    middle === "curled" &&
    ring === "curled" &&
    little === "curled";
  if (!thumbExtended && onlyIndex) return "pointing";

  const allCurled = [index, middle, ring, little].every(
    (state) => state === "curled",
  );
  // A fist (thumb tucked) is deliberately nothing: a pen grip looks the same.
  if (thumbExtended && allCurled) return "thumbs-up";
  return "none";
};

/** The index fingertip of a pointing hand, in frame fractions, or null. */
export const pointingTip = (hand: Hand): HandPoint | null =>
  classifyHand(hand) === "pointing" ? joint(hand, "indexTip") : null;

/**
 * Classifies the frame: both hands thumbs-up is its own gesture; otherwise
 * the single clear hand wins, and disagreement between two hands is `none`.
 */
export const classifyGesture = (detection: Detection): Gesture => {
  const poses = detection.hands
    .map(classifyHand)
    .filter((pose) => pose !== "none");
  if (poses.length === 0) return "none";
  if (poses.length === 1) return poses[0];
  if (poses.every((pose) => pose === "thumbs-up")) return "two-thumbs-up";
  if (poses.every((pose) => pose === poses[0])) return poses[0];
  return "none";
};

/** Axis-aligned bounds of a hand's confident joints, for drawing the ring. */
export const handBounds = (
  hand: Hand,
): { x: number; y: number; width: number; height: number } | null => {
  const points = JOINT_NAMES.map((name) => joint(hand, name)).filter(
    (point): point is HandPoint => point !== null,
  );
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};
