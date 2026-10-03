# CourtVision AI

**Personalised AI shooting and form coach.** Built by **Skillfield**.

> SHOOT | ANALYSE | OPTIMISE

CourtVision AI turns a smartphone into a shooting coach. Prop your phone side-on to the court, and the app tracks your shooting motion, arc, release speed and ball flight in real time, then talks you through every rep. It's for solo players, high school athletes and self-directed trainers who want elite feedback without buying thousands of dollars of hardware.

Everything runs on the device. No video leaves the phone.

## Features

| Feature | What it does |
| --- | --- |
| **Real-time audio feedback** | Spoken cues after each shot through earbuds (Web Speech API, en-AU voice where available), for example *"Arc 42°. Add power and lift it higher."*, *"Higher release. Extend fully."* or *"Tuck the elbow."* Cues are prioritised, so you hear the single most useful fix, and they aren't repeated back to back. You can choose cues after every shot, only on misses, or off. |
| **Shot charting & Shot Quality Score** | Makes and misses are tagged automatically once you tap the rim to calibrate, with a manual correction on every shot. Each shot is plotted on a FIBA half-court chart with zone splits. Every shot gets a 0–100 **Shot Quality Score** (arc, elbow tuck, dip, follow-through, balance) and a **difficulty rating** from 1 to 5 based on depth and balance. |
| **Form breakdown** | Frame-by-frame scrubbing and slow-motion playback of each shot, auto-zoomed onto the shooter. Jump straight to the **Dip**, **Set point**, **Release** or **Follow-through** frame, with joint angles drawn on the frame. Checks cover elbow tuck, knee dip, release extension, follow-through hold and balance. A session-level **dip consistency** panel shows how much your knee dip and dip-to-release timing vary. |
| **Progress** | Session history, with FG% and average quality trends, saved locally on the device. |
| **Demo mode** | A simulated shooter drives the full pipeline, so you can try every feature without a court or camera. |

## How it works

```
camera frame ──► MediaPipe Pose Landmarker (on-device) ──► 33 body landmarks
            └──► colour-based ball tracker (160 px scan)  ──► ball centroid

landmarks ──► shot detector (wrist rises above head → peak → release)
          ──► analyseForm(): knee dip, set point, elbow tuck, release extension,
                             follow-through hold, balance drift
ball track ─► least-squares parabola ──► launch angle (arc)
          ──► pixels → metres (player height calibration) ──► release speed
          ──► rim crossing test (tapped rim position) ──► make / miss
all of it ─► shotQuality() + pickCue() ──► score, difficulty, spoken cue
```

* **Pose** comes from [MediaPipe Tasks Vision](https://developers.google.com/mediapipe/solutions/vision/pose_landmarker) (`pose_landmarker_lite`), loaded from its CDN and run on GPU with a CPU fallback.
* **Ball tracking** is a deliberately lightweight heuristic: it thresholds orange hue and saturation, then filters by blob shape. It works best with an orange ball, good light and a plain background. The roadmap below covers a learned detector.
* **Scale:** pixels-per-metre comes from the player's apparent height and the height you enter in Settings. Shot distance is measured from your feet to the tapped rim. If the rim isn't set, it uses the distance slider.
* **Shot location:** a single side-on camera measures depth but not court angle, so you pick your shooting spot (5-spot drill: corners, wings, top). The chart uses that to place shots.

All analysis maths lives in `js/metrics.js` as pure functions with unit tests.

## Run it

It's a static site with no build step.

```bash
npm start            # serves on http://localhost:8080 (python3 http.server)
npm test             # unit tests for the analysis pipeline (Node 18+)
```

Camera access needs **HTTPS** (or `localhost`). To try it on a phone, deploy the folder to any static host (GitHub Pages, Netlify, Azure Static Web Apps, S3 + CloudFront) or use a tunnel. Once installed, the app can be added to the home screen as a PWA. A service worker caches the app shell.

### Filming tips
1. Place the phone **side-on**, 4–6 m from the shooter, with the whole body *and* the rim in frame.
2. **Tap the rim** in the preview once to enable automatic make/miss.
3. Set your **shooting hand** and **height** in Settings so speed and distance are in real units.

## Project structure

```
index.html            App shell (Home, Practice, Chart, Form, Progress)
css/                  Skillfield design tokens + app styles
js/app.js             UI, live camera loop, demo loop, views
js/metrics.js         Pure analysis: angles, parabola fit, arc, speed, form, scoring, cues
js/pose.js            MediaPipe Pose Landmarker wrapper + skeleton drawing
js/ball.js            Colour-based ball tracker, track cleaning, rim-crossing test
js/coach.js           Voice cues (Web Speech API)
js/simulator.js       Synthetic shooter for demo mode and tests
js/court.js           SVG half-court shot chart
js/storage.js         Local session history and settings
sw.js, manifest.webmanifest   PWA
tests/                node:test unit tests
```

## Brand

This app uses the **Skillfield** design system: deep blue `#124E91`, electric blue `#437FEC`, aqua `#4CD9ED` and a navy ground. It uses Poppins for display text, Open Sans for body text, pill buttons, blue-family gradient boxes, and the cyan-piped eyebrow device. The fonts are Google Fonts substitutes until the official brand faces are supplied.

## Limitations & roadmap

* Colour-based ball tracking can confuse orange clothing or walls. Next step: an on-device ball detector (for example, a small YOLO/EfficientDet model via TF.js or MediaPipe Object Detector).
* Elbow tuck is measured from a side-on view as the elbow's offset from the line under the ball. A front-on camera mode would measure true elbow flare.
* Court angle is chosen per spot. A second camera, or court-line detection, could locate shots automatically.
* Ideas for later: native wrappers (Capacitor) for background audio, Bluetooth earbud controls, coach sharing and team dashboards.

---
© Skillfield. A Skillfield prototype.
