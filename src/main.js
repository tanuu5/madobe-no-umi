import * as THREE from 'three';
import { createSky } from './sky.js';
import { createSea, MAX_BOATS } from './sea.js';
import { createLand } from './land.js';
import { ViewRig } from './rig.js';
import { createPost } from './post.js';
import { sampleTime } from './timeofday.js';
import { createInterior } from './interior.js';
import { createBoats } from './boats.js';
import { createGulls } from './gulls.js';
import { toonRamp } from './textures.js';
import { Ambience } from './audio.js';
import { createUI } from './ui.js';

const ASSETS = new URL('../assets/', import.meta.url);

const canvas = document.getElementById('scene');
const veil = document.getElementById('veil');
const veilBar = document.getElementById('veil-bar');
const veilMsg = document.getElementById('veil-msg');

function progress(f) { veilBar.style.width = `${Math.round(f * 100)}%`; }

async function loadAll() {
  const manager = new THREE.LoadingManager();
  let loaded = 0;
  const total = 8;
  const step = () => progress(++loaded / total);
  const tex = (name, srgb = true, mips = true) => new Promise((res, rej) => {
    new THREE.TextureLoader(manager).load(new URL(name, ASSETS).href, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      t.generateMipmaps = mips;
      t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      step();
      res(t);
    }, undefined, rej);
  });
  const [scene, depthBuf, landTex, landAlpha, landAux, seaTex, seaAux, lights] = await Promise.all([
    fetch(new URL('scene.json', ASSETS)).then((r) => r.json()).then((j) => { step(); return j; }),
    fetch(new URL('depth.json', ASSETS)).then((r) => r.json()).then((j) => { step(); return decodeDepth(j); }),
    tex('land.webp'),
    tex('land_alpha.png', false),
    tex('land_aux.png', false),
    tex('sea.webp'),
    tex('sea_aux.png', false),
    tex('lights.png', false, false),
  ]);
  return { scene, depth: depthBuf, landTex, landAlpha, landAux, seaTex, seaAux, lights };
}

// depth grid: log depth quantised to 16 bits, little endian, base64
function decodeDepth(j) {
  const bin = atob(j.data);
  const out = new Float32Array(bin.length / 2);
  const a = Math.log(j.zmin);
  const b = Math.log(j.zmax) - a;
  for (let i = 0; i < out.length; i++) {
    const q = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    out[i] = Math.exp(a + (q / 65535) * b);
  }
  return out;
}

function sampleCoverage(texture, nx, ny) {
  const c = document.createElement('canvas');
  c.width = nx;
  c.height = ny;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(texture.image, 0, 0, nx, ny);
  const d = g.getImageData(0, 0, nx, ny).data;
  const out = new Uint8ClampedArray(nx * ny);
  for (let i = 0; i < nx * ny; i++) out[i] = d[i * 4];
  return out;
}

async function main() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const A = await loadAll();
  const cam = A.scene.camera;
  const image = A.scene.image;

  // --- the camera that took the photo -------------------------------------------
  const photoCam = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(2 * Math.atan(image.height / 2 / cam.focal)),
    image.width / image.height, 1, 60000,
  );
  photoCam.position.set(0, cam.height, 0);
  photoCam.rotation.set(-cam.pitch, 0, 0, 'YXZ');
  photoCam.updateMatrixWorld(true);
  photoCam.updateProjectionMatrix();
  const photoVP = new THREE.Matrix4().multiplyMatrices(photoCam.projectionMatrix, photoCam.matrixWorldInverse);

  // --- shared uniforms ------------------------------------------------------------
  const U = {
    uTime: { value: 0 },
    uZenith: { value: new THREE.Vector3() },
    uSkyMid: { value: new THREE.Vector3() },
    uHorizon: { value: new THREE.Vector3() },
    uHaze: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunGlow: { value: new THREE.Vector3() },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonGlow: { value: new THREE.Vector3() },
  };
  const skyU = {
    ...U,
    uStars: { value: 0 },
    uSunDisk: { value: 0 },
    uSunDiskColor: { value: new THREE.Vector3(1, 0.7, 0.4) },
    uMoonDisk: { value: 0 },
    uMoonColor: { value: new THREE.Vector3(1, 1, 1) },
    uCloudLit: { value: new THREE.Vector3() },
    uCloudShade: { value: new THREE.Vector3() },
    uCloudRim: { value: new THREE.Vector3() },
    uCloudBank: { value: 1 },
    uStreaks: { value: 1 },
  };
  const boatVecs = Array.from({ length: MAX_BOATS }, () => new THREE.Vector4(0, 0, 0, 0));
  const seaU = {
    ...U,
    uSeaTex: { value: A.seaTex },
    uSeaAux: { value: A.seaAux },
    uPhotoVP: { value: photoVP },
    uSeaTint: { value: new THREE.Vector3(1, 1, 1) },
    uSeaSat: { value: 1 },
    uReflect: { value: 0.3 },
    uGlitter: { value: 1 },
    uGlitterColor: { value: new THREE.Vector3(1, 1, 1) },
    uGlitterDir: { value: new THREE.Vector3(0, 1, 0) },
    uGlitterSigma: { value: 0.1 },
    uStrokes: { value: 1 },
    uFoamColor: { value: new THREE.Vector3(1, 1, 1) },
    uFogAmt: { value: 0.3 },
    uBoats: { value: boatVecs },
    uBoatWake: { value: new Array(MAX_BOATS).fill(0) },
  };
  const landU = {
    uTime: U.uTime,
    uLandTex: { value: A.landTex },
    uLandAlpha: { value: A.landAlpha },
    uLandAux: { value: A.landAux },
    uAuxTexel: { value: new THREE.Vector2(1 / image.width, 1 / image.height) },
    uWind: { value: 1 },
    uLandTint: { value: new THREE.Vector3(1, 1, 1) },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uSunTint: { value: new THREE.Vector3(1, 1, 1) },
    uLandSat: { value: 1 },
    uLandHaze: { value: new THREE.Vector3() },
    uLandHazeAmt: { value: 0.1 },
    uFarHaze: { value: 0.2 },
    uLights: { value: A.lights },
    uWindows: { value: 0 },
  };

  // --- exterior ---------------------------------------------------------------------
  const exterior = new THREE.Scene();
  exterior.add(createSky(skyU));
  exterior.add(createSea(seaU));
  const coverage = sampleCoverage(A.landAlpha, A.scene.depth.nx, A.scene.depth.ny);
  exterior.add(createLand({
    depth: A.depth, nx: A.scene.depth.nx, ny: A.scene.depth.ny, step: A.scene.depth.step,
    cam, image, photoCam, coverage, uniforms: landU,
  }));

  // boats and gulls are lit like the rest of the painting
  const extRamp = toonRamp([0.5, 0.72, 0.9, 1.0]);
  const extSun = new THREE.DirectionalLight('#ffffff', 2.4);
  const extHemi = new THREE.HemisphereLight('#dfe8ff', '#6d8fa8', 1.1);
  exterior.add(extSun, extSun.target, extHemi);
  const boats = createBoats({ photoCam, image, seaUniforms: seaU, ramp: extRamp });
  exterior.add(boats.group);
  const gulls = createGulls({ origin: photoCam.position, ramp: extRamp });
  exterior.add(gulls.group);

  // --- interior ---------------------------------------------------------------------
  const interior = new THREE.Scene();
  const room = createInterior({ origin: photoCam.position });
  interior.add(room.group);

  // --- cameras ------------------------------------------------------------------------
  const extCam = new THREE.PerspectiveCamera(43, 16 / 9, 0.5, 60000);
  const intCam = new THREE.PerspectiveCamera(43, 16 / 9, 0.02, 60);
  const basePitch = cam.pitch - THREE.MathUtils.degToRad(1);
  const rig = new ViewRig({ origin: photoCam.position, basePitch, interiorCam: intCam, exteriorCam: extCam, element: canvas });

  const post = createPost(renderer, { exterior, interior, extCam, intCam });

  // resolution follows the frame rate: full density when the GPU keeps up, less when not
  let quality = 1;
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const budget = 3.9e6;
    const pr = Math.max(0.6, Math.min(dpr, 2, Math.sqrt(budget / (w * h))) * quality);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    post.setSize(w, h, pr);
    rig.resize(w / h);
  }
  window.addEventListener('resize', resize);
  resize();

  // --- time of day ----------------------------------------------------------------------
  const state = { t: 1, target: 1, mode: 'fixed' };

  function applyTime(s) {
    U.uZenith.value.copy(s.zenith);
    U.uSkyMid.value.copy(s.skyMid);
    U.uHorizon.value.copy(s.horizon);
    U.uHaze.value.copy(s.haze);
    U.uSunDir.value.copy(s.sunDir);
    U.uSunGlow.value.copy(s.sunGlow);
    U.uMoonDir.value.copy(s.moonDir);
    U.uMoonGlow.value.copy(s.moonGlow);
    skyU.uStars.value = s.stars;
    skyU.uSunDisk.value = s.sunDisk;
    skyU.uSunDiskColor.value.copy(s.sunColor);
    skyU.uMoonDisk.value = s.moonDisk;
    skyU.uMoonColor.value.copy(s.moonColor);
    skyU.uCloudLit.value.copy(s.cloudLit);
    skyU.uCloudShade.value.copy(s.cloudShade);
    skyU.uCloudRim.value.copy(s.cloudRim);
    skyU.uCloudBank.value = s.cloudBank;
    skyU.uStreaks.value = s.streaks;

    seaU.uSeaTint.value.copy(s.seaTint);
    seaU.uSeaSat.value = s.seaSat;
    seaU.uReflect.value = s.reflect;
    seaU.uGlitter.value = s.glitter;
    seaU.uGlitterColor.value.copy(s.glitterColor);
    // glitter follows the sun by day and the moon by night
    const sunUp = THREE.MathUtils.smoothstep(s.sunDir.y, -0.02, 0.05);
    seaU.uGlitterDir.value.copy(s.moonDir).lerp(s.sunDir, sunUp).normalize();
    seaU.uGlitterSigma.value = s.glitterSigma;
    seaU.uStrokes.value = s.strokes;
    seaU.uFoamColor.value.copy(s.foam);
    seaU.uFogAmt.value = s.fogAmt;

    landU.uLandTint.value.copy(s.landTint);
    landU.uShadowTint.value.copy(s.shadowTint);
    landU.uSunTint.value.copy(s.sunTint);
    landU.uLandSat.value = s.landSat;
    landU.uLandHaze.value.copy(s.landHaze);
    landU.uLandHazeAmt.value = s.landHazeAmt;
    landU.uFarHaze.value = s.farHaze;
    landU.uWindows.value = s.windows;

    room.applyTime(s);

    const lightUp = THREE.MathUtils.smoothstep(s.sunDir.y, -0.03, 0.06);
    extSun.position.copy(s.moonDir).lerp(s.sunDir, lightUp).normalize().multiplyScalar(100);
    extSun.color.setRGB(s.sunColor.x, s.sunColor.y, s.sunColor.z);
    extSun.intensity = s.sunLight * lightUp + (1 - lightUp) * 0.3;
    extHemi.color.setRGB(s.hemiSky.x, s.hemiSky.y, s.hemiSky.z);
    extHemi.intensity = s.hemi;
    boats.setNight(s.windows);
    gulls.setVisible(1 - s.windows);

    const g = post.grade.uniforms;
    g.uExposure.value = s.exposure;
    g.uContrast.value = s.contrast;
    g.uSaturation.value = s.saturation;
    g.uLift.value.copy(s.lift);
    g.uVignette.value = s.vignette;
    post.bloom.strength = s.bloom;
  }

  // --- breeze shared by the curtain, the olive, the trees outside and the sound -------------
  const ambience = new Ambience();
  const ui = createUI({ state, ambience });
  const breeze = { value: 0.3, gust: 0, nextGust: 12 };
  function updateBreeze(dt, t) {
    if (t > breeze.nextGust) {
      breeze.gust = 1;
      breeze.nextGust = t + 16 + Math.random() * 26;
    }
    breeze.gust = Math.max(0, breeze.gust - dt / 6.5);
    const g = Math.sin(Math.PI * (1 - breeze.gust)) * (breeze.gust > 0 ? 1 : 0);
    breeze.value = 0.22 + 0.12 * Math.sin(t * 0.07) + 0.08 * Math.sin(t * 0.19 + 1) + g * 0.55;
    room.setWind(breeze.value);
    landU.uWind.value = 0.8 + breeze.value * 0.6;
    ambience.setWind(breeze.value);
  }

  // --- loop -------------------------------------------------------------------------------
  const timer = new THREE.Timer(); // THREE.Clock is deprecated since r183
  let elapsed = 0;
  // console hooks for tinkering: window.__finestra.state.target = 3, .paused = true,
  // .afterRender = (renderer) => { /* read pixels of the frame just drawn */ }
  const hooks = { paused: false, afterRender: null };
  const perf = { acc: 0, frames: 0, settle: 3 };
  function adapt(dt) {
    perf.acc += dt;
    perf.frames++;
    if (perf.acc < 2) return;
    const fps = perf.frames / perf.acc;
    perf.acc = 0;
    perf.frames = 0;
    if (perf.settle-- > 0) return; // ignore start-up hitches
    const before = quality;
    if (fps < 48) quality = Math.max(0.55, quality - 0.1);
    else if (fps > 58 && quality < 1) quality = Math.min(1, quality + 0.05);
    if (quality !== before) resize();
  }
  function frame() {
    requestAnimationFrame(frame);
    timer.update(); // also while paused, so resuming does not jump
    if (hooks.paused) return;
    const dt = Math.min(timer.getDelta(), 0.1);
    if (!document.hidden) adapt(dt);
    tick(dt);
  }
  hooks.step = tick;
  function tick(dt) {
    elapsed += dt;
    U.uTime.value = elapsed;
    post.grade.uniforms.uTime.value = elapsed;

    if (state.mode === 'cycle') state.target += dt / 80;
    const diff = state.target - state.t;
    state.t += diff * (1 - Math.exp(-dt * (state.mode === 'cycle' ? 8 : 0.75)));
    const tod = sampleTime(state.t);
    applyTime(tod);
    ambience.setNight(tod.windows);
    updateBreeze(dt, elapsed);
    ui.tick();

    rig.update(dt, elapsed);
    room.update(dt, elapsed);
    boats.update(dt, elapsed);
    gulls.update(dt, elapsed);
    post.render();
    if (hooks.afterRender) {
      const fn = hooks.afterRender;
      hooks.afterRender = null;
      fn(renderer);
    }
  }
  requestAnimationFrame(frame);

  veil.classList.add('done');
  window.__finestraStarted = true;
  window.__finestra = Object.assign(hooks, { state, rig, U, seaU, landU, skyU, renderer, post, gulls, boats, room, ambience });
  return state;
}

main().catch((err) => {
  console.error(err);
  veilMsg.textContent = 'この環境では風景を表示できませんでした（WebGL2 が必要です）。別のブラウザで開いてみてください。';
});
