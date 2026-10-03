// Body-pose tracking with MediaPipe Pose Landmarker (runs on-device, in the browser).

const TASKS_VERSION = '0.10.14';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export const SKELETON = [
  [11, 12], [11, 13], [13, 15], [15, 19], [12, 14], [14, 16], [16, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32],
];

export class PoseTracker {
  constructor() {
    this.landmarker = null;
  }

  async load(onStatus = () => {}) {
    onStatus('Loading pose model…');
    const { FilesetResolver, PoseLandmarker } = await import(`${TASKS_URL}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${TASKS_URL}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
    }
    onStatus('Pose model ready');
  }

  /** Returns landmarks in video pixel space, or null when no player is visible. */
  detect(video, t) {
    if (!this.landmarker || video.readyState < 2) return null;
    const res = this.landmarker.detectForVideo(video, t);
    const lm = res.landmarks?.[0];
    if (!lm) return null;
    const w = video.videoWidth, h = video.videoHeight;
    return lm.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 1 }));
  }
}

/** Approximate standing height in pixels (nose to the lower ankle, plus head allowance). */
export function bodyHeightPx(lm) {
  if (!lm) return null;
  const ankleY = Math.max(lm[27].y, lm[28].y);
  return (ankleY - lm[0].y) * 1.12;
}

export function drawSkeleton(ctx, lm, { color = '#4cd9ed', joint = '#ffffff', width = 3, highlight = [] } = {}) {
  if (!lm) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  for (const [a, b] of SKELETON) {
    const hl = highlight.includes(a) && highlight.includes(b);
    ctx.strokeStyle = hl ? '#fdb715' : color;
    ctx.beginPath();
    ctx.moveTo(lm[a].x, lm[a].y);
    ctx.lineTo(lm[b].x, lm[b].y);
    ctx.stroke();
  }
  ctx.fillStyle = joint;
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    ctx.beginPath();
    ctx.arc(lm[i].x, lm[i].y, width * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
