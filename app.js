import * as THREE from './vendor/three/three.module.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const video = $('cameraVideo');
const handCanvas = $('handCanvas');
const handCtx = handCanvas.getContext('2d');
const statusText = $('statusText');
const statusDot = $('statusDot');
const gestureLabel = $('gestureLabel');
const confidenceLabel = $('confidenceLabel');
const cameraButton = $('cameraButton');
const cameraButtonText = $('cameraButtonText');
const densityInput = $('densityInput');
const volumeInput = $('volumeInput');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
camera.position.z = 11.5;
const shapeGroup = new THREE.Group();
scene.add(shapeGroup);

const particleMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  uniforms: { uOpacity: { value: 0 } },
  vertexShader: `
    attribute vec3 aColor;
    attribute float aSize;
    varying vec3 vColor;
    void main(){
      vColor=aColor;
      vec4 mv=modelViewMatrix*vec4(position,1.0);
      gl_PointSize=clamp(aSize*(32.0/-mv.z),1.2,15.0);
      gl_Position=projectionMatrix*mv;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    uniform float uOpacity;
    void main(){
      float d=length(gl_PointCoord-vec2(0.5));
      float core=1.0-smoothstep(0.12,0.48,d);
      float glow=(1.0-smoothstep(0.0,0.5,d))*0.22;
      float alpha=core*0.85+glow;
      if(alpha<0.02)discard;
      gl_FragColor=vec4(vColor,alpha*uOpacity);
    }
  `
});

const starGeometry = new THREE.BufferGeometry();
const starPositions = new Float32Array(900 * 3);
for (let i = 0; i < 900; i++) {
  starPositions[i * 3] = (Math.random() - 0.5) * 38;
  starPositions[i * 3 + 1] = (Math.random() - 0.5) * 23;
  starPositions[i * 3 + 2] = -7 - Math.random() * 7;
}
starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x68a7a8, size: 0.024, transparent: true, opacity: 0.42, depthWrite: false }));
scene.add(stars);

let points = null;
let photoMesh = null;
let base = new Float32Array(0);
let positions = new Float32Array(0);
let scatter = new Float32Array(0);
let seeds = new Float32Array(0);
let particleCount = 0;
let modelImage = null;
let uploadedObjectUrl = null;
let mode = 'idle';
let modeLevel = 0;
let photoReveal = 1;
let cameraRunning = false;
let recognizer = null;
let stream = null;
let lastVideoTime = -1;
let lastDetectAt = 0;
let lastHandAt = 0;
let candidateGesture = '';
let candidateFrames = 0;
let audioContext = null;
let audioGain = null;
let audioSource = null;
let audioReady = false;
let audioEnabled = true;
let usingDemo = false;
let pointerDown = false;
let pointerX = 0;
let pointerY = 0;
let userRotY = 0;
let userRotX = 0;
let userZoom = 0;
let frames = 0;
let fpsMark = performance.now();

function updateStatus(message, active = false) {
  statusText.textContent = message;
  statusDot.classList.toggle('on', active);
  document.querySelector('.live-dot').classList.toggle('on', active);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.position.z = (w < 760 ? 17 : 11.5) + userZoom;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function makeCloud(samples) {
  if (points) {
    shapeGroup.remove(points);
    points.geometry.dispose();
  }
  particleCount = samples.length;
  base = new Float32Array(particleCount * 3);
  positions = new Float32Array(particleCount * 3);
  scatter = new Float32Array(particleCount * 3);
  seeds = new Float32Array(particleCount);
  const colors = new Float32Array(particleCount * 3);
  const sizes = new Float32Array(particleCount);
  for (let i = 0; i < particleCount; i++) {
    const p = samples[i], k = i * 3;
    base[k] = p.x; base[k + 1] = p.y; base[k + 2] = p.z;
    positions[k] = p.x; positions[k + 1] = p.y; positions[k + 2] = p.z;
    const angle = Math.random() * Math.PI * 2;
    const lift = (Math.random() - 0.5) * 2;
    scatter[k] = Math.cos(angle) * (0.7 + Math.random() * 1.7);
    scatter[k + 1] = Math.sin(angle) * (0.7 + Math.random() * 1.7);
    scatter[k + 2] = lift * 1.5;
    seeds[i] = Math.random() * Math.PI * 2;
    colors[k] = p.r; colors[k + 1] = p.g; colors[k + 2] = p.b;
    sizes[i] = 1.15 + Math.random() * 1.1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  points = new THREE.Points(geometry, particleMaterial);
  points.frustumCulled = false;
  points.renderOrder = 1;
  shapeGroup.add(points);
}

function demoModel(count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const t = Math.random() * Math.PI * 2;
    const shell = Math.random() < 0.7;
    const r = shell ? 2.1 + 0.2 * Math.sin(t * 8) + (Math.random() - 0.5) * 0.12 : 0.9 + Math.random() * 1.0;
    const x = Math.cos(t) * r * 1.18;
    const y = Math.sin(t) * r * 0.86;
    const z = Math.sin(t * 3) * 0.45 + (Math.random() - 0.5) * 0.5;
    const warm = (Math.sin(t * 3) + 1) / 2;
    result.push({ x, y, z, r: 0.45 + warm * 0.43, g: 0.77 + warm * 0.13, b: 0.75 - warm * 0.28 });
  }
  makeCloud(result);
}

function imageToParticles(image, count) {
  if (photoMesh) {
    scene.remove(photoMesh);
    photoMesh.geometry.dispose();
    photoMesh.material.map.dispose();
    photoMesh.material.dispose();
  }
  const imageAspect = image.width / image.height;
  const photoWidth = Math.min(7, 5.25 * imageAspect);
  const photoHeight = photoWidth / imageAspect;
  const photoTexture = new THREE.Texture(image);
  photoTexture.needsUpdate = true;
  photoTexture.colorSpace = THREE.SRGBColorSpace;
  photoTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  photoMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(photoWidth, photoHeight),
    new THREE.MeshBasicMaterial({ map: photoTexture, transparent: true, opacity: photoReveal, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
  );
  photoMesh.position.z = 0.85;
  photoMesh.renderOrder = 2;
  scene.add(photoMesh);
  const w = 400, h = 300;
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = w; sampleCanvas.height = h;
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w / image.width, h / image.height);
  const dw = image.width * scale, dh = image.height * scale;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const raw = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    lum[i] = raw[k] * 0.2126 + raw[k + 1] * 0.7152 + raw[k + 2] * 0.0722;
    alpha[i] = raw[k + 3];
  }
  const edges = [], allPixels = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (alpha[i] < 80) continue;
      allPixels.push({ x, y });
      const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      const alphaEdge = Math.abs(alpha[i - 1] - alpha[i + 1]) + Math.abs(alpha[i - w] - alpha[i + w]);
      const strength = Math.hypot(gx, gy) + alphaEdge * 0.9;
      if (strength > 105) edges.push({ x, y });
    }
  }
  const pool = allPixels;
  if (!pool.length) {
    demoModel(count);
    updateStatus('图片缺少可识别轮廓，已显示演示模型', false);
    return;
  }
  const samples = [];
  for (let n = 0; n < count; n++) {
    const chooseEdge = n % 4 === 0 && edges.length;
    const list = chooseEdge ? edges : pool;
    const pick = list[(Math.random() * list.length) | 0];
    const x = Math.min(w - 1, Math.max(0, pick.x + (Math.random() - 0.5) * 2));
    const y = Math.min(h - 1, Math.max(0, pick.y + (Math.random() - 0.5) * 2));
    const k = ((pick.y | 0) * w + (pick.x | 0)) * 4;
    const r = raw[k] / 255, g = raw[k + 1] / 255, b = raw[k + 2] / 255;
    samples.push({
      x: (x / w - 0.5) * 7.0,
      y: (0.5 - y / h) * 5.25,
      z: (Math.random() - 0.5) * 0.4,
      r: Math.min(1, r * 0.9 + 0.08),
      g: Math.min(1, g * 0.9 + 0.08),
      b: Math.min(1, b * 0.9 + 0.08)
    });
  }
  makeCloud(samples);
}

async function loadDefaultImage() {
  const img = new Image();
  img.onload = () => {
    modelImage = img;
    imageToParticles(img, Number(densityInput.value));
    $('imageName').textContent = '已载入指定照片 · 点击可更换';
    $('sceneMode').textContent = 'PHOTO ↔ PARTICLES / TRANSFORMATION';
  };
  img.onerror = () => { demoModel(Number(densityInput.value)); updateStatus('默认图片载入失败，可手动上传', false); };
  img.src = './assets/model.jpg';
}
loadDefaultImage();

function setMode(next, confidence = null) {
  if (mode === next) return;
  mode = next;
  gestureLabel.textContent = next === 'open' ? '张开手掌 · 照片化为粒子' : next === 'fist' ? '握紧拳头 · 还原照片' : '未识别手势 · 显示照片';
  confidenceLabel.textContent = confidence == null ? '--' : `${Math.round(confidence * 100)}%`;
  $('demoOpen').classList.toggle('active', next === 'open' && usingDemo);
  $('demoFist').classList.toggle('active', next === 'fist' && usingDemo);
  $('demoIdle').classList.toggle('active', next === 'idle' && usingDemo);
  updateAudio();
}

async function prepareAudio() {
  if (audioReady) { await audioContext.resume(); return; }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) { updateStatus('浏览器不支持音频播放', cameraRunning); return; }
  audioContext = new AudioCtx();
  audioGain = audioContext.createGain();
  audioGain.gain.value = 0;
  audioGain.connect(audioContext.destination);
  try {
    const response = await fetch('./assets/background.aac');
    if (!response.ok) throw new Error('背景音文件未能载入');
    const bytes = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(bytes);
    audioSource = audioContext.createBufferSource();
    audioSource.buffer = audioBuffer;
    audioSource.loop = true;
    audioSource.connect(audioGain);
    audioSource.start();
    await audioContext.resume();
    audioReady = true;
    updateAudio();
  } catch (error) {
    console.error('背景音解码失败', error);
    updateStatus('背景音无法解码，请换用 Chrome 或 Edge', cameraRunning);
  }
}

function updateAudio() {
  if (!audioReady) return;
  const target = mode === 'fist' && audioEnabled ? Number(volumeInput.value) / 100 : 0;
  audioGain.gain.setTargetAtTime(target, audioContext.currentTime, target ? 0.35 : 0.22);
}

const HAND_LINES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function drawHand(landmarks) {
  if (!handCanvas.width || !handCanvas.height) return;
  handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
  if (!landmarks) return;
  handCtx.strokeStyle = '#a5f3de';
  handCtx.lineWidth = Math.max(1.5, handCanvas.width / 350);
  handCtx.shadowColor = '#7af7db';
  handCtx.shadowBlur = 8;
  for (const [a, b] of HAND_LINES) {
    handCtx.beginPath();
    handCtx.moveTo(landmarks[a].x * handCanvas.width, landmarks[a].y * handCanvas.height);
    handCtx.lineTo(landmarks[b].x * handCanvas.width, landmarks[b].y * handCanvas.height);
    handCtx.stroke();
  }
  handCtx.fillStyle = '#d5ffec';
  for (const p of landmarks) {
    handCtx.beginPath();
    handCtx.arc(p.x * handCanvas.width, p.y * handCanvas.height, 2.5, 0, Math.PI * 2);
    handCtx.fill();
  }
}

function handleRecognition(result) {
  const landmarks = result.landmarks?.[0];
  drawHand(landmarks);
  const choice = result.gestures?.[0]?.[0];
  const name = choice?.categoryName;
  const score = choice?.score || 0;
  if (landmarks) lastHandAt = performance.now();
  const next = score >= 0.47 && name === 'Open_Palm' ? 'open' : score >= 0.47 && name === 'Closed_Fist' ? 'fist' : '';
  if (next) {
    if (next === candidateGesture) candidateFrames++;
    else { candidateGesture = next; candidateFrames = 1; }
    if (candidateFrames >= 2) {
      usingDemo = false;
      setMode(next, score);
      confidenceLabel.textContent = `${Math.round(score * 100)}%`;
    }
  } else {
    candidateGesture = '';
    candidateFrames = 0;
    if (performance.now() - lastHandAt > 700) setMode('idle');
  }
}

async function startCamera() {
  if (cameraRunning) { stopCamera(); return; }
  prepareAudio();
  cameraButton.disabled = true;
  cameraButtonText.textContent = '连接中…';
  updateStatus('正在请求摄像头权限');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('请使用 HTTPS 或 localhost 打开此页面');
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    video.srcObject = stream;
    await video.play();
    handCanvas.width = video.videoWidth || 640;
    handCanvas.height = video.videoHeight || 480;
    $('cameraPlaceholder').hidden = true;
    cameraRunning = true;
    cameraButtonText.textContent = '关闭摄像头';
    updateStatus('摄像头已连接 · 正在加载手势模型', true);
    const { GestureRecognizer, FilesetResolver } = await import('./vendor/mediapipe/vision_bundle.mjs');
    const vision = await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm/', import.meta.url).href);
    const options = {
      baseOptions: { modelAssetPath: new URL('./vendor/mediapipe/gesture_recognizer.task', import.meta.url).href, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minTrackingConfidence: 0.5
    };
    try { recognizer = await GestureRecognizer.createFromOptions(vision, options); }
    catch { recognizer = await GestureRecognizer.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } }); }
    if (!cameraRunning) { recognizer.close(); recognizer = null; return; }
    updateStatus('正在识别手势', true);
  } catch (error) {
    console.error('摄像头或手势模型启动失败', error);
    if (recognizer) { recognizer.close(); recognizer = null; }
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    video.srcObject = null;
    cameraRunning = false;
    $('cameraPlaceholder').hidden = false;
    cameraButtonText.textContent = '重试摄像头';
    updateStatus(error.name === 'NotAllowedError' ? '未获摄像头权限，请在浏览器地址栏允许' : `启动失败：${error.message}`, false);
  } finally { cameraButton.disabled = false; }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  cameraRunning = false;
  if (recognizer) { recognizer.close(); recognizer = null; }
  handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
  $('cameraPlaceholder').hidden = false;
  cameraButtonText.textContent = '启动摄像头';
  updateStatus('摄像头已关闭');
  setMode('idle');
}

cameraButton.addEventListener('click', startCamera);
$('imageInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { updateStatus('请选择图片文件', cameraRunning); return; }
  if (uploadedObjectUrl) URL.revokeObjectURL(uploadedObjectUrl);
  uploadedObjectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { modelImage = img; imageToParticles(img, Number(densityInput.value)); $('imageName').textContent = file.name; $('sceneMode').textContent = 'CUSTOM IMAGE / PARTICLE OUTLINE'; };
  img.onerror = () => updateStatus('图片读取失败，请换一张图片', cameraRunning);
  img.src = uploadedObjectUrl;
});
densityInput.addEventListener('input', () => { $('densityValue').textContent = Number(densityInput.value).toLocaleString('en-US'); });
densityInput.addEventListener('change', () => { if (modelImage) imageToParticles(modelImage, Number(densityInput.value)); else demoModel(Number(densityInput.value)); });
volumeInput.addEventListener('input', () => { $('volumeValue').textContent = `${volumeInput.value}%`; updateAudio(); });
$('muteButton').addEventListener('click', () => { audioEnabled = !audioEnabled; $('muteButton').textContent = audioEnabled ? '♫ 声音开启' : '♫ 声音已关闭'; updateAudio(); if (audioEnabled) prepareAudio(); });
$('muteButton').textContent = '♫ 声音开启';
$('resetButton').addEventListener('click', () => { userRotX = 0; userRotY = 0; userZoom = 0; resize(); });
for (const [id, next] of [['demoOpen','open'],['demoFist','fist'],['demoIdle','idle']]) {
  $(id).addEventListener('click', () => { usingDemo = true; if (next === 'fist') prepareAudio(); setMode(next); });
}

canvas.addEventListener('pointerdown', e => { pointerDown = true; pointerX = e.clientX; pointerY = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => { if (!pointerDown) return; userRotY += (e.clientX - pointerX) * 0.005; userRotX += (e.clientY - pointerY) * 0.005; userRotX = Math.max(-0.8, Math.min(0.8, userRotX)); pointerX = e.clientX; pointerY = e.clientY; });
canvas.addEventListener('pointerup', () => { pointerDown = false; });
canvas.addEventListener('wheel', e => { e.preventDefault(); userZoom = Math.max(-4, Math.min(8, userZoom + e.deltaY * 0.006)); resize(); }, { passive: false });

function animate(now) {
  requestAnimationFrame(animate);
  const time = now * 0.001;
  if (cameraRunning && recognizer && video.readyState >= 2 && now - lastDetectAt > 80 && video.currentTime !== lastVideoTime) {
    lastDetectAt = now;
    lastVideoTime = video.currentTime;
    try { handleRecognition(recognizer.recognizeForVideo(video, now)); }
    catch (error) { console.warn('单帧手势识别失败', error); }
  }
  const target = mode === 'open' ? 1 : mode === 'fist' ? -1 : 0;
  modeLevel += (target - modeLevel) * 0.055;
  photoReveal += ((mode === 'open' ? 0 : 1) - photoReveal) * 0.075;
  if (photoMesh) photoMesh.material.opacity = photoReveal;
  particleMaterial.uniforms.uOpacity.value = 1 - photoReveal;
  const open = Math.max(0, modeLevel);
  const fist = Math.max(0, -modeLevel);
  if (points) {
    for (let i = 0; i < particleCount; i++) {
      const k = i * 3;
      const pulse = Math.sin(time * 1.35 + seeds[i]) * 0.026;
      positions[k] = base[k] * (1 + open * 0.11 - fist * 0.48) + scatter[k] * open * 0.23 + Math.sin(time * 0.47 + seeds[i]) * open * 0.055;
      positions[k + 1] = base[k + 1] * (1 + open * 0.11 - fist * 0.48) + scatter[k + 1] * open * 0.23 + Math.cos(time * 0.51 + seeds[i]) * open * 0.055;
      positions[k + 2] = base[k + 2] + scatter[k + 2] * open * 0.6 + pulse - base[k + 2] * fist * 0.35;
    }
    points.geometry.attributes.position.needsUpdate = true;
    shapeGroup.rotation.y = userRotY + Math.sin(time * 0.19) * (0.02 + open * 0.08);
    shapeGroup.rotation.x = userRotX + Math.sin(time * 0.15) * 0.04;
    shapeGroup.rotation.z = Math.sin(time * 0.13) * 0.025;
  }
  stars.rotation.z = time * 0.002;
  renderer.render(scene, camera);
  frames++;
  if (now - fpsMark > 1000) { $('fpsLabel').textContent = `${Math.round(frames * 1000 / (now - fpsMark))} FPS`; fpsMark = now; frames = 0; }
}
requestAnimationFrame(animate);
window.addEventListener('pagehide', () => { if (stream) stream.getTracks().forEach(track => track.stop()); if (uploadedObjectUrl) URL.revokeObjectURL(uploadedObjectUrl); });
