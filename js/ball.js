// Lightweight ball tracker: finds the basketball by its orange colour on a downscaled frame.
// This is a heuristic, not an object-detection model. It works best with a plain background
// and good light, and the app lets the player correct make/miss by hand.

const SCAN_W = 160;

export class BallTracker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.last = null;
  }

  /** Returns {x, y, r} in video pixels, or null. */
  detect(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    const scale = SCAN_W / vw;
    const w = SCAN_W, h = Math.round(vh * scale);
    if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(video, 0, 0, w, h);
    const { data } = this.ctx.getImageData(0, 0, w, h);

    let n = 0, sx = 0, sy = 0, minX = w, maxX = 0, minY = h, maxY = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (isBallOrange(data[i], data[i + 1], data[i + 2])) {
          n++; sx += x; sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    // Reject noise and large orange regions (walls, shirts).
    if (n < 4 || n > w * h * 0.05) { this.last = null; return null; }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = n / (bw * bh);
    if (fill < 0.35 || bw / bh > 2.2 || bh / bw > 2.2) { this.last = null; return null; }
    const hit = { x: sx / n / scale, y: sy / n / scale, r: Math.max(bw, bh) / 2 / scale };
    this.last = hit;
    return hit;
  }
}

function isBallOrange(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 70 || max !== r) return false;
  const s = (max - min) / max;
  if (s < 0.45) return false;
  const hue = (60 * (g - b)) / (max - min); // red is the max channel
  return hue >= 8 && hue <= 38;
}

/**
 * Drops jumps that are physically implausible between frames, keeping the longest smooth run.
 */
export function cleanTrack(points, maxJumpPx) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) <= maxJumpPx * Math.max(1, (p.t - prev.t) / 33)) {
      out.push(p);
    }
  }
  return out;
}

/** True when the ball passes down through the rim (hoop = {x, y, r} in video px). */
export function passedThroughHoop(track, hoop) {
  if (!hoop) return null;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i];
    if (a.y < hoop.y && b.y >= hoop.y) {
      const f = (hoop.y - a.y) / (b.y - a.y || 1);
      const xAt = a.x + (b.x - a.x) * f;
      return Math.abs(xAt - hoop.x) <= hoop.r;
    }
  }
  return false;
}
