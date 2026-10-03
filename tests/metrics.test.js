import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jointAngle, fitParabola, launchAngle, releaseSpeed, analyseForm, shotQuality,
  shotDifficulty, shotZone, pickCue, sessionSummary, bandScore,
} from '../js/metrics.js';
import { simulateShot, makeProfile } from '../js/simulator.js';
import { cleanTrack, passedThroughHoop } from '../js/ball.js';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('jointAngle measures a right angle and a straight line', () => {
  near(jointAngle({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 90, 1e-9);
  near(jointAngle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180, 1e-9);
});

test('fitParabola recovers known coefficients', () => {
  const pts = [-2, -1, 0, 1, 2, 3].map((x) => ({ x, y: 0.5 * x * x - 2 * x + 3 }));
  const f = fitParabola(pts);
  near(f.a, 0.5, 1e-6); near(f.b, -2, 1e-6); near(f.c, 3, 1e-6);
});

test('launchAngle reads a 45° and a 50° launch in either direction', () => {
  for (const deg of [45, 50]) {
    for (const dir of [1, -1]) {
      const th = (deg * Math.PI) / 180, v = 7, ppm = 100;
      const track = Array.from({ length: 8 }, (_, k) => {
        const s = k / 30;
        return { x: 500 + dir * ppm * v * Math.cos(th) * s, y: 500 - ppm * (v * Math.sin(th) * s - 4.905 * s * s), t: s * 1000 };
      });
      near(launchAngle(track), deg, 0.5);
    }
  }
});

test('releaseSpeed converts pixels to metres per second', () => {
  const track = [0, 1, 2, 3, 4].map((k) => ({ x: k * 20, y: 0, t: k * 33.333 }));
  near(releaseSpeed(track, 100), 6, 0.01); // 20 px / 33 ms at 100 px/m = 6 m/s
});

test('bandScore is 100 inside the band and falls off outside', () => {
  assert.equal(bandScore(48, 45, 52, 15), 100);
  near(bandScore(37.5, 45, 52, 15), 50, 1e-9);
  assert.equal(bandScore(0, 45, 52, 15), 0);
});

test('shot difficulty and zones', () => {
  assert.equal(shotDifficulty(1, 0), 1);
  assert.equal(shotDifficulty(7.2, 0.4), 5);
  assert.equal(shotZone(1, 0), 'Restricted');
  assert.equal(shotZone(7, 6.9), 'Corner three');
  assert.equal(shotZone(7.5, 0), 'Above the break');
});

test('pickCue prioritises a flat arc', () => {
  const cue = pickCue({ arc: 40, speed: 7, form: null, made: false });
  assert.equal(cue.key, 'arc-low');
  assert.match(cue.text, /Arc 40°/);
});

test('pickCue praises a clean make', () => {
  const form = { elbowFlare: 0.1, kneeDip: 130, elbowAtRelease: 170, followThroughMs: 500, balanceDrift: 0.05 };
  assert.equal(pickCue({ arc: 48, speed: 7, form, made: true }).key, 'good-make');
});

test('simulated shots run end to end through the analysis pipeline', () => {
  for (let i = 0; i < 25; i++) {
    const s = simulateShot(makeProfile());
    const form = analyseForm(s.frames, 'right');
    assert.ok(form.dipIndex <= form.setIndex && form.setIndex <= form.releaseIndex);
    assert.ok(form.kneeDip > 90 && form.kneeDip < 180);
    const track = cleanTrack(s.track, s.pxPerMetre * 0.6);
    const arc = launchAngle(track.slice(0, 10));
    assert.ok(arc > 30 && arc < 65, `arc ${arc}`);
    const speed = releaseSpeed(track, s.pxPerMetre);
    assert.ok(speed > 4 && speed < 12, `speed ${speed}`);
    assert.equal(typeof passedThroughHoop(track, s.hoop), 'boolean');
    const q = shotQuality({ arc, form, distanceM: s.distanceM });
    assert.ok(q.score >= 0 && q.score <= 100);
  }
});

test('sessionSummary', () => {
  const s = sessionSummary([{ made: true, arc: 46, score: 80 }, { made: false, arc: 50, score: 60 }]);
  assert.equal(s.pct, 50); assert.equal(s.avgArc, 48); assert.equal(s.avgScore, 70);
});
