'use strict';
// Camera tracking. MediaPipe Pose Landmarker (Google, loaded from a CDN on first use) finds
// 33 body landmarks in each video frame; DLMotion turns them into joint angles, classifies
// the last 3 seconds of movement with the trained model, and counts reps.
// Everything runs in the browser: video frames never leave the device.
(() => {
  const VERSION = '0.10.14';
  const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
  const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  const WINDOW_MS = 3000;
  const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32]];
  const NEEDED = [11, 12, 23, 24, 25, 26, 27, 28]; // shoulders, hips, knees, ankles

  let landmarker = null;
  let model = null;

  function loadLandmarker() {
    if (!landmarker) {
      landmarker = (async () => {
        const vision = await import(`${BASE}/vision_bundle.mjs`);
        const files = await vision.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
        const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: POSE_MODEL, delegate }, runningMode: 'VIDEO', numPoses: 1 });
        try {
          return await make('GPU');
        } catch {
          return make('CPU'); // no WebGL2 on this device
        }
      })();
      landmarker.catch(() => (landmarker = null)); // allow a retry after a network failure
    }
    return landmarker;
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

  function drawSkeleton(ctx, lm, w, h, color) {
    ctx.lineWidth = Math.max(3, w / 160);
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    for (const [a, b] of BONES) {
      if (lm[a].visibility < 0.4 || lm[b].visibility < 0.4) continue;
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      if (lm[i].visibility < 0.4) continue;
      ctx.beginPath();
      ctx.arc(lm[i].x * w, lm[i].y * h, ctx.lineWidth * 1.1, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // onFrame({visible, fullBody, angles, t, pred}) is called for every processed frame.
  // Camera choice: deviceId (a specific webcam) or facing ('user' = selfie, 'environment' = rear).
  async function start({ video, overlay, onFrame, onStatus = () => {}, deviceId = null, facing = 'user' }) {
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
      const [lm, net] = await Promise.all([loadLandmarker(), loadModel()]);
      onStatus('');
      const ctx = overlay.getContext('2d');
      let frames = [], times = [], lastPred = 0, pred = null, lastSeen = 0, lastVideoTime = -1;

      const tick = () => {
        if (stopped) return;
        if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          const now = performance.now();
          const res = lm.detectForVideo(video, now);
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
            const fullBody = NEEDED.every((i) => img[i].visibility > 0.5);
            // Side-on: the shoulders look narrow next to the torso. One camera tracks best facing it.
            const shoulders = Math.hypot((img[11].x - img[12].x) * w, (img[11].y - img[12].y) * h);
            const torso = Math.hypot(((img[11].x + img[12].x - img[23].x - img[24].x) / 2) * w, ((img[11].y + img[12].y - img[23].y - img[24].y) / 2) * h) || 1;
            const sideOn = shoulders / torso < 0.35;
            drawSkeleton(ctx, img, w, h, fullBody ? '#5fd1ae' : '#f2c14e');
            const angles = DLMotion.frameAngles(DLMotion.pointsFromLandmarks(world), DLMotion.pointsFromImage(img, w, h));
            if (fullBody) {
              frames.push(angles);
              times.push(now);
              while (times.length && now - times[0] > WINDOW_MS) {
                frames.shift();
                times.shift();
              }
              if (now - lastPred > 500 && now - times[0] > WINDOW_MS / 2) {
                lastPred = now;
                const p = DLMotion.predict(net, DLMotion.windowFeatures(frames, times));
                const k = p.indexOf(Math.max(...p));
                pred = { label: net.classes[k], prob: p[k], active: net.classes[k] !== DLMotion.IDLE };
              }
            }
            onFrame({ visible: true, fullBody, sideOn, angles, t: now, pred });
          } else if (now - lastSeen > 800) {
            frames = [];
            times = [];
            pred = null;
            onFrame({ visible: false, fullBody: false, angles: null, t: now, pred: null });
          }
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else requestAnimationFrame(tick);
      };
      tick();
      return { stop, mirrored, label: (track && track.label) || '' };
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
