// Pure analysis functions — no DOM, no camera. Unit-tested in tests/metrics.test.js.

export const IDEAL_ARC = { min: 45, max: 52 };
export const BALL_DIAMETER_M = 0.24;
const G = 9.81;

/** Angle ABC in degrees, with B as the vertex. Points are {x, y}. */
export function jointAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!mag) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
}

/**
 * Least-squares fit of y = a·x² + b·x + c to ball positions in image space.
 * Image y grows downward, so a real upward arc has a > 0.
 */
export function fitParabola(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (const { x, y } of points) {
    const x2 = x * x;
    sx += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2;
    sy += y; sxy += x * y; sx2y += x2 * y;
  }
  // Solve the 3×3 normal equations with Cramer's rule.
  const m = [
    [sx4, sx3, sx2],
    [sx3, sx2, sx],
    [sx2, sx, n],
  ];
  const r = [sx2y, sxy, sy];
  const det3 = (q) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det3(m);
  if (Math.abs(d) < 1e-9) return null;
  const col = (i) => m.map((row, k) => row.map((v, j) => (j === i ? r[k] : v)));
  return { a: det3(col(0)) / d, b: det3(col(1)) / d, c: det3(col(2)) / d };
}

/**
 * Launch angle (degrees above horizontal) from the first samples of a ball track.
 * Works in either horizontal direction.
 */
export function launchAngle(track) {
  const fit = fitParabola(track);
  if (!fit) return null;
  const x0 = track[0].x;
  const slope = 2 * fit.a * x0 + fit.b; // dy/dx in image space (y down)
  const dir = Math.sign(track[track.length - 1].x - x0) || 1;
  return (Math.atan2(-slope * dir, 1) * 180) / Math.PI;
}

/**
 * Release speed in m/s from the first few samples of a track.
 * `pxPerMetre` comes from the player's body height or the ball's apparent size.
 */
export function releaseSpeed(track, pxPerMetre) {
  if (track.length < 2 || !pxPerMetre) return null;
  const k = Math.min(4, track.length - 1);
  const p0 = track[0], p1 = track[k];
  const dt = (p1.t - p0.t) / 1000;
  if (dt <= 0) return null;
  const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y) / pxPerMetre;
  return dist / dt;
}

/** Peak height of the arc above the release point, in metres. */
export function apexHeight(speed, angleDeg) {
  const vy = speed * Math.sin((angleDeg * Math.PI) / 180);
  return (vy * vy) / (2 * G);
}

/** Form features extracted from a sequence of pose frames around one shot. */
export function analyseForm(frames, side = 'right') {
  if (!frames.length) return null;
  const S = side === 'right'
    ? { sh: 12, el: 14, wr: 16, idx: 20, hip: 24, kn: 26, an: 28 }
    : { sh: 11, el: 13, wr: 15, idx: 19, hip: 23, kn: 25, an: 27 };

  // Release = the frame where the wrist is highest (smallest y).
  let releaseI = 0;
  frames.forEach((f, i) => {
    if (f.lm[S.wr].y < frames[releaseI].lm[S.wr].y) releaseI = i;
  });

  // Dip = lowest knee angle before release.
  let dipI = 0, minKnee = 180;
  for (let i = 0; i <= releaseI; i++) {
    const lm = frames[i].lm;
    const k = jointAngle(lm[S.hip], lm[S.kn], lm[S.an]);
    if (k < minKnee) { minKnee = k; dipI = i; }
  }

  // Set point = first frame after the dip where the wrist is above the forehead.
  let setI = releaseI;
  for (let i = dipI; i <= releaseI; i++) {
    if (frames[i].lm[S.wr].y < frames[i].lm[0].y) { setI = i; break; }
  }

  const set = frames[setI].lm;
  const rel = frames[releaseI].lm;
  const elbowAtSet = jointAngle(set[S.sh], set[S.el], set[S.wr]);
  const elbowAtRelease = jointAngle(rel[S.sh], rel[S.el], rel[S.wr]);

  // Elbow tuck: horizontal offset of elbow from the wrist, as a fraction of forearm length.
  const forearm = Math.hypot(set[S.wr].x - set[S.el].x, set[S.wr].y - set[S.el].y) || 1;
  const elbowFlare = Math.abs(set[S.el].x - set[S.wr].x) / forearm;

  // Follow-through: fingers below the wrist (wrist snapped) for frames after release.
  const after = frames.slice(releaseI + 1);
  const snapped = after.filter((f) => f.lm[S.idx].y > f.lm[S.wr].y).length;
  const followThroughMs = after.length
    ? (snapped / after.length) * (after[after.length - 1].t - frames[releaseI].t)
    : 0;

  // Balance: horizontal drift of the hip centre from dip to landing, in torso lengths.
  // (Torso length rather than shoulder width, because shoulders overlap in a side-on view.)
  const hipC = (f) => (f.lm[23].x + f.lm[24].x) / 2;
  const torso = Math.hypot(set[S.sh].x - set[S.hip].x, set[S.sh].y - set[S.hip].y) || 1;
  const drift = Math.abs(hipC(frames[frames.length - 1]) - hipC(frames[dipI])) / torso;

  return {
    releaseIndex: releaseI,
    dipIndex: dipI,
    setIndex: setI,
    kneeDip: minKnee,
    elbowAtSet,
    elbowAtRelease,
    elbowFlare,
    followThroughMs,
    balanceDrift: drift,
    dipToReleaseMs: frames[releaseI].t - frames[dipI].t,
  };
}

/** Score 0–100 for one value against a target band, with linear fall-off. */
export function bandScore(v, lo, hi, falloff) {
  if (v == null || Number.isNaN(v)) return 50;
  if (v >= lo && v <= hi) return 100;
  const d = v < lo ? lo - v : v - hi;
  return Math.max(0, 100 - (d / falloff) * 100);
}

/**
 * Shot Quality Score (0–100). Weighs mechanics, arc and balance, then adjusts for
 * difficulty (distance and how off-balance the shot was).
 */
export function shotQuality({ arc, form, distanceM }) {
  const arcS = bandScore(arc, IDEAL_ARC.min, IDEAL_ARC.max, 15);
  const elbowS = form ? bandScore(form.elbowFlare, 0, 0.25, 0.5) : 50;
  const dipS = form ? bandScore(form.kneeDip, 110, 145, 35) : 50;
  const ftS = form ? bandScore(form.followThroughMs, 250, 2000, 250) : 50;
  const balS = form ? bandScore(form.balanceDrift, 0, 0.12, 0.35) : 50;
  const mechanics = 0.3 * arcS + 0.2 * elbowS + 0.15 * dipS + 0.15 * ftS + 0.2 * balS;
  const difficulty = shotDifficulty(distanceM, form?.balanceDrift ?? 0);
  return {
    score: Math.round(mechanics),
    difficulty,
    parts: { arc: arcS, elbow: elbowS, dip: dipS, followThrough: ftS, balance: balS },
  };
}

/** Difficulty 1–5 from distance to the rim and balance drift. */
export function shotDifficulty(distanceM = 4, drift = 0) {
  let d = 1;
  if (distanceM > 2) d++;
  if (distanceM > 4.5) d++;
  if (distanceM > 6.75) d++; // beyond the FIBA three-point line
  if (drift > 0.25) d++;
  return Math.min(5, d);
}

/** Zone label for the shot chart. */
export function shotZone(distanceM, lateralM) {
  if (distanceM <= 1.6) return 'Restricted';
  if (distanceM <= 4.5) return 'Paint / short';
  if (distanceM <= 6.75) return Math.abs(lateralM) > 4.5 ? 'Baseline mid' : 'Mid-range';
  return Math.abs(lateralM) > 6.3 ? 'Corner three' : 'Above the break';
}

/**
 * Choose the single most useful spoken cue for a shot.
 * Returns { text, key }, where key lets the coach avoid repeating itself.
 */
export function pickCue({ arc, speed, form, made }) {
  const cues = [];
  if (arc != null) {
    if (arc < IDEAL_ARC.min - 3) cues.push({ p: 3, key: 'arc-low', text: `Arc ${Math.round(arc)}°. Add power and lift it higher.` });
    else if (arc > IDEAL_ARC.max + 6) cues.push({ p: 2, key: 'arc-high', text: `Arc ${Math.round(arc)}°. Flatten it slightly.` });
  }
  if (form) {
    if (form.elbowFlare > 0.4) cues.push({ p: 3, key: 'elbow', text: 'Tuck the elbow. Keep it under the ball.' });
    if (form.kneeDip > 155) cues.push({ p: 2, key: 'legs', text: 'Use your legs. Deeper dip.' });
    if (form.elbowAtRelease < 150) cues.push({ p: 2, key: 'release', text: 'Higher release. Extend fully.' });
    if (form.followThroughMs < 200) cues.push({ p: 2, key: 'follow', text: 'Hold the follow-through.' });
    if (form.balanceDrift > 0.25) cues.push({ p: 2, key: 'balance', text: 'Land where you took off. Stay balanced.' });
  }
  if (speed != null && speed > 0 && speed < 5.5 && !cues.some((c) => c.key === 'arc-low')) {
    cues.push({ p: 1, key: 'power', text: 'Short on power. Drive up through the shot.' });
  }
  if (!cues.length) {
    return made
      ? { key: 'good-make', text: arc != null ? `Good shot. Arc ${Math.round(arc)}°.` : 'Good shot.' }
      : { key: 'good-miss', text: 'Good form. Same again.' };
  }
  cues.sort((a, b) => b.p - a.p);
  return { key: cues[0].key, text: cues[0].text };
}

/** Summary stats across a session. */
export function sessionSummary(shots) {
  const n = shots.length;
  if (!n) return { attempts: 0, makes: 0, pct: 0, avgArc: null, avgScore: null, arcSd: null };
  const makes = shots.filter((s) => s.made).length;
  const arcs = shots.map((s) => s.arc).filter((a) => a != null);
  const avgArc = arcs.length ? arcs.reduce((a, b) => a + b, 0) / arcs.length : null;
  const arcSd = arcs.length > 1
    ? Math.sqrt(arcs.reduce((a, b) => a + (b - avgArc) ** 2, 0) / (arcs.length - 1))
    : null;
  const avgScore = shots.reduce((a, s) => a + (s.score ?? 0), 0) / n;
  return { attempts: n, makes, pct: Math.round((makes / n) * 100), avgArc, avgScore, arcSd };
}
