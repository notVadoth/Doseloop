# DoseLoop

ECE 198 (F26) project for CCCARE: **prescribe, track and adjust exercise doses for older adults, in the clinic and at home.**

DoseLoop closes the loop that is open today. A kinesiologist prescribes a dose; a small wearable counts each repetition and scores how well it was done; the result flows straight back to the kinesiologist with a suggested adjustment. Nothing is on paper and no camera is involved.

| Sub-problem in the brief | What DoseLoop does |
|---|---|
| 1. Scale personalised care | One database replaces paper logs, Access and re-typed faxes. Doses are versioned, every change is attributed, and a rule-based engine suggests when to progress, hold or reduce. Records export to CSV and print. |
| 2. Exercise tracking and measurement | A wearable (STM32 + accelerometer + pulse sensor) counts reps and scores range, tempo and smoothness. A live board shows one instructor the whole room and flags anyone who has stopped, is overdoing it, or has poor form. |
| 3. Remote (at-home) care | A large-type participant app guides the session, enforces the dose, checks heart rate against a ceiling, collects effort and pain, and keeps a community feed going. Motion data only: no video, and only "Jean L." style names are shared. |

## Run it

Needs Node.js 22.5 or newer. Nothing needs installing for the core app; the optional Claude features need one `npm install` (see AI features).

```bash
cd doseloop
npm start
```

Open <http://localhost:4198>. The first run creates `data/doseloop.db` with 12 demo participants and six weeks of history. `npm run reset` starts again from fresh demo data.

## A five-minute tour

1. **Roster** — the tiles and "Needs review" list show who needs attention. Each demo participant is a different case: Margaret is ready to progress, Harold's pain is climbing, Eleanor overdoes it at home, Walter has stopped attending, Frank's form is poor, George under-doses, Stanley is on the waitlist.
2. **Open Margaret Okafor** — the suggested adjustment shows the evidence and the proposed dose. *Review and prescribe* loads it into the editor; saving creates dose v2 and keeps v1 on record.
3. **Live class** → *Start demo class* — seven simulated participants work through their doses. Watch for the amber "Check form", red "Past prescribed dose", high heart rate, and "No movement" flags.
4. **Participant** (top right) → pick Jean → *Start exercising* → choose **Demo sensor** → *Start set*. Reps count themselves with feedback after each one. Finish, answer the effort and pain questions, and the session is on Jean's record. While it runs, Jean also appears on the Live class board.
5. **New intake** — type in a faxed referral once; prescribing a dose takes the person off the waitlist.

## Using the real wearable

Build the hardware in [docs/HARDWARE.md](docs/HARDWARE.md), flash the firmware, plug the Nucleo in by USB, and choose **Wearable sensor** in a session. The browser talks to the board directly over Web Serial (Chrome or Edge on a computer). The demo sensor speaks the same protocol, so the rest of the app behaves identically with either.

## AI features

Every AI feature has two engines. With a Claude API key it uses Claude (`claude-opus-5-5`); without one it uses a built-in, rule-based version, so the demo never depends on the internet. Each result is labelled **Claude** or **Built-in**.

| Feature | Where | What it does |
|---|---|---|
| Referral reader | New intake | Paste a faxed referral; the intake form fills itself in. Replaces re-typing WRHN faxes. |
| Progress note | Participant record | Drafts a SOAP note from the record for the kinesiologist to edit. |
| Ask your roster | Roster | Plain-language questions: "Who is at risk of dropping off?" Names in the answer link to records. |
| Coach | Participant home and session summary | Encouragement and answers in plain language. It refuses to change the plan and sends red-flag symptoms to 911. |
| Voice coach | During a session | Counts reps aloud and speaks the one cue that matters. Uses the browser, no internet. |
| Drop-off risk | Roster and record | 0 to 100 score with its drivers shown on hover. A transparent weighted score, not a trained model. |

**To turn Claude on**, install the SDK once and start the server with a key:

```bash
npm install
```

```bash
ANTHROPIC_API_KEY=your-key npm start
```

The sidebar then shows "AI: Claude connected". If a call fails, that feature quietly uses the built-in version and the badge tooltip says why.

**Privacy by design.** Names and birth dates never leave the computer. Records are sent as "the participant"; roster questions use codes like `[P3]` that are swapped back to names locally. The exception is the referral reader, which sends the pasted text as-is. Model output is treated as untrusted: extracted fields are validated like typed input, and nothing the AI writes is saved or prescribed without a person confirming it.

## Camera tracking (machine learning)

In a session, choose **Camera** and prop the phone or laptop so the whole body is in view. The app then counts reps, checks the movement matches the prescribed exercise ("This looks like Bicep curl. Your plan says Sit-to-stand."), and for timed exercises only counts minutes while it can see you moving.

How it works, all in the browser (video never leaves the device):

1. **Pose:** Google's MediaPipe Pose Landmarker (loaded from a CDN on first use) finds 33 body landmarks in 3D in every frame.
2. **Features:** `web/motion.js` turns them into 14 joint angles (knees, hips, elbows, shoulders, sideways arm and leg movement, trunk lean, heel lift) and summarises the last 3 seconds.
3. **Classifier:** a small neural network (56 inputs, 48 hidden units, 11 outputs: the 10 exercises plus "Not exercising"), trained by `ml/train.js` in plain JavaScript and shipped as `web/model/exercise-model.json` (29 KB).
4. **Rep counter:** follows the exercise's main joint angle, learns the person's range of motion from the last 8 seconds, and rejects reps under half the prescribed range.

**Training data.** There is no labelled video of real people doing these exercises, so the model learns from (a) synthetic movement generated from the same kinematics as the 3D figure, varied in body size, speed, range, camera angle and noise, and (b) MediaPipe's real output when shown the animated 3D figure (`ml/data/`): every exercise at a fast tempo with full range from five camera angles and a slow tempo with shallow range from four, and seven ways of not exercising (standing still, swaying, shifting weight, adjusting an arm, hands on hips, sitting still, fidgeting). Retrain with `npm run train`; `node ml/by-view.js` breaks accuracy down by camera angle.

Each window is described by 15 measurements × 5 statistics. Two were added after testing showed where the model failed: a 2D heel-lift measurement taken from the picture (MediaPipe's 3D points are centred on the hips, so a heel raise looked the same as standing still), and a "deliberateness" statistic that separates a smooth movement from landmark jitter.

**Photos of real people.** `ml/fetch-commons.js` downloaded 484 freely licensed photos (public domain, CC0, CC BY, CC BY-SA) from Wikimedia Commons by exercise keyword; each photo's licence, author and source page are listed in `ml/images/manifest.json`. The pose detector found a person in 191 and the whole body in 82; most stock exercise photos are cropped to the upper body. Photos are single moments, so they cannot teach a movement, but they show real bodies and postures, which the 3D figure cannot. Training uses 55 of them two ways (`ml/stills.js`): each posture held still for 3 seconds with the pose detector's real jitter, labelled "not exercising", and recorded arm movements laid over real postures. The other 27 photos are kept for testing. The photos themselves are not stored in the app or deployed; only the joint angles measured from them (`ml/stills.json`) are used.

Real people holding still, from held-out photos, called "not exercising": **52.7% before → 99.5% after** training with the photos. The 3D figure always stood one way, so ordinary stances (feet apart, leaning, sitting) had been read as exercises.

| Test (never trained on) | Before | Now |
|---|---|---|
| Facing the camera (within 50°) | 86.9% | **93.3%** (96.8% on the long facing-camera recordings) |
| ...of which "not exercising" | 44% | **85%** |
| Side-on (50–100°) | 60.8% | 75.7% |
| From behind (over 100°) | 67.1% | 82.6% |
| Reps counted, facing the camera, 8 exercises × 2 angles × 8 reps | 86% (with double counts) | **88%, no double counts** |
| Continuous workout of all 10 exercises, facing the camera | | every exercise recognised in 1.6–6.4 s; no false detections; 85% of reps |

The camera works best facing the person; side-on, one camera cannot see some movements properly (a sideways arm raise looks like a bent elbow), so the app asks people to face it. Heel raises are still counted only about two times in three, and the app says so. **None of these numbers come from real people.** Test with a handful of people before relying on it.

### Count on the camera

During camera tracking the exercise name, the count (for example "7 / 24") and a progress bar are drawn over the video, with a pop on each rep. The camera coach has a full-screen button so the count can be read from across the room.

## Designed for older adults on phones

The participant side (what people use at home) follows common guidance for older users:

- **Text size button ("Aa")** cycling normal, large and extra large; remembered on the device. Body text starts at 20 px.
- **Big targets:** every button and link is at least 44 px tall, most 60 px or more; the 0–10 effort and pain scales become two rows of finger-sized buttons on a phone.
- **Bottom tab bar** with large labelled icons: Today, Exercise, Camera, People. It hides during a guided session so a stray tap cannot abandon a set.
- **The two main actions first:** "Start exercising" and "Camera coach" are the first things on the home screen.
- **Calmer screens:** no moving background or pulsing buttons, darker grey text, thicker focus outlines; animations stop entirely when the phone asks for reduced motion.

## Mobile app

DoseLoop is an installable web app (PWA). On a phone, open the site and choose **Install app** (Chrome on Android) or **Share → Add to Home Screen** (Safari on iPhone). It then opens full-screen from its own icon, and the app shell loads offline. There is no app-store build; the same code serves phone, tablet and desktop.

## Hosting on Vercel

```bash
npm run deploy
```

`web/` is served as static files and `api/index.js` runs the API as a serverless function. The hosted copy keeps its database in memory, seeded with the demo data, so it is a **public demo that resets** whenever Vercel starts a fresh server, and changes made on one visit may not be there on the next. Set `ANTHROPIC_API_KEY` in the Vercel project settings to turn on the Claude features there.

## How it is built

```
firmware/core/     Portable C: rep detector, heart-rate detector, command parser
firmware/test/     Host unit tests for the core (gcc)
firmware/stm32/    main.c for the Nucleo-F401RE (HAL)
server/db.js       SQLite schema and demo data
server/engine.js   Dose logic: completion, attendance, flags, recommendation, drop-off risk
server/ai.js       AI features: Claude calls with built-in fallbacks
server/server.js   HTTP API, live board (server-sent events), static files
api/               Vercel entry point
web/               Single-page app, no framework and no build step
web/poses.js       Exercise kinematics shared by the 3D figure and the ML training
web/motion.js      Pose features, classifier, camera rep counter
web/vision.js      Camera + MediaPipe in the browser
ml/                Classifier training script and MediaPipe recordings
test/              API, engine, ML and deployment tests (node --test)
docs/              Pitch script and hardware guide
```

**Rep detection.** The accelerometer gives the tilt of the limb relative to gravity. The first half-second of a set defines the rest angle. A rep is an excursion away from rest and back; hysteresis (leave at 35% of the prescribed range, return at 15%) rejects tremor and noise. Each rep is scored 0–100: 50% range of motion against the prescription, 30% tempo, 20% smoothness. Movements under half the prescribed range are reported as partial reps and do not count toward the dose.

**Recommendation rules** (last 3 sessions on the current dose; `server/engine.js`):

- **Reduce** if pain averages 4+/10 (or 6+ in the latest session), effort is 2+ above the target RPE, under 70% of the dose is completed, or heart rate passed the ceiling in 2 of 3 sessions. Proposes about −15%.
- **Progress** if every session reached 95% of the dose, effort is at or below target, pain is 2 or less, and movement quality is 75+. Proposes about +10%; past 15 reps it adds a set instead.
- **Hold** otherwise, and says which condition is not met.

The suggestion is never applied automatically. A kinesiologist reviews, edits and signs it.

**Design.** One stylesheet of colour and type tokens drives a white theme. Icons, avatars, progress rings, sparklines and charts are inline SVG generated in `web/app.js`. The two typefaces load from Google Fonts; without internet the app falls back to system fonts and still works.

## Tests

```bash
npm test
```

```bash
cd firmware/test && gcc -O2 -Wall -Wextra -I../core test_core.c ../core/doseloop_core.c -lm -o test_core && ./test_core
```

The firmware tests feed synthetic accelerometer and pulse signals through the same C code that runs on the board: clean reps, noise at rest, shallow reps, rushed reps, a slow posture change, heart rates from 55 to 150 bpm, and a sensor off the skin.

## Known limits

- **The firmware has not been run on a board.** The signal-processing core is tested on a PC; `firmware/stm32/main.c` is written against the STM32 HAL but has not been compiled or flashed here. Expect to tune thresholds on real movement.
- **Claude has not been called for real.** No API key was available while building, so the Claude path is tested against a stand-in server that mimics the API. The built-in versions are tested end to end. Try each feature once with a real key before relying on it.
- **No login.** Run locally, the server only listens on this computer for that reason. The Vercel demo is public: anyone with the link can view and change its (fictional, resetting) data. Real use needs accounts, encryption and a privacy review (PHIPA) before any real health information goes in. All data shipped here is fictional.
- **Clinical thresholds are placeholders.** The recommendation rules, quality weights and the default heart-rate ceiling (80% of 220 − age) are reasonable starting points, not validated values. CCCARE's kinesiologists should set them. The brief's "Dosages and Exercise Sessions" file was not available when this was built, so the dose model (frequency, sets, reps or minutes, load, target RPE) should be checked against it.
- One sensor tracks one limb, and tilt-based detection suits exercises with a clear rotation (sit-to-stand, curls, leg raises). Timed exercises such as walking are logged with a timer.
