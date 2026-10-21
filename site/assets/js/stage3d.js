// The stage: a 3D bar resting on its cord, over its resonator tube, bending in a chosen partial.
// three.js is self-hosted. Without WebGL the stage falls back to a flat drawing that still moves.
import * as THREE from '../vendor/three.module.min.js';
import { svg } from './draw.js';

const N_VISUAL_HZ = 0.9;  // the motion is slowed right down so the eye can follow it
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// A procedural rosewood texture: dark streaks in a warm brown, a little figure. Deterministic.
function woodTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#7c3524';
  g.fillRect(0, 0, c.width, c.height);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 140; k++) {
    const y = rnd() * c.height, amp = 2 + rnd() * 7, f = 0.002 + rnd() * 0.01, ph = rnd() * 6.3;
    g.strokeStyle = rnd() < 0.5 ? `rgba(40,12,6,${0.15 + rnd() * 0.35})` : `rgba(170,90,60,${0.08 + rnd() * 0.15})`;
    g.lineWidth = 0.6 + rnd() * 2.6;
    g.beginPath();
    for (let x = 0; x <= c.width; x += 8) g.lineTo(x, y + Math.sin(x * f + ph) * amp);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// Builds the bar's mesh. Each face group has its own vertices (crisp edges); `index` records which
// sample along the bar each vertex belongs to, so the bending can move them.
function barGeometry(bar, S) {
  const n = bar.profile.length;
  const L = bar.length * S, W = bar.width * S;
  const xs = Array.from({ length: n }, (_, i) => (i / (n - 1) - 0.5) * L);
  const pos = [], uv = [], index = [], tris = [];
  const add = (x, y, z, u, v, i) => { pos.push(x, y, z); uv.push(u, v); index.push(i); return index.length - 1; };
  const strip = (fa, fb, flip) => {
    // fa/fb give [x, y, z, u, v] for the two edges at sample i
    let prev = null;
    for (let i = 0; i < n; i++) {
      const a = add(...fa(i), i), b = add(...fb(i), i);
      if (prev) flip ? tris.push(prev[0], b, prev[1], prev[0], a, b) : tris.push(prev[0], prev[1], b, prev[0], b, a);
      prev = [a, b];
    }
  };
  const h = (i) => -bar.profile[i] * S;
  const u = (i) => i / (n - 1);
  strip((i) => [xs[i], 0, W / 2, u(i), 0], (i) => [xs[i], 0, -W / 2, u(i), 0.25], false);          // top
  strip((i) => [xs[i], h(i), W / 2, u(i), 0.5], (i) => [xs[i], h(i), -W / 2, u(i), 0.75], true);     // underside
  strip((i) => [xs[i], 0, W / 2, u(i), 0.0], (i) => [xs[i], h(i), W / 2, u(i), 0.1], true);          // front
  strip((i) => [xs[i], 0, -W / 2, u(i), 0.3], (i) => [xs[i], h(i), -W / 2, u(i), 0.4], false);       // back
  for (const [i, sgn] of [[0, -1], [n - 1, 1]]) {
    const a = add(xs[i], 0, W / 2, 0, 0, i), b = add(xs[i], 0, -W / 2, 0.1, 0, i);
    const c2 = add(xs[i], h(i), -W / 2, 0.1, 0.1, i), d = add(xs[i], h(i), W / 2, 0, 0.1, i);
    sgn < 0 ? tris.push(a, c2, b, a, d, c2) : tris.push(a, b, c2, a, c2, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  return { geo, index, rest: Float32Array.from(pos) };
}

export function createStage(container, initial) {
  const state = {
    bar: initial.bar,
    metal: !!initial.metal,
    mode: 0,          // which partial is shown bending (0-based), or -1 for none
    strikeAt: -1,     // time of the last strike (s), for the decaying combined motion
    tube: initial.tube ?? true,
  };
  if (!hasWebGL()) return flatStage(container, state);
  container.dataset.mode = 'webgl';

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 16 / 10, 0.1, 100);
  camera.position.set(0, 2.1, 7.4);
  camera.lookAt(0, -0.55, 0);
  scene.add(new THREE.HemisphereLight(0xffe9d6, 0x2a1810, 1.4));
  const key = new THREE.DirectionalLight(0xfff3e6, 2.4);
  key.position.set(-3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xd6a547, 1.2);
  rim.position.set(4, 1.5, -4);
  scene.add(rim);

  const rig = new THREE.Group();
  scene.add(rig);
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.55, metalness: 0.0 });
  const alu = new THREE.MeshStandardMaterial({ color: 0xd4d8de, roughness: 0.3, metalness: 0.45 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xcf9d45, roughness: 0.38, metalness: 0.4 });
  const felt = new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.95 });
  const cordMat = new THREE.MeshStandardMaterial({ color: 0xe9dcc6, roughness: 0.8 });
  const nodeMat = new THREE.LineBasicMaterial({ color: 0xf6e6cf, transparent: true, opacity: 0.9 });

  let mesh = null, geomInfo = null, extras = new THREE.Group(), nodeLines = new THREE.Group();
  rig.add(extras, nodeLines);
  let S = 1;

  function build() {
    const bar = state.bar;
    S = 4 / bar.length;
    if (mesh) { rig.remove(mesh); mesh.geometry.dispose(); }
    geomInfo = barGeometry(bar, S);
    mesh = new THREE.Mesh(geomInfo.geo, state.metal ? alu : wood);
    rig.add(mesh);
    extras.clear();
    const h0 = bar.thickness * S, W = bar.width * S;
    const nodes = bar.nodes[0] || [];
    for (const xn of nodes) {
      const x = (xn / bar.length - 0.5) * bar.length * S;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, W * 2.6), felt);
      rail.position.set(x, -h0 - 0.08, 0);
      extras.add(rail);
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, W * 2.4, 10), cordMat);
      cord.rotation.x = Math.PI / 2;
      cord.position.set(x, -h0 * 0.45, 0);
      extras.add(cord);
    }
    if (state.tube && bar.freq[0] > 0) {
      // A quarter-wave tube, closed at the bottom: about c / (4 f) minus an end correction.
      const r = Math.min(bar.width * 0.42, 0.04);
      const len = Math.max(0.03, 343 / (4 * bar.freq[0]) - 0.6 * r);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(r * S, r * S, Math.min(len * S, 7), 40, 1, true), brass);
      tube.position.set(0, -h0 - 0.32 - Math.min(len * S, 7) / 2, 0);
      tube.material.side = THREE.DoubleSide;
      extras.add(tube);
    }
    drawNodes();
  }

  function drawNodes() {
    nodeLines.clear();
    if (state.mode < 0) return;
    const bar = state.bar, W = bar.width * S;
    for (const xn of bar.nodes[state.mode] || []) {
      const x = (xn / bar.length - 0.5) * bar.length * S;
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0.006, W / 2 + 0.02), new THREE.Vector3(x, 0.006, -W / 2 - 0.02)]);
      nodeLines.add(new THREE.Line(g, nodeMat));
    }
  }

  // Bending: displacement at sample i, combining the shown partial and any recent strike.
  const disp = new Float32Array(state.bar.profile.length);
  function bend(t) {
    const bar = state.bar;
    const n = bar.profile.length;
    disp.fill(0);
    const calm = reducedMotion();
    if (state.mode >= 0) {
      const a = calm ? 0.09 : 0.11 * Math.sin(2 * Math.PI * N_VISUAL_HZ * t);
      const s = bar.shapes[state.mode];
      for (let i = 0; i < n; i++) disp[i] += a * s[i];
    }
    let active = state.mode >= 0 && !calm;
    if (state.strikeAt >= 0) {
      const dt = t - state.strikeAt;
      if (dt < 4) {
        for (let k = 0; k < 3; k++) {
          const s = bar.shapes[k];
          if (!s) continue;
          const a = (calm ? 0 : 0.16) * Math.exp(-dt * (1.2 + k)) * Math.sin(2 * Math.PI * N_VISUAL_HZ * Math.sqrt(bar.freq[k] / bar.freq[0]) * 1.4 * dt) * [1, 0.45, 0.25][k];
          for (let i = 0; i < n; i++) disp[i] += a * s[i];
        }
        active = active || !calm;
      } else {
        state.strikeAt = -1;
      }
    }
    const p = geomInfo.geo.attributes.position;
    for (let v = 0; v < geomInfo.index.length; v++) p.array[v * 3 + 1] = geomInfo.rest[v * 3 + 1] + disp[geomInfo.index[v]];
    p.needsUpdate = true;
    geomInfo.geo.computeVertexNormals();
    return active;
  }

  // Dragging turns the instrument a little.
  let yaw = -0.35, pitch = 0, dragging = null;
  rig.rotation.y = yaw;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    dragging = { x: e.clientX, y: e.clientY, yaw, pitch };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw = Math.max(-1.2, Math.min(1.2, dragging.yaw + (e.clientX - dragging.x) * 0.008));
    pitch = Math.max(-0.25, Math.min(0.35, dragging.pitch + (e.clientY - dragging.y) * 0.004));
    kick();
  });
  const endDrag = () => { dragging = null; };
  renderer.domElement.addEventListener('pointerup', endDrag);
  renderer.domElement.addEventListener('pointercancel', endDrag);

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Frame the bar so it spans most of the width, whatever the screen's shape.
    const hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
    const dist = Math.max(4.6, 2.35 / Math.tan(hfov / 2));
    // Low and a little to the side, so the arch on the underside reads in profile.
    camera.position.set(0, dist * 0.13, dist);
    camera.lookAt(0, -0.42, 0);
    camera.updateProjectionMatrix();
    kick();
  }

  let running = false, visible = true;
  const clock = new THREE.Clock();
  function frame() {
    if (!visible) { running = false; return; }
    rig.rotation.y = yaw;
    rig.rotation.x = pitch;
    const active = bend(clock.getElapsedTime());
    renderer.render(scene, camera);
    if (active || dragging) requestAnimationFrame(frame);
    else running = false;
  }
  function kick() {
    if (!running) { running = true; requestAnimationFrame(frame); }
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); }).observe(container);
  }
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(container);

  build();
  resize();
  return {
    mode: 'webgl',
    setBar(bar, metal = state.metal) {
      state.bar = bar;
      state.metal = metal;
      build();
      kick();
    },
    setMode(k) {
      state.mode = k;
      drawNodes();
      kick();
    },
    strike() {
      state.strikeAt = clock.getElapsedTime();
      kick();
    },
  };
}

// Without WebGL: a side view drawn in SVG that bends the same way.
function flatStage(container, state) {
  container.dataset.mode = 'flat';
  const start = performance.now();
  let raf = 0;
  function draw() {
    const bar = state.bar, n = bar.profile.length;
    const W = 1000, H = 625, padX = 70, L = W - padX * 2, sx = L / bar.length, sy = sx * 2.2, top = H * 0.42;
    const t = (performance.now() - start) / 1000;
    const calm = reducedMotion();
    const disp = new Array(n).fill(0);
    if (state.mode >= 0) {
      const a = calm ? 26 : 30 * Math.sin(2 * Math.PI * N_VISUAL_HZ * t);
      bar.shapes[state.mode].forEach((v, i) => { disp[i] += a * v; });
    }
    const X = (i) => padX + (L * i) / (n - 1);
    const topPts = disp.map((d, i) => `${X(i).toFixed(1)},${(top - d).toFixed(1)}`);
    const botPts = bar.profile.map((h, i) => `${X(i).toFixed(1)},${(top + h * sy - disp[i]).toFixed(1)}`).reverse();
    const kids = [
      svg('path', { d: `M${topPts.join(' L')} L${botPts.join(' L')} Z`, fill: state.metal ? '#c8ccd2' : '#8e3e28' }),
    ];
    for (const xn of (state.mode >= 0 ? bar.nodes[state.mode] : []) || []) {
      const x = padX + (xn / bar.length) * L;
      kids.push(svg('line', { x1: x, x2: x, y1: top - 60, y2: top + bar.thickness * sy + 40, stroke: '#f1e6dc', 'stroke-dasharray': '4 6', 'stroke-width': 1.5 }));
    }
    container.replaceChildren(svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'The bar, seen from the side' }, kids));
    if (state.mode >= 0 && !calm) raf = requestAnimationFrame(draw);
  }
  draw();
  return {
    mode: 'flat',
    setBar(bar, metal = state.metal) { state.bar = bar; state.metal = metal; cancelAnimationFrame(raf); draw(); },
    setMode(k) { state.mode = k; cancelAnimationFrame(raf); draw(); },
    strike() {},
  };
}
