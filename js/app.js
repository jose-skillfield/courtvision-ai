import { PoseTracker, drawSkeleton, bodyHeightPx } from './pose.js';
import { BallTracker, cleanTrack, passedThroughHoop } from './ball.js';
import { VoiceCoach } from './coach.js';
import { simulateShot, makeProfile, SPOTS, WORLD } from './simulator.js';
import {
  analyseForm, launchAngle, releaseSpeed, shotQuality, shotZone, pickCue, sessionSummary, jointAngle, IDEAL_ARC,
} from './metrics.js';
import { drawCourt } from './court.js';
import { loadSessions, saveSession, clearSessions, loadSettings, saveSettings } from './storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------- state
const settings = loadSettings({ hand: 'right', heightCm: 180, voice: 'every', overlay: 'on' });
const coach = new VoiceCoach();
const pose = new PoseTracker();
const ballTracker = new BallTracker();

let session = null;          // { id, startedAt, mode, shots: [] }
const shotMedia = new Map(); // shot id → { frames, track, hoop, world, live }
let running = null;          // { mode, stop() }
let hoop = null;             // live-mode rim position in video px
let selectedShotId = null;

const sideIdx = (hand) => (hand === 'left'
  ? { sh: 11, el: 13, wr: 15, idx: 19, hip: 23, kn: 25, an: 27 }
  : { sh: 12, el: 14, wr: 16, idx: 20, hip: 24, kn: 26, an: 28 });

// ---------------------------------------------------------------- navigation
function navigate(view) {
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  document.body.classList.toggle('practicing', view === 'practice');
  if (view === 'chart') renderChart();
  if (view === 'form') renderForm();
  if (view === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.nav === 'practice' && !running) return startSession('demo');
  navigate(b.dataset.nav);
}));
$$('[data-start]').forEach((b) => b.addEventListener('click', () => startSession(b.dataset.start)));

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------------------------------------------------------------- practice controls
const spotSelect = $('#spotSelect');
SPOTS.forEach((s) => spotSelect.append(new Option(s.label, s.id)));
spotSelect.value = 'top';
const distRange = $('#distRange');
const showDist = () => ($('#distOut').textContent = `${Number(distRange.value).toFixed(2).replace(/0$/, '')} m`);
distRange.addEventListener('input', showDist);
showDist();

$('#voiceBtn').addEventListener('click', (e) => {
  coach.enabled = !coach.enabled;
  e.currentTarget.textContent = coach.enabled ? 'Voice on' : 'Voice off';
  e.currentTarget.setAttribute('aria-pressed', String(coach.enabled));
});
$('#endBtn').addEventListener('click', () => endSession());
$('#openBreakdown').addEventListener('click', () => {
  selectedShotId = session?.shots.at(-1)?.id ?? null;
  navigate('form');
});
$$('#lastShot .seg button').forEach((b) => b.addEventListener('click', () => {
  const s = session?.shots.at(-1);
  if (!s) return;
  s.made = b.dataset.made === 'true';
  s.confirmed = true;
  renderLastShot(s);
  updateHud();
  persist();
}));

// ---------------------------------------------------------------- session lifecycle
async function startSession(mode) {
  coach.unlock();
  stopRunning();
  session = { id: `s${Date.now()}`, startedAt: Date.now(), mode, shots: [] };
  shotMedia.clear();
  $('#lastShot').hidden = true;
  setCue('');
  navigate('practice');
  updateHud();
  const pill = $('#modePill');
  pill.textContent = mode === 'demo' ? 'DEMO' : 'LIVE';
  pill.className = `pill ${mode === 'demo' ? 'pill-demo' : 'pill-live'}`;
  $('#distField').hidden = mode === 'demo';
  if (mode === 'demo') return runDemo();
  try {
    await runLive();
  } catch (err) {
    console.error(err);
    toast(cameraErrorMessage(err), 4200);
    runDemo();
  }
}

function cameraErrorMessage(err) {
  if (err?.name === 'NotAllowedError') return 'Camera access was blocked, so we switched to demo mode.';
  if (err?.name === 'NotFoundError') return 'No camera found, so we switched to demo mode.';
  return 'Live tracking could not start, so we switched to demo mode.';
}

function stopRunning() {
  running?.stop();
  running = null;
}

function endSession() {
  stopRunning();
  persist();
  if (session?.shots.length) {
    const sum = sessionSummary(session.shots);
    coach.say(`Session done. ${sum.makes} of ${sum.attempts}. Average quality ${Math.round(sum.avgScore)}.`, 'end', { force: true });
    navigate('chart');
  } else {
    navigate('home');
  }
}

function persist() {
  if (!session?.shots.length) return;
  saveSession({
    id: session.id, startedAt: session.startedAt, mode: session.mode,
    shots: session.shots.map(({ id, t, made, arc, speed, score, difficulty, distanceM, angle, zone, spot, form }) =>
      ({ id, t, made, arc, speed, score, difficulty, distanceM, angle, zone, spot, form })),
  });
}

// ---------------------------------------------------------------- shot processing (shared)
function processShot({ frames, track, hoop: rim, pxPerMetre, world, distanceM, spot, live, hand }) {
  const form = frames.length > 5 ? analyseForm(frames, hand) : null;
  const flight = track.slice(0, Math.min(10, track.length));
  const arc = flight.length >= 4 ? launchAngle(flight) : null;
  const speed = flight.length >= 3 ? releaseSpeed(flight, pxPerMetre) : null;
  const madeAuto = passedThroughHoop(track, rim);
  const made = madeAuto ?? false;
  const q = shotQuality({ arc, form, distanceM });
  const spotDef = SPOTS.find((s) => s.id === spot) || SPOTS[2];
  const angle = spotDef.angle + (Math.random() * 10 - 5); // spread dots so repeated spots stay readable
  const lateral = Math.cos((angle * Math.PI) / 180) * distanceM;
  const shot = {
    id: `${session.id}-${session.shots.length + 1}`,
    n: session.shots.length + 1,
    t: Date.now(),
    made, confirmed: madeAuto != null,
    arc, speed, form,
    score: q.score, difficulty: q.difficulty, parts: q.parts,
    distanceM, angle, spot, zone: shotZone(distanceM, lateral),
  };
  session.shots.push(shot);
  shotMedia.set(shot.id, { frames, track, hoop: rim, world, live, hand });
  trimMedia();

  const cue = pickCue({ arc, speed, form, made });
  const voiceMode = settings.voice;
  if (voiceMode === 'every' || (voiceMode === 'misses' && !made)) coach.say(cue.text, cue.key);
  setCue(cue.text);
  updateHud();
  renderLastShot(shot);
  persist();
  return shot;
}

/** Keep video frames for the 12 most recent shots only. */
function trimMedia() {
  const ids = [...shotMedia.keys()];
  for (const id of ids.slice(0, Math.max(0, ids.length - 12))) {
    shotMedia.get(id).frames.forEach((f) => f.bmp?.close?.());
    shotMedia.delete(id);
  }
}

let cueTimer;
function setCue(text) {
  const c = $('#cue');
  c.textContent = text;
  c.classList.toggle('show', !!text);
  clearTimeout(cueTimer);
  if (text) cueTimer = setTimeout(() => c.classList.remove('show'), 3500);
}

function updateHud() {
  const shots = session?.shots ?? [];
  const sum = sessionSummary(shots);
  const last = shots.at(-1);
  $('#hudMakes').textContent = `${sum.makes}/${sum.attempts}`;
  $('#hudArc').textContent = last?.arc != null ? `${Math.round(last.arc)}°` : '–';
  $('#hudSpeed').textContent = last?.speed != null ? `${last.speed.toFixed(1)} m/s` : '–';
  $('#hudScore').textContent = last ? String(last.score) : '–';
}

function status(text) { $('#statusPill').textContent = text; }

// ---------------------------------------------------------------- metric presentation
const fmt = {
  arc: (v) => (v == null ? '–' : `${Math.round(v)}°`),
  ms: (v) => `${Math.round(v)} ms`,
  deg: (v) => `${Math.round(v)}°`,
};

function grade(kind, v) {
  if (v == null) return 'warn';
  switch (kind) {
    case 'arc': return v >= IDEAL_ARC.min && v <= IDEAL_ARC.max ? 'good' : Math.abs(v - 48.5) < 9 ? 'warn' : 'bad';
    case 'flare': return v <= 0.25 ? 'good' : v <= 0.4 ? 'warn' : 'bad';
    case 'knee': return v >= 110 && v <= 145 ? 'good' : v <= 155 ? 'warn' : 'bad';
    case 'release': return v >= 160 ? 'good' : v >= 150 ? 'warn' : 'bad';
    case 'follow': return v >= 250 ? 'good' : v >= 200 ? 'warn' : 'bad';
    case 'balance': return v <= 0.12 ? 'good' : v <= 0.25 ? 'warn' : 'bad';
    default: return 'good';
  }
}

function renderLastShot(s) {
  $('#lastShot').hidden = false;
  $$('#lastShot .seg button').forEach((b) => b.classList.toggle('on', String(s.made) === b.dataset.made));
  const m = (label, value, cls = '') => `<div class="metric ${cls}"><b>${value}</b><span>${label}</span></div>`;
  $('#lastShotMetrics').innerHTML = [
    m('Quality', s.score, s.score >= 80 ? 'good' : s.score >= 60 ? 'warn' : 'bad'),
    m('Arc', fmt.arc(s.arc), grade('arc', s.arc)),
    m('Release', s.speed != null ? `${s.speed.toFixed(1)} m/s` : '–'),
    m('Difficulty', `${s.difficulty}/5`),
    m('Zone', s.zone),
    s.form ? m('Knee dip', fmt.deg(s.form.kneeDip), grade('knee', s.form.kneeDip)) : '',
    !s.confirmed ? m('Result', 'Tap Make or Miss', 'warn') : '',
  ].join('');
}

// ---------------------------------------------------------------- demo mode
function runDemo() {
  status('Demo: simulated shooter');
  const video = $('#video');
  video.hidden = true;
  const canvas = $('#overlay');
  canvas.width = WORLD.w; canvas.height = WORLD.h;
  const ctx = canvas.getContext('2d');
  $('#hoopHint').hidden = true;
  const profile = makeProfile();
  profile.height = settings.heightCm / 100;
  let stopped = false, raf = 0, timer = 0;

  const playShot = () => {
    if (stopped) return;
    const spot = spotSelect.value;
    const data = simulateShot(profile, { spot });
    const start = performance.now();
    const end = data.track.at(-1).t + 300;
    const tick = (now) => {
      if (stopped) return;
      const t = now - start;
      drawScene(ctx, data, t, { trail: true });
      if (t < end) { raf = requestAnimationFrame(tick); return; }
      processShot({ ...data, live: false, hand: 'right' });
      timer = setTimeout(playShot, 1600);
    };
    raf = requestAnimationFrame(tick);
  };
  timer = setTimeout(playShot, 600);
  running = { mode: 'demo', stop() { stopped = true; cancelAnimationFrame(raf); clearTimeout(timer); } };
}

/** Draws a simulated court scene at time t (ms since shot start). */
function drawScene(ctx, data, t, { trail = false, frameIndex = null, highlight = [], annotate = null, skeletonWidth = 6 } = {}) {
  const { w, h } = data.world;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0c1626'); g.addColorStop(1, '#1c2c44');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // Floor
  ctx.fillStyle = '#27395a'; ctx.fillRect(0, WORLD.ground, w, h - WORLD.ground);
  ctx.strokeStyle = 'rgba(76,217,237,.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, WORLD.ground); ctx.lineTo(w, WORLD.ground); ctx.stroke();
  // Hoop and stanchion
  const { hoop } = data;
  ctx.strokeStyle = '#9aa6b8'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(hoop.x + hoop.r + 26, hoop.y - 70); ctx.lineTo(hoop.x + hoop.r + 26, WORLD.ground); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(hoop.x + hoop.r + 14, hoop.y - 70, 8, 90);
  ctx.strokeStyle = '#da7f27'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(hoop.x - hoop.r, hoop.y); ctx.lineTo(hoop.x + hoop.r + 14, hoop.y); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1.5;
  for (let i = 0; i <= 4; i++) {
    const x = hoop.x - hoop.r + (i * 2 * hoop.r) / 4;
    ctx.beginPath(); ctx.moveTo(x, hoop.y); ctx.lineTo(hoop.x + (x - hoop.x) * 0.6, hoop.y + 34); ctx.stroke();
  }

  const fi = frameIndex ?? Math.min(data.frames.length - 1, Math.max(0, Math.round(t / (1000 / 30))));
  const frame = data.frames[fi];
  drawSkeleton(ctx, frame.lm, { width: skeletonWidth, highlight });
  if (annotate) annotate(ctx, frame.lm);

  // Ball: in hand before release, then follows its flight.
  const tt = frameIndex != null ? frame.t : t;
  const releaseT = data.track[0].t;
  const r = data.track[0].r;
  let ball;
  if (tt < releaseT) {
    const lm = frame.lm;
    ball = { x: (lm[16].x + lm[20].x) / 2 + r * 0.6, y: (lm[16].y + lm[20].y) / 2 - r * 0.8 };
  } else {
    ball = data.track.find((p) => p.t >= tt) || data.track.at(-1);
    if (trail) {
      ctx.fillStyle = 'rgba(76,217,237,.5)';
      for (const p of data.track) { if (p.t > tt) break; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  drawBall(ctx, ball.x, ball.y, r);
}

function drawBall(ctx, x, y, r) {
  ctx.fillStyle = '#da7f27';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(19,31,49,.6)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
}

// ---------------------------------------------------------------- live mode
async function runLive() {
  status('Requesting camera…');
  const video = $('#video');
  video.hidden = false;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  await pose.load(status);
  status('Tracking');

  const canvas = $('#overlay');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  $('#hoopHint').hidden = !!hoop;

  const S = sideIdx(settings.hand);
  const buffer = [];       // { t, lm, ball, bmp }
  const keep = new Set();  // frames claimed by a finished shot (don't close their bitmaps)
  let state = 'idle', peakY = 0, peakT = 0, releaseT = 0, until = 0;
  let pxPerMetre = null;
  let stopped = false, raf = 0;

  const onTap = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const ox = (rect.width - canvas.width * scale) / 2, oy = (rect.height - canvas.height * scale) / 2;
    const x = (e.clientX - rect.left - ox) / scale, y = (e.clientY - rect.top - oy) / scale;
    hoop = { x, y, r: pxPerMetre ? pxPerMetre * 0.2 : canvas.width * 0.03 };
    $('#hoopHint').hidden = true;
    toast('Rim set. Makes and misses will be tagged automatically.');
  };
  canvas.addEventListener('click', onTap);

  const loop = () => {
    if (stopped) return;
    const t = performance.now();
    const lm = pose.detect(video, t);
    const ball = ballTracker.detect(video);
    const entry = { t, lm, ball, bmp: null };
    buffer.push(entry);
    createImageBitmap(video, { resizeWidth: 384, resizeHeight: Math.round(384 * video.videoHeight / video.videoWidth) })
      .then((b) => { if (stopped) b.close(); else entry.bmp = b; })
      .catch(() => {});
    while (buffer.length && t - buffer[0].t > 3500) {
      const old = buffer.shift();
      if (!keep.has(old)) old.bmp?.close();
    }

    if (lm) {
      const bh = bodyHeightPx(lm);
      if (bh > 50) {
        const est = bh / (settings.heightCm / 100);
        pxPerMetre = pxPerMetre ? pxPerMetre * 0.95 + est * 0.05 : est;
        if (hoop) hoop.r = pxPerMetre * 0.2;
      }
      // Shot detection state machine: wrist rises above the head → peak → release.
      const wr = lm[S.wr], nose = lm[0];
      if (state === 'idle' && bh && wr.y < nose.y - 0.04 * bh) {
        state = 'rising'; peakY = wr.y; peakT = t; status('Shot detected');
      } else if (state === 'rising') {
        if (wr.y < peakY) { peakY = wr.y; peakT = t; }
        if (t - peakT > 220) { state = 'flight'; releaseT = peakT; until = t + 1500; }
      }
    }
    if (state === 'flight' && t > until) {
      finishLiveShot(buffer, keep, releaseT, pxPerMetre);
      state = 'cooldown'; until = t + 700; status('Tracking');
    } else if (state === 'cooldown' && t > until) {
      state = 'idle';
    }

    drawLiveOverlay(ctx, canvas, lm, buffer, state);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  running = {
    mode: 'live',
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('click', onTap);
      stream.getTracks().forEach((tr) => tr.stop());
      buffer.forEach((f) => { if (!keep.has(f)) f.bmp?.close(); });
      video.srcObject = null;
    },
  };
}

function finishLiveShot(buffer, keep, releaseT, pxPerMetre) {
  const video = $('#video');
  const frames = buffer
    .filter((f) => f.lm && f.t >= releaseT - 1300 && f.t <= releaseT + 900)
    .map((f) => { keep.add(f); return { t: f.t, lm: f.lm, bmp: f.bmp }; });
  const raw = buffer
    .filter((f) => f.ball && f.t >= releaseT - 80 && f.t <= releaseT + 1500)
    .map((f) => ({ x: f.ball.x, y: f.ball.y, r: f.ball.r, t: f.t }));
  const track = cleanTrack(raw, (pxPerMetre || video.videoWidth / 8) * 0.6);
  const lastLm = frames.at(-1)?.lm;
  const S = sideIdx(settings.hand);
  const distanceM = hoop && lastLm && pxPerMetre
    ? Math.abs(hoop.x - lastLm[S.an].x) / pxPerMetre
    : Number(distRange.value);
  processShot({
    frames, track, hoop, pxPerMetre,
    world: { w: video.videoWidth, h: video.videoHeight },
    distanceM, spot: spotSelect.value, live: true, hand: settings.hand,
  });
}

function drawLiveOverlay(ctx, canvas, lm, buffer, state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (settings.overlay === 'on' && lm) drawSkeleton(ctx, lm, { width: Math.max(2, canvas.width / 320), color: state === 'idle' ? '#4cd9ed' : '#fdb715' });
  // Ball trail for the last second.
  const now = buffer.at(-1)?.t ?? 0;
  ctx.fillStyle = 'rgba(253,183,21,.9)';
  for (const f of buffer) {
    if (!f.ball || now - f.t > 1000) continue;
    ctx.beginPath(); ctx.arc(f.ball.x, f.ball.y, Math.max(3, canvas.width / 260), 0, Math.PI * 2); ctx.fill();
  }
  if (hoop) {
    ctx.strokeStyle = '#4cd9ed'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.ellipse(hoop.x, hoop.y, hoop.r, hoop.r * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------------------------------------------------------------- chart view
function allShots() {
  return session?.shots ?? [];
}

function renderChart() {
  const shots = allShots();
  const sum = sessionSummary(shots);
  const kpi = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
  $('#kpis').innerHTML = [
    kpi(shots.length ? `${sum.pct}%` : '–', `Field goal · ${sum.makes}/${sum.attempts}`),
    kpi(sum.avgScore != null ? Math.round(sum.avgScore) : '–', 'Avg shot quality'),
    kpi(sum.avgArc != null ? `${Math.round(sum.avgArc)}°` : '–', 'Avg arc'),
    kpi(sum.arcSd != null ? `±${sum.arcSd.toFixed(1)}°` : '–', 'Arc consistency'),
  ].join('');
  drawCourt($('#court'), shots, (s) => { selectedShotId = s.id; navigate('form'); });

  const zones = {};
  for (const s of shots) {
    const z = (zones[s.zone] ||= { a: 0, m: 0, q: 0 });
    z.a++; z.m += s.made ? 1 : 0; z.q += s.score;
  }
  const rows = Object.entries(zones).sort((a, b) => b[1].a - a[1].a);
  $('#zoneTable').innerHTML = rows.length
    ? `<tr><th>Zone</th><th>FG</th><th>%</th><th>Quality</th></tr>` + rows.map(([name, z]) => {
      const pct = Math.round((z.m / z.a) * 100);
      return `<tr><td>${name}</td><td>${z.m}/${z.a}</td><td><div class="bar"><i style="width:${pct}%"></i></div> ${pct}%</td><td>${Math.round(z.q / z.a)}</td></tr>`;
    }).join('')
    : '<tr><td class="muted">No shots yet. Start a session or try demo mode.</td></tr>';

  const log = $('#shotLog');
  log.replaceChildren(...shots.slice().reverse().map((s) => {
    const b = document.createElement('button');
    b.className = 'log-item';
    b.innerHTML = `<i class="dot ${s.made ? 'dot-make' : 'dot-miss'}"></i>
      <span>#${s.n} · ${s.zone} · ${s.distanceM.toFixed(1)} m<small>Arc ${fmt.arc(s.arc)} · Difficulty ${s.difficulty}/5</small></span>
      <span class="score-badge">Q${s.score}</span>`;
    b.addEventListener('click', () => { selectedShotId = s.id; navigate('form'); });
    return b;
  }));
}

// ---------------------------------------------------------------- form breakdown view
const frameCanvas = $('#frameCanvas');
const fctx = frameCanvas.getContext('2d');
const scrub = $('#scrub');
let formFocus = 'set';
let playTimer = 0;

function renderForm() {
  const shots = allShots().filter((s) => shotMedia.has(s.id));
  $('#formEmpty').hidden = shots.length > 0;
  $('#formBody').hidden = shots.length === 0;
  if (!shots.length) return;
  if (!shots.some((s) => s.id === selectedShotId)) selectedShotId = shots.at(-1).id;

  const picker = $('#shotPicker');
  picker.replaceChildren(...shots.map((s) => {
    const b = document.createElement('button');
    b.textContent = `#${s.n} ${s.made ? 'Make' : 'Miss'} · Q${s.score}`;
    b.classList.toggle('on', s.id === selectedShotId);
    b.addEventListener('click', () => { selectedShotId = s.id; renderForm(); });
    return b;
  }));

  const shot = shots.find((s) => s.id === selectedShotId);
  const media = shotMedia.get(shot.id);
  frameCanvas.width = media.world.w; frameCanvas.height = media.world.h;
  scrub.max = String(media.frames.length - 1);
  $('#formTitle').textContent = `Shot #${shot.n}: ${shot.zone}, ${shot.distanceM.toFixed(1)} m`;
  jumpTo(formFocus);
  renderChecks(shot);
  renderConsistency();
}

function keyIndex(form, key, n) {
  if (!form) return 0;
  return {
    dip: form.dipIndex,
    set: form.setIndex,
    release: form.releaseIndex,
    follow: Math.min(n - 1, form.releaseIndex + 8),
  }[key];
}

function jumpTo(key) {
  formFocus = key;
  $$('#keyChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.key === key));
  const shot = allShots().find((s) => s.id === selectedShotId);
  const media = shotMedia.get(selectedShotId);
  if (!shot || !media) return;
  scrub.value = String(keyIndex(shot.form, key, media.frames.length));
  drawFrame();
}
$$('#keyChips .chip').forEach((c) => c.addEventListener('click', () => jumpTo(c.dataset.key)));
scrub.addEventListener('input', () => drawFrame());
$('#playBtn').addEventListener('click', () => {
  if (playTimer) { clearInterval(playTimer); playTimer = 0; return; }
  const max = Number(scrub.max);
  if (Number(scrub.value) >= max) scrub.value = '0';
  playTimer = setInterval(() => {
    const v = Number(scrub.value) + 1;
    if (v > max || $('#view-form').hidden) { clearInterval(playTimer); playTimer = 0; return; }
    scrub.value = String(v);
    drawFrame();
  }, 66); // half speed
});

const FOCUS = {
  dip: (S) => ({ joints: [S.hip, S.kn, S.an], angle: [S.hip, S.kn, S.an], label: 'Knee' }),
  set: (S) => ({ joints: [S.sh, S.el, S.wr], angle: [S.sh, S.el, S.wr], label: 'Elbow', plumb: true }),
  release: (S) => ({ joints: [S.sh, S.el, S.wr], angle: [S.sh, S.el, S.wr], label: 'Extension' }),
  follow: (S) => ({ joints: [S.el, S.wr, S.idx], angle: [S.el, S.wr, S.idx], label: 'Wrist' }),
};

function drawFrame() {
  const media = shotMedia.get(selectedShotId);
  if (!media) return;
  const i = Number(scrub.value);
  const frame = media.frames[i];
  $('#frameNo').textContent = `${i + 1}/${media.frames.length}`;
  const S = sideIdx(media.hand);
  const f = FOCUS[formFocus](S);
  const lineW = Math.max(3, media.world.w / 220);
  const annotate = (ctx, lm, zs = 1) => {
    const [a, b, c] = f.angle;
    const ang = jointAngle(lm[a], lm[b], lm[c]);
    if (f.plumb) {
      // Vertical guide through the wrist: a tucked elbow sits on this line, under the ball.
      ctx.save(); ctx.setLineDash([10 / zs, 8 / zs]); ctx.strokeStyle = 'rgba(76,217,237,.8)'; ctx.lineWidth = (lineW * 0.6) / zs;
      ctx.beginPath(); ctx.moveTo(lm[S.wr].x, lm[S.wr].y - 60 / zs); ctx.lineTo(lm[S.wr].x, lm[S.sh].y + 40 / zs); ctx.stroke(); ctx.restore();
    }
    const fs = Math.max(16, media.world.w / 40) / zs;
    ctx.font = `700 ${fs}px Poppins, sans-serif`;
    const text = `${f.label} ${Math.round(ang)}°`;
    const tw = ctx.measureText(text).width;
    const x = lm[b].x + fs, y = lm[b].y - fs * 0.6;
    ctx.fillStyle = 'rgba(19,31,49,.85)';
    ctx.beginPath(); ctx.roundRect(x - fs * 0.4, y - fs, tw + fs * 0.8, fs * 1.45, fs * 0.7); ctx.fill();
    ctx.fillStyle = '#fdb715'; ctx.fillText(text, x, y + fs * 0.12);
  };

  // Zoom onto the shooter so joints are readable, whatever the shooting distance.
  const z = media.zoom ||= playerZoom(media);
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.fillStyle = '#131f31';
  fctx.fillRect(0, 0, frameCanvas.width, frameCanvas.height);
  fctx.setTransform(z.s, 0, 0, z.s, -z.x * z.s, -z.y * z.s);
  const zw = Math.max(2, lineW / z.s);
  if (media.live) {
    if (frame.bmp) fctx.drawImage(frame.bmp, 0, 0, frameCanvas.width, frameCanvas.height);
    drawSkeleton(fctx, frame.lm, { width: zw, highlight: f.joints });
  } else {
    drawScene(fctx, media, 0, { frameIndex: i, highlight: f.joints, trail: true, skeletonWidth: zw });
  }
  annotate(fctx, frame.lm, z.s);
  fctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Crop box around the player across all frames, matched to the canvas aspect ratio. */
function playerZoom(media) {
  const { w, h } = media.world;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const fr of media.frames) {
    for (const i of [0, 11, 12, 15, 16, 19, 20, 27, 28, 31, 32]) {
      const p = fr.lm[i];
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
  }
  const pad = (y1 - y0) * 0.18;
  let bw = x1 - x0 + pad * 2, bh = y1 - y0 + pad * 2;
  if (bw / bh < w / h) bw = (bh * w) / h; else bh = (bw * h) / w;
  const s = Math.min(4, w / bw);
  bw = w / s; bh = h / s;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { s, x: Math.min(Math.max(0, cx - bw / 2), w - bw), y: Math.min(Math.max(0, cy - bh / 2), h - bh) };
}

function renderChecks(shot) {
  const f = shot.form;
  if (!f) { $('#formChecks').innerHTML = '<div class="empty">We could not see your full body for this shot. Step back so your head and feet are in frame.</div>'; return; }
  const card = (title, tag, value, kind, v, good, fix) => {
    const g = grade(kind, v);
    return `<div class="check ${g}"><h4>${title}<em>${tag}</em></h4><div class="val">${value}</div><p>${g === 'good' ? good : fix}</p></div>`;
  };
  $('#formChecks').innerHTML = [
    card('Arc', 'Ball flight', fmt.arc(shot.arc), 'arc', shot.arc,
      `Right in the ${IDEAL_ARC.min}–${IDEAL_ARC.max}° window that gives the ball the biggest target.`,
      shot.arc != null && shot.arc < IDEAL_ARC.min ? 'Flat shot. Drive up through your legs and release higher to add arc.' : 'Too much arc. Push the ball more towards the rim.'),
    card('Elbow tuck', 'Set point', `${Math.round(f.elbowFlare * 100)}% off line`, 'flare', f.elbowFlare,
      'Elbow is stacked under the ball at the set point.',
      'Elbow drifts off the line under the ball. Keep it tucked and pointed at the rim.'),
    card('Knee dip', 'Load', fmt.deg(f.kneeDip), 'knee', f.kneeDip,
      'Good load. Your legs are doing the work.',
      f.kneeDip > 145 ? 'Shallow dip. Sit into the shot a little more for repeatable power.' : 'Very deep dip. That costs you time on the release.'),
    card('Release extension', 'Release', fmt.deg(f.elbowAtRelease), 'release', f.elbowAtRelease,
      'Full arm extension at release.',
      'Arm is still bent at release. Finish high, with your elbow above your eye.'),
    card('Follow-through', 'Finish', fmt.ms(f.followThroughMs), 'follow', f.followThroughMs,
      'Wrist snapped and held. Nice "hand in the cookie jar".',
      'Hold the follow-through until the ball hits the rim.'),
    card('Balance', 'Landing', `${Math.round(f.balanceDrift * 100)}% drift`, 'balance', f.balanceDrift,
      'You landed where you took off.',
      'You are drifting through the shot. Land on the same spot you jumped from.'),
  ].join('');
}

function renderConsistency() {
  const forms = allShots().map((s) => s.form).filter(Boolean);
  const el = $('#consistency');
  if (forms.length < 3) {
    el.innerHTML = '<h3>Dip consistency</h3><p class="muted">Take at least 3 shots to see how repeatable your dip and timing are.</p>';
    return;
  }
  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };
  const kneeSd = sd(forms.map((f) => f.kneeDip));
  const timeSd = sd(forms.map((f) => f.dipToReleaseMs));
  const verdict = kneeSd < 6 && timeSd < 60 ? 'Very repeatable. Your shot looks the same every time.'
    : kneeSd < 10 ? 'Fairly consistent. Tighten up your dip depth for a more repeatable shot.'
    : 'Your dip changes from shot to shot. Aim for the same depth and rhythm every time.';
  el.innerHTML = `<h3>Dip consistency</h3>
    <div class="metric-row">
      <div class="metric ${kneeSd < 6 ? 'good' : kneeSd < 10 ? 'warn' : 'bad'}"><b>±${kneeSd.toFixed(1)}°</b><span>Knee dip variation</span></div>
      <div class="metric ${timeSd < 60 ? 'good' : timeSd < 110 ? 'warn' : 'bad'}"><b>±${Math.round(timeSd)} ms</b><span>Dip-to-release timing</span></div>
      <div class="metric"><b>${forms.length}</b><span>Shots analysed</span></div>
    </div><p>${verdict}</p>`;
}

// ---------------------------------------------------------------- history view
function renderHistory() {
  const sessions = loadSessions();
  const list = $('#sessionList');
  if (!sessions.length) {
    list.innerHTML = '<div class="empty">Your finished sessions will show up here.</div>';
  } else {
    list.innerHTML = sessions.slice().reverse().map((s) => {
      const sum = sessionSummary(s.shots);
      const d = new Date(s.startedAt);
      return `<div class="card session"><div><h3>${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}</h3>
        <small>${s.mode === 'demo' ? 'Demo' : 'Live'} · ${sum.attempts} shots · avg arc ${sum.avgArc != null ? Math.round(sum.avgArc) + '°' : '–'}</small></div>
        <div><span class="score-badge">${sum.pct}%</span> <small>FG</small><br><span class="score-badge">Q${Math.round(sum.avgScore)}</span></div></div>`;
    }).join('');
  }
  drawTrend($('#trendCanvas'), sessions.slice(-12));
}

function drawTrend(canvas, sessions) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = 220;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 36, r: 12, t: 28, b: 24 };
  ctx.font = '600 12px "Open Sans", sans-serif';
  ctx.fillStyle = '#6b7889';
  ctx.strokeStyle = '#e1e6ee'; ctx.lineWidth = 1;
  for (let v = 0; v <= 100; v += 25) {
    const y = pad.t + (1 - v / 100) * (h - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(String(v), 6, y + 4);
  }
  if (sessions.length < 2) {
    ctx.fillText('Complete two or more sessions to see your trend.', pad.l + 8, h / 2);
    return;
  }
  const series = [
    { key: 'pct', color: '#4cd9ed', label: 'FG %' },
    { key: 'avgScore', color: '#124e91', label: 'Avg quality' },
  ];
  const sums = sessions.map((s) => sessionSummary(s.shots));
  const x = (i) => pad.l + (i / (sums.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / 100) * (h - pad.t - pad.b);
  series.forEach((s, k) => {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2.5; ctx.beginPath();
    sums.forEach((m, i) => (i ? ctx.lineTo(x(i), y(m[s.key])) : ctx.moveTo(x(i), y(m[s.key]))));
    ctx.stroke();
    ctx.fillStyle = s.color;
    sums.forEach((m, i) => { ctx.beginPath(); ctx.arc(x(i), y(m[s.key]), 3.5, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillRect(pad.l + k * 110, 8, 12, 3);
    ctx.fillStyle = '#364150'; ctx.fillText(s.label, pad.l + k * 110 + 18, 13);
  });
}

// ---------------------------------------------------------------- settings
const dlg = $('#settings');
$('#settingsBtn').addEventListener('click', () => {
  $('#setHand').value = settings.hand;
  $('#setHeight').value = settings.heightCm;
  $('#setVoice').value = settings.voice;
  $('#setOverlay').value = settings.overlay;
  dlg.showModal();
});
dlg.addEventListener('close', () => {
  settings.hand = $('#setHand').value;
  settings.heightCm = Math.min(230, Math.max(120, Number($('#setHeight').value) || 180));
  settings.voice = $('#setVoice').value;
  settings.overlay = $('#setOverlay').value;
  coach.enabled = settings.voice !== 'off';
  saveSettings(settings);
});
$('#clearData').addEventListener('click', () => {
  if (confirm('Clear all saved sessions on this device?')) { clearSessions(); toast('History cleared'); }
});
coach.enabled = settings.voice !== 'off';

// ---------------------------------------------------------------- PWA
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

navigate('home');
