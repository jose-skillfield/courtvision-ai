// Demo mode: generates realistic synthetic shots (pose frames + ball flight) so the full
// analysis, coaching and charting pipeline can be tried without a court or camera.

const G = 9.81;
export const WORLD = { w: 1280, h: 720, ground: 640 };
const RIM_HEIGHT = 3.05;
const FPS = 30;

const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const rad = (d) => (d * Math.PI) / 180;

export const SPOTS = [
  { id: 'lc', label: 'Left corner', angle: 172 },
  { id: 'lw', label: 'Left wing', angle: 135 },
  { id: 'top', label: 'Top of key', angle: 90 },
  { id: 'rw', label: 'Right wing', angle: 45 },
  { id: 'rc', label: 'Right corner', angle: 8 },
];

/** A random player "tendency" so a demo session has a consistent personality. */
export function makeProfile() {
  return {
    height: 1.83,
    dipKnee: rand(118, 160),
    flare: rand(0.05, 0.55),
    arcBias: rand(-9, 3),
    followHold: rand(0.1, 0.9),
    drift: rand(0, 0.3),
  };
}

export function simulateShot(profile, { distanceM = rand(2.5, 7.5), spot } = {}) {
  const p = {
    dipKnee: profile.dipKnee + rand(-8, 8),
    flare: Math.max(0, profile.flare + rand(-0.12, 0.12)),
    arc: 48 + profile.arcBias + rand(-5, 5),
    followHold: Math.min(1, Math.max(0, profile.followHold + rand(-0.25, 0.25))),
    drift: Math.max(0, profile.drift + rand(-0.1, 0.12)),
  };

  const pxPerM = Math.min(150, 900 / (distanceM + 0.6));
  const M = (m) => m * pxPerM;
  const ankleX = 200;
  const hoop = { x: ankleX + M(distanceM), y: WORLD.ground - M(RIM_HEIGHT), r: M(0.17) };

  const dims = { thigh: 0.45, shin: 0.45, torso: 0.52, neck: 0.2, upper: 0.31, fore: 0.28, hand: 0.09 };
  const frames = [];
  const totalMs = 1900;
  const releaseAt = 0.55;
  let releasePt = null, releaseT = 0;

  for (let t = 0; t <= totalMs; t += 1000 / FPS) {
    const ph = t / totalMs;
    // Knee: stand → dip → extend.
    const knee = ph < 0.3 ? lerp(172, p.dipKnee, ease(ph / 0.3)) : lerp(p.dipKnee, 176, ease((ph - 0.3) / 0.22));
    const legLen = 2 * M(dims.thigh) * Math.sin(rad(knee / 2));
    const driftPx = M(dims.torso) * p.drift * ease((ph - 0.5) / 0.4);
    const hip = { x: ankleX + driftPx, y: WORLD.ground - legLen };
    const kneePt = {
      x: (hip.x + ankleX) / 2 + M(dims.thigh) * Math.cos(rad(knee / 2)),
      y: (hip.y + WORLD.ground) / 2,
    };
    const sh = { x: hip.x + M(0.04), y: hip.y - M(dims.torso) };
    const nose = { x: sh.x + M(0.07), y: sh.y - M(dims.neck) };

    // Arm: upper-arm angle α from hanging (0°) to straight up (180°), elbow angle E.
    let a, e;
    if (ph < 0.3) { a = lerp(35, 45, ph / 0.3); e = lerp(100, 80, ph / 0.3); }
    else if (ph < releaseAt) { const k = ease((ph - 0.3) / (releaseAt - 0.3)); a = lerp(45, 105, k); e = lerp(80, 105, k); }
    else if (ph < 0.62) { const k = ease((ph - releaseAt) / 0.07); a = lerp(105, 158, k); e = lerp(105, 172, k); }
    else { const hold = 0.62 + 0.38 * p.followHold; const k = ease((ph - hold) / 0.2); a = lerp(158, 30, k); e = lerp(172, 160, k); }
    const el = { x: sh.x + M(dims.upper) * Math.sin(rad(a)), y: sh.y - M(dims.upper) * -Math.cos(rad(a)) };
    // Elbow flare: elbow drifts away from the line under the ball around the set point.
    const flareK = ph > 0.35 && ph < 0.62 ? Math.sin(((ph - 0.35) / 0.27) * Math.PI) : 0;
    const b = a + (180 - e);
    const wr = { x: el.x + M(dims.fore) * Math.sin(rad(b)), y: el.y - M(dims.fore) * -Math.cos(rad(b)) };
    el.x -= M(dims.fore) * p.flare * flareK;
    const snapped = ph > 0.6 && ph < 0.62 + 0.38 * p.followHold;
    const g = snapped ? 55 : b + 25;
    const idx = { x: wr.x + M(dims.hand) * Math.sin(rad(g)), y: wr.y - M(dims.hand) * -Math.cos(rad(g)) };

    const lm = Array.from({ length: 33 }, () => ({ x: hip.x, y: hip.y, v: 1 }));
    const back = (pt, dx = -M(0.06)) => ({ x: pt.x + dx, y: pt.y, v: 1 });
    Object.assign(lm, {
      0: nose, 12: sh, 14: el, 16: wr, 20: idx, 24: hip, 26: kneePt, 28: { x: ankleX, y: WORLD.ground },
      32: { x: ankleX + M(0.2), y: WORLD.ground },
      11: back(sh), 13: back(el), 15: back(wr), 19: back(idx), 23: back(hip), 25: back(kneePt),
      27: back({ x: ankleX, y: WORLD.ground }), 31: back({ x: ankleX + M(0.2), y: WORLD.ground }),
    });
    if (!releasePt && ph >= 0.6) { releasePt = { x: wr.x + M(0.08), y: wr.y - M(0.1) }; releaseT = t; }
    frames.push({ t, lm });
  }

  // Ball flight: speed needed to reach the rim at this arc, plus human error.
  const h = RIM_HEIGHT - (WORLD.ground - releasePt.y) / pxPerM;
  const D = (hoop.x - releasePt.x) / pxPerM;
  const th = rad(p.arc);
  const denom = 2 * Math.cos(th) ** 2 * (D * Math.tan(th) - h);
  const vIdeal = denom > 0 ? Math.sqrt((G * D * D) / denom) : 9;
  const formPenalty = p.flare * 0.07 + Math.max(0, p.dipKnee - 150) * 0.002 + (p.followHold < 0.3 ? 0.03 : 0) + p.drift * 0.04;
  const v = vIdeal * (1 + rand(-1, 1) * (0.008 + formPenalty * 0.6));

  const track = [];
  for (let k = 0; k < 120; k++) {
    const s = k / FPS;
    const x = releasePt.x + M(v * Math.cos(th) * s);
    const y = releasePt.y - M(v * Math.sin(th) * s - 0.5 * G * s * s);
    if (y > WORLD.ground || x > WORLD.w + 40) break;
    track.push({ x, y, t: releaseT + s * 1000, r: M(0.12) });
  }

  return {
    frames,
    track,
    hoop,
    pxPerMetre: pxPerM,
    world: { w: WORLD.w, h: WORLD.h },
    distanceM,
    spot: spot || SPOTS[Math.floor(Math.random() * SPOTS.length)].id,
  };
}
