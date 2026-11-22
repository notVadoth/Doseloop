'use strict';
// Camera tracking. MediaPipe Pose Landmarker (Google, loaded from a CDN on first use) finds
// 33 body landmarks in each video frame; DLMotion turns them into joint angles, classifies
// the last 3 seconds of movement with the trained model, and counts reps.
// Everything runs in the browser: video frames never leave the device.
(() => {
  const VERSION = '0.10.14';
  const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
  // "full" finds joints more accurately and with steadier visibility scores than "lite", at
  // about twice the cost. A device too slow for it (under ~18 frames a second, measured after
  // the first second's warm-up) switches to "lite" by itself and remembers that for 3 days.
  const POSE_MODELS = {
    // "heavy" (30 MB) is the most robust, especially in hard lighting, at roughly twice the cost
    // of "full". Under test: chosen from developer mode until devices that can run it are known.
    heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
    full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  };
  const MODEL_KEY = 'doseloop.poseModel';
  const SLOW_MS = 55; // average detection time above which "full" is too slow here
  const REMEMBER_MS = 3 * 86400000;
  const preferredModel = () => {
    try {
      const [k, at] = String(localStorage.getItem(MODEL_KEY) || '').split(':');
      return k === 'lite' && Date.now() - Number(at) < REMEMBER_MS ? 'lite' : 'full';
    } catch {
      return 'full';
    }
  };
  // Model choice (developer mode): 'auto' (full, falling back to lite on a slow device), or a
  // fixed 'heavy' / 'full' / 'lite'. A running camera swaps to it within a frame or two of
  // the new model loading.
  const CHOICE_KEY = 'doseloop.vision.model';
  const KINDS = ['heavy', 'full', 'lite', 'movenet'];
  let modelChoice = (() => {
    try {
      const c = localStorage.getItem(CHOICE_KEY);
      return c && (c === 'auto' || KINDS.includes(c)) ? c : 'auto';
    } catch {
      return 'auto';
    }
  })();
  function setModel(c) {
    c = String(c);
    if (c !== 'auto' && !KINDS.includes(c)) throw new Error('Model must be auto, heavy, full, lite or movenet');
    modelChoice = c;
    modelPicked++;
    try {
      if (c === 'auto') localStorage.removeItem(CHOICE_KEY);
      else localStorage.setItem(CHOICE_KEY, c);
    } catch {
      /* applies until the page reloads */
    }
  }
  const wantedModel = () => (modelChoice === 'auto' ? preferredModel() : modelChoice);
  let modelPicked = 0; // bumped on each choice, so a model that failed can be tried again
  const WINDOW_MS = 3000;
  const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32]];
  const NEEDED = [11, 12, 23, 24, 25, 26, 27, 28]; // shoulders, hips, knees, ankles
  // "Whole body in view" turns on when every needed joint is clearly seen and only turns off
  // when one is clearly lost, so standing near the edge of the picture does not flicker.
  const FULL_ON = 0.6, FULL_OFF = 0.3;
  const HOLD_MS = 300; // keep drawing the last pose through a frame or two with no detection

  // ---------- frame filter: gamma, for bright rooms (under test in developer mode) ----------
  // 'off', 'auto', or a fixed gamma such as 1.8. The pose model gets a gamma-corrected copy of
  // each frame (out = in^gamma, through a 256-entry lookup table); the picture on screen is
  // unchanged. Gamma above 1 darkens the mid-tones, bringing back limbs that a bright room
  // washes out; pure white stays white, so clipped highlights cannot be recovered. 'auto'
  // picks the gamma that brings the frame's average brightness to about 45%, eased over
  // a few frames so it does not flicker.
  const GAMMA_KEY = 'doseloop.vision.gamma';
  let gammaMode = (() => {
    try {
      return localStorage.getItem(GAMMA_KEY) || 'off';
    } catch {
      return 'off';
    }
  })();
  function setGamma(m) {
    m = String(m);
    if (!(m === 'off' || m === 'auto' || (Number(m) >= 0.3 && Number(m) <= 4))) throw new Error('Gamma must be off, auto, or a number from 0.3 to 4');
    gammaMode = m;
    try {
      if (m === 'off') localStorage.removeItem(GAMMA_KEY);
      else localStorage.setItem(GAMMA_KEY, m);
    } catch {
      /* applies until the page reloads */
    }
  }
  const filtering = () => gammaMode !== 'off' && gammaMode !== '1';

  class GammaFilter {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.gamma = 1;
      this.lutGamma = null;
      this.lut = new Uint8ClampedArray(256);
      this.mean = null;
      this.ms = null;
    }
    // Returns the canvas to give the pose model (at most 480 pixels wide: the model works on
    // a 256-pixel image, so a bigger copy only costs time).
    // box: where the person was last seen ({x0, y0, x1, y1}, 0-1), so 'auto' judges the
    // brightness of the person rather than of a bright wall or window behind them.
    apply(video, mode = gammaMode, box = null) {
      const t0 = performance.now();
      const vw = video.videoWidth || video.width, vh = video.videoHeight || video.height;
      const W = Math.min(480, vw), H = Math.round((vh * W) / vw);
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
      const g = this.ctx;
      g.drawImage(video, 0, 0, W, H);
      const im = g.getImageData(0, 0, W, H);
      const d = im.data;
      const x0 = box ? Math.max(0, Math.floor(box.x0 * W)) : 0, x1 = box ? Math.min(W, Math.ceil(box.x1 * W)) : W;
      const y0 = box ? Math.max(0, Math.floor(box.y0 * H)) : 0, y1 = box ? Math.min(H, Math.ceil(box.y1 * H)) : H;
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += 4) {
        for (let x = x0, i = (y * W + x0) * 4; x < x1; x += 4, i += 16) {
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          n++;
        }
      }
      this.mean = n ? sum / n / 255 : 0.5;
      this.boxed = !!box;
      if (mode === 'auto') {
        const m = Math.min(0.95, Math.max(0.05, this.mean));
        const want = Math.min(3, Math.max(0.5, Math.log(0.45) / Math.log(m)));
        this.gamma += 0.15 * (want - this.gamma);
      } else this.gamma = Number(mode);
      if (this.lutGamma === null || Math.abs(this.lutGamma - this.gamma) > 0.02) {
        for (let v = 0; v < 256; v++) this.lut[v] = 255 * Math.pow(v / 255, this.gamma);
        this.lutGamma = this.gamma;
      }
      const lut = this.lut;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = lut[d[i]];
        d[i + 1] = lut[d[i + 1]];
        d[i + 2] = lut[d[i + 2]];
      }
      g.putImageData(im, 0, 0);
      const ms = performance.now() - t0;
      this.ms = this.ms === null ? ms : this.ms * 0.95 + ms * 0.05;
      return this.canvas;
    }
  }

  // The area around the joints seen clearly, padded by 10% (normalised 0-1), or null.
  function bodyBox(img) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
    for (const p of img) {
      if ((p.visibility ?? 1) < 0.5) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
      n++;
    }
    if (n < 6 || x1 - x0 < 0.02 || y1 - y0 < 0.02) return null;
    const px = (x1 - x0) * 0.1, py = (y1 - y0) * 0.1;
    return { x0: Math.max(0, x0 - px), y0: Math.max(0, y0 - py), x1: Math.min(1, x1 + px), y1: Math.min(1, y1 + py) };
  }

  // Average brightness of a frame (0-1), from a tiny copy: cheap enough to log while the filter is off.
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 24;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  function brightness(video) {
    probeCtx.drawImage(video, 0, 0, 32, 24);
    const d = probeCtx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4) / 255;
  }

  const landmarkers = {};
  let model = null;

  // ---------- MoveNet Thunder (TensorFlow.js), under test against MediaPipe ----------
  // A different model from MediaPipe's: 17 keypoints and 2D only (no heels or toes, no depth).
  // Its points are translated into MediaPipe's 33-landmark layout so everything downstream
  // (angles, form checks, rep counting, fusion) works unchanged. What it cannot provide:
  //  - heels and toes: heel raises cannot be measured (those slots are marked unseen);
  //  - depth: angles are measured in the picture, and forward lean (towards the camera) is
  //    invisible to a camera facing the person, so the "no swinging" cue cannot fire.
  // Loaded only when chosen: the libraries (~1 MB) and the model (~12 MB) come from CDNs.
  const TF = 'https://cdn.jsdelivr.net/npm';
  const TF_SCRIPTS = [
    `${TF}/@tensorflow/tfjs-core@4.22.0/dist/tf-core.min.js`,
    `${TF}/@tensorflow/tfjs-converter@4.22.0/dist/tf-converter.min.js`,
    `${TF}/@tensorflow/tfjs-backend-webgl@4.22.0/dist/tf-backend-webgl.min.js`,
    `${TF}/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js`,
  ];
  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      if ([...document.scripts].some((x) => x.src === src)) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(el);
    });
  // MoveNet's keypoints, in its (COCO) order, go to these MediaPipe slots. "left" is the
  // person's left in both.
  const COCO_TO_MP = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  // Slots MoveNet has no point for: a copy of a neighbour, marked unseen.
  const FILL = { 1: 0, 3: 0, 4: 0, 6: 0, 9: 0, 10: 0, 17: 15, 19: 15, 21: 15, 18: 16, 20: 16, 22: 16, 29: 27, 31: 27, 30: 28, 32: 28 };
  // MoveNet's confidence runs lower than MediaPipe's visibility: Google suggests 0.3 as its
  // "seen" threshold where this app uses 0.6, so scores are scaled to match (0.3 -> 0.6).
  const moveNetVis = (score) => Math.max(0, Math.min(1, (score || 0) * 2));
  function fromMoveNet(poses, src) {
    const p = poses && poses[0];
    if (!p || !p.keypoints || p.keypoints.length < 17) return { landmarks: [], worldLandmarks: [] };
    const W = src.videoWidth || src.width, H = src.videoHeight || src.height;
    const img = new Array(33);
    p.keypoints.forEach((k, i) => (img[COCO_TO_MP[i]] = { x: k.x / W, y: k.y / H, z: 0, visibility: moveNetVis(k.score) }));
    for (const [i, from] of Object.entries(FILL)) img[i] = { ...img[from], visibility: 0 };
    if (Math.max(img[11].visibility, img[12].visibility, img[23].visibility, img[24].visibility) < 0.3) return { landmarks: [], worldLandmarks: [] };
    // Pseudo-3D points: the picture around the hip centre, scaled so a torso is about half a
    // metre (angles do not depend on the scale), y down as in MediaPipe, depth 0.
    const hx = ((img[23].x + img[24].x) / 2) * W, hy = ((img[23].y + img[24].y) / 2) * H;
    const torso = Math.hypot(((img[11].x + img[12].x) / 2) * W - hx, ((img[11].y + img[12].y) / 2) * H - hy) || 1;
    const m = 0.5 / torso;
    const world = img.map((q) => ({ x: (q.x * W - hx) * m, y: (q.y * H - hy) * m, z: 0, visibility: q.visibility }));
    return { landmarks: [img], worldLandmarks: [world] };
  }
  async function loadMoveNet() {
    for (const src of TF_SCRIPTS) await loadScript(src); // in order: each needs the one before
    const tf = window.tf, pd = window.poseDetection;
    if (!tf || !pd) throw new Error('TensorFlow.js did not load');
    await tf.setBackend('webgl');
    await tf.ready();
    const det = await pd.createDetector(pd.SupportedModels.MoveNet, { modelType: pd.movenet.modelType.SINGLEPOSE_THUNDER, enableSmoothing: true });
    return { async: true, estimate: async (src, ts) => fromMoveNet(await det.estimatePoses(src, { flipHorizontal: false }, ts), src) };
  }

  function loadLandmarker(kind = preferredModel()) {
    if (kind === 'movenet') {
      if (!landmarkers.movenet) {
        landmarkers.movenet = loadMoveNet();
        landmarkers.movenet.catch(() => delete landmarkers.movenet);
      }
      return landmarkers.movenet;
    }
    if (!landmarkers[kind]) {
      const p = (async () => {
        const vision = await import(`${BASE}/vision_bundle.mjs`);
        const files = await vision.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
        const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: POSE_MODELS[kind], delegate }, runningMode: 'VIDEO', numPoses: 1 });
        try {
          return await make('GPU');
        } catch {
          return make('CPU'); // no WebGL2 on this device
        }
      })();
      landmarkers[kind] = p;
      p.catch(() => delete landmarkers[kind]); // allow a retry after a network failure
    }
    return landmarkers[kind];
  }
  // The preferred model, or "lite" if the preferred one cannot be loaded.
  async function loadBestLandmarker() {
    const kind = wantedModel();
    try {
      return { lm: await loadLandmarker(kind), kind };
    } catch (e) {
      if (kind === 'lite') throw e;
      return { lm: await loadLandmarker('lite'), kind: 'lite' };
    }
  }
  // The model must match this version of motion.js feature for feature, so it is always
  // revalidated with the server (cheap: an unchanged file comes back as 304) and checked.
  function loadModel() {
    if (!model) {
      model = (async () => {
        const get = (cache) => fetch('model/exercise-model.json', { cache }).then((r) => {
          if (!r.ok) throw new Error('Could not load the exercise model.');
          return r.json();
        });
        const expected = DLMotion.CHANNELS.length * DLMotion.STATS.length;
        let m = await get('no-cache');
        if (m.mean.length !== expected) m = await get('reload');
        if (m.mean.length !== expected) throw new Error('The app has just been updated. Please reload the page.');
        return m;
      })();
      model.catch(() => (model = null));
    }
    return model;
  }

  // Joint-angle labels drawn next to the joint: [landmark, index into DLMotion.frameAngles].
  const ANGLE_LABELS = [[13, 4], [14, 5], [11, 6], [12, 7], [23, 2], [24, 3], [25, 0], [26, 1]];

  // The canvas is mirrored with CSS for a selfie view, so text is flipped back around its anchor.
  function drawAngles(ctx, lm, angles, w, h, mirrored) {
    const size = Math.max(12, Math.round(w / 42));
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [i, k] of ANGLE_LABELS) {
      if (lm[i].visibility < 0.5) continue;
      const text = `${Math.round(angles[k])}°`;
      const x = lm[i].x * w, y = lm[i].y * h - size * 1.2;
      const tw = ctx.measureText(text).width + size * 0.8;
      ctx.save();
      ctx.translate(x, y);
      if (mirrored) ctx.scale(-1, 1);
      ctx.fillStyle = 'rgba(8, 20, 17, .72)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-tw / 2, -size * 0.75, tw, size * 1.5, size * 0.4);
      else ctx.rect(-tw / 2, -size * 0.75, tw, size * 1.5);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, 0, 1);
      ctx.restore();
    }
  }

  // highlight: landmarks with a form fault; they and their bones are drawn in red.
  const FAULT = '#ef4f4f';
  function drawSkeleton(ctx, lm, w, h, color, highlight = new Set()) {
    ctx.lineWidth = Math.max(3, w / 160);
    ctx.lineCap = 'round';
    for (const [a, b] of BONES) {
      if (lm[a].visibility < 0.4 || lm[b].visibility < 0.4) continue;
      ctx.strokeStyle = highlight.has(a) || highlight.has(b) ? FAULT : color;
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      if (lm[i].visibility < 0.4) continue;
      const bad = highlight.has(i);
      ctx.fillStyle = bad ? FAULT : '#ffffff';
      ctx.beginPath();
      ctx.arc(lm[i].x * w, lm[i].y * h, ctx.lineWidth * (bad ? 2 : 1.1), 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // onFrame({visible, fullBody, angles, smooth, metrics, points, landmarks, t, pred}):
  //   angles: raw joint angles, as the classifier and rep counter were trained and tested on.
  //   smooth, metrics: joint angles and DLMotion.formMetrics, smoothed, for showing and judging form. is called for every processed frame.
  // Camera choice: deviceId (a specific webcam) or facing ('user' = selfie, 'environment' = rear).
  // showOverlay: draw the limbs over the video (tracking runs either way; change it later with
  // handle.setOverlay). showAngles: label each joint with its angle. handle.setHighlight(landmarks)
  // marks joints with a form fault in red.
  async function start({ video, overlay, onFrame, onStatus = () => {}, deviceId = null, facing = 'user', showOverlay = true, showAngles = false }) {
    if (!supported()) throw new Error('This browser cannot use the camera.');
    onStatus('Asking for the camera…');
    const size = { width: { ideal: 640 }, height: { ideal: 480 } };
    const stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: facing, ...size }, audio: false });
    // Mirror a selfie view so moving your right arm moves the right side of the picture.
    const track = stream.getVideoTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    const mirrored = settings.facingMode ? settings.facingMode === 'user' : facing === 'user';
    let stopped = false;
    const stop = () => {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
    try {
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      onStatus('Loading the pose model (first time only)…');
      let [{ lm, kind }, net] = await Promise.all([loadBestLandmarker(), loadModel()]);
      onStatus('');
      const ctx = overlay.getContext('2d');
      let frames = [], times = [], lastPred = 0, pred = null, lastSeen = 0, lastVideoTime = -1;
      let highlight = new Set();
      let fullBody = false;
      let probs = []; // the last few classifier outputs, averaged so one odd window does not flip the label
      let last = null; // the last pose drawn, held through brief detection gaps
      // Average detection time over 60 frames after a 30-frame warm-up (the GPU compiles its
      // shaders on the first frames), counting only while the page is on screen.
      let detectMs = null, detectSum = 0, detected = 0;
      let filter = null, light = null, probeN = 0; // gamma filter (when on) and the room's brightness
      let swapping = false, detectAvg = null; // changing model; running average detection time (ms)
      let busy = false; // MoveNet still working on a frame
      const failed = new Set(); // models that would not load in this camera run
      let pickedSeen = modelPicked;
      const smoother = new DLMotion.Smoother();
      const draw = (img, smooth, w, h) => {
        if (!showOverlay) return;
        drawSkeleton(ctx, img, w, h, fullBody ? '#5fd1ae' : '#f2c14e', highlight);
        if (showAngles) drawAngles(ctx, img, smooth, w, h, mirrored);
      };

      const tick = () => {
        if (stopped) return;
        if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          const now = performance.now();
          // The pose model sees the gamma-corrected copy when the filter is on.
          let src = video;
          if (filtering()) {
            src = (filter || (filter = new GammaFilter())).apply(video, gammaMode, last ? bodyBox(last.img) : null);
            light = { mean: filter.mean, gamma: filter.gamma, mode: gammaMode, filterMs: filter.ms };
          } else if (++probeN % 15 === 1 || (light && light.mode !== 'off')) {
            light = { mean: brightness(video), gamma: 1, mode: 'off', filterMs: null };
          }
          const tDetect = performance.now();
          if (lm.async) {
            // MoveNet answers asynchronously: frames that arrive while it is still working are
            // skipped, and each result is handled when it comes back.
            if (!busy) {
              busy = true;
              lm.estimate(src, now).then(
                (res) => {
                  busy = false;
                  if (!stopped) frame(res, now, performance.now() - tDetect);
                },
                () => (busy = false)
              );
            }
          } else frame(lm.detectForVideo(src, now), now, performance.now() - tDetect);
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else requestAnimationFrame(tick);
      };
      // One detection result: model housekeeping, drawing, angles, and the onFrame callback.
      const frame = (res, now, took) => {
          if (!document.hidden) detectAvg = detectAvg === null ? took : detectAvg * 0.95 + took * 0.05;
          if (!document.hidden && detected < 90) {
            if (++detected > 30) detectSum += took;
            if (detected === 90) detectMs = detectSum / 60;
          }
          if (pickedSeen !== modelPicked) {
            pickedSeen = modelPicked;
            failed.clear();
          }
          const want = wantedModel();
          if (want !== kind && !swapping && !failed.has(want) && !(modelChoice === 'auto' && kind === 'lite')) {
            swapping = true;
            onStatus(`Loading the ${want} pose model…`);
            loadLandmarker(want)
              .then((l) => {
                lm = l;
                kind = want;
                detected = 0;
                detectSum = 0;
                detectMs = null;
                detectAvg = null;
              })
              .catch(() => {
                failed.add(want); // not retried on every frame; choosing it again from the menu retries
                onStatus(`The ${want} pose model could not load; staying on ${kind}.`);
              })
              .finally(() => {
                swapping = false;
                onStatus('');
              });
          }
          if (modelChoice === 'auto' && kind === 'full' && detected === 90 && detectMs > SLOW_MS) {
            kind = 'lite'; // swap once the lighter model is ready; tracking carries on meanwhile
            loadLandmarker('lite')
              .then((l) => {
                lm = l;
                try {
                  localStorage.setItem(MODEL_KEY, `lite:${Date.now()}`);
                } catch {
                  /* measured again next time */
                }
              })
              .catch(() => {});
          }
          const w = video.videoWidth, h = video.videoHeight;
          if (overlay.width !== w || overlay.height !== h) {
            overlay.width = w;
            overlay.height = h;
          }
          ctx.clearRect(0, 0, w, h);
          const img = res.landmarks && res.landmarks[0];
          const world = res.worldLandmarks && res.worldLandmarks[0];
          if (img && world) {
            lastSeen = now;
            fullBody = fullBody ? NEEDED.every((i) => img[i].visibility > FULL_OFF) : NEEDED.every((i) => img[i].visibility > FULL_ON);
            // Side-on: the shoulders look narrow next to the torso. One camera tracks best facing it.
            const shoulders = Math.hypot((img[11].x - img[12].x) * w, (img[11].y - img[12].y) * h);
            const torso = Math.hypot(((img[11].x + img[12].x - img[23].x - img[24].x) / 2) * w, ((img[11].y + img[12].y - img[23].y - img[24].y) / 2) * h) || 1;
            const sideOn = shoulders / torso < 0.35;
            const points = DLMotion.pointsFromLandmarks(world);
            const angles = DLMotion.frameAngles(points, DLMotion.pointsFromImage(img, w, h));
            const sm = smoother.update(angles, DLMotion.formMetrics(points), now);
            last = { img, smooth: sm.angles };
            draw(img, sm.angles, w, h);
            if (fullBody) {
              frames.push(angles);
              times.push(now);
              while (times.length && now - times[0] > WINDOW_MS) {
                frames.shift();
                times.shift();
              }
              if (now - lastPred > 500 && now - times[0] > WINDOW_MS / 2) {
                lastPred = now;
                probs = [...probs.slice(-2), DLMotion.predict(net, DLMotion.windowFeatures(frames, times))];
                const p = probs[0].map((_, j) => probs.reduce((a, q) => a + q[j], 0) / probs.length);
                const k = p.indexOf(Math.max(...p));
                pred = { label: net.classes[k], prob: p[k], active: net.classes[k] !== DLMotion.IDLE };
              }
            }
            // How sure the model is of the joints that matter most (shoulders, hips, knees, ankles).
            const vis = NEEDED.reduce((a, i) => a + (img[i].visibility || 0), 0) / NEEDED.length;
            onFrame({ visible: true, fullBody, sideOn, angles, smooth: sm.angles, metrics: sm.metrics, points, landmarks: img, t: now, pred, vis, light, perf: { model: kind, detectMs: detectAvg } });
          } else {
            if (last && now - lastSeen < HOLD_MS) draw(last.img, last.smooth, w, h);
            if (now - lastSeen > 800) {
              frames = [];
              times = [];
              probs = [];
              pred = null;
              last = null;
              fullBody = false;
              smoother.reset();
              onFrame({ visible: false, fullBody: false, angles: null, smooth: null, metrics: null, points: null, landmarks: null, t: now, pred: null, vis: 0, light, perf: { model: kind, detectMs: detectAvg } });
            }
          }
      };
      tick();
      const setOverlay = (on) => {
        showOverlay = !!on;
        if (!showOverlay) ctx.clearRect(0, 0, overlay.width, overlay.height);
      };
      const setHighlight = (ids) => (highlight = new Set(ids || []));
      const info = () => ({ model: kind, choice: modelChoice, detectMs: detectAvg === null ? null : Math.round(detectAvg), gamma: gammaMode, filterMs: filter && filter.ms !== null ? Math.round(filter.ms * 10) / 10 : null });
      return { stop, mirrored, setOverlay, setHighlight, info, label: (track && track.label) || '' };
    } catch (e) {
      stop();
      throw e;
    }
  }

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  // Cameras on this device. Names are only filled in once camera permission has been given.
  async function cameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }
  // One frame through the filter, for testing: {canvas, gamma, mean}.
  const testFilter = new GammaFilter();
  const filterFrame = (src, mode, box = null) => ({ canvas: testFilter.apply(src, mode, box), gamma: testFilter.gamma, mean: testFilter.mean });
  DL.camera = { start, supported, cameras, model: loadModel, preload: () => Promise.all([loadLandmarker(), loadModel()]), landmarker: loadLandmarker, setGamma, gamma: () => gammaMode, filterFrame, setModel, modelChoice: () => modelChoice };
})();
