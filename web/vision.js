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
  const WINDOW_MS = 3000;
  const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32]];
  const NEEDED = [11, 12, 23, 24, 25, 26, 27, 28]; // shoulders, hips, knees, ankles
  // "Whole body in view" turns on when every needed joint is clearly seen and only turns off
  // when one is clearly lost, so standing near the edge of the picture does not flicker.
  const FULL_ON = 0.6, FULL_OFF = 0.3;
  const HOLD_MS = 300; // keep drawing the last pose through a frame or two with no detection

  const landmarkers = {};
  let model = null;

  function loadLandmarker(kind = preferredModel()) {
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
    const kind = preferredModel();
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
          const res = lm.detectForVideo(video, now);
          if (!document.hidden && detected < 90) {
            if (++detected > 30) detectSum += performance.now() - now;
            if (detected === 90) detectMs = detectSum / 60;
          }
          if (kind === 'full' && detected === 90 && detectMs > SLOW_MS) {
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
            onFrame({ visible: true, fullBody, sideOn, angles, smooth: sm.angles, metrics: sm.metrics, points, landmarks: img, t: now, pred });
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
              onFrame({ visible: false, fullBody: false, angles: null, smooth: null, metrics: null, points: null, landmarks: null, t: now, pred: null });
            }
          }
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else requestAnimationFrame(tick);
      };
      tick();
      const setOverlay = (on) => {
        showOverlay = !!on;
        if (!showOverlay) ctx.clearRect(0, 0, overlay.width, overlay.height);
      };
      const setHighlight = (ids) => (highlight = new Set(ids || []));
      const info = () => ({ model: kind, detectMs: detectMs === null ? null : Math.round(detectMs) });
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
  DL.camera = { start, supported, cameras, model: loadModel, preload: () => Promise.all([loadLandmarker(), loadModel()]), landmarker: loadLandmarker };
})();
