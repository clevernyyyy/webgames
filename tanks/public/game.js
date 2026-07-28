/**
 * game.js — Tank Battle client
 * Three.js rendering + WebSocket sync. Press V to toggle first-person view.
 */
import * as THREE from 'three';

// ─── Constants (mirror server) ────────────────────────────────────────────────
const PROJ_SPEED   = 110;
const PROJ_GRAVITY = 28;
const WORLD_SIZE   = 1500;

// ─── Renderer / scene ────────────────────────────────────────────────────────
const canvas   = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x7ec8e3);
scene.fog = new THREE.FogExp2(0x7ec8e3, 0.001);

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 4000);

const raycaster   = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener('resize', resize);

// ─── Lighting ─────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xd0e8ff, 0.7));

const sun = new THREE.DirectionalLight(0xfff2cc, 1.3);
sun.position.set(200, 400, 150);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -600; sc.right = sc.top = 600; sc.far = 2000;
scene.add(sun);

scene.add(new THREE.HemisphereLight(0x9bd4f5, 0x4a6741, 0.5));

// ─── Ground ───────────────────────────────────────────────────────────────────
const groundMat = new THREE.MeshLambertMaterial({ color: 0x4a7c2f });
const ground    = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 1, 1), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(WORLD_SIZE, 75, 0x3a6020, 0x3a6020);
grid.position.y = 0.05;
grid.material.transparent = true;
grid.material.opacity = 0.18;
scene.add(grid);

// ─── Trajectory preview ───────────────────────────────────────────────────────
const MAX_TRAJ = 150;
const trajGeo  = new THREE.BufferGeometry();
const trajPos  = new Float32Array(MAX_TRAJ * 3);
trajGeo.setAttribute('position', new THREE.BufferAttribute(trajPos, 3));
trajGeo.setDrawRange(0, 0);
const trajLine = new THREE.Line(
  trajGeo,
  new THREE.LineBasicMaterial({ color: 0xffff44, transparent: true, opacity: 0.5, depthTest: false })
);
scene.add(trajLine);

function updateTrajectory(tx, tz, worldYaw, pitch) {
  let x = tx, y = 2.2, z = tz;
  let vx = Math.sin(worldYaw) * Math.cos(pitch) * PROJ_SPEED;
  let vy = Math.sin(pitch) * PROJ_SPEED;
  let vz = Math.cos(worldYaw) * Math.cos(pitch) * PROJ_SPEED;
  let n = 0;
  const step = 0.07;
  while (n < MAX_TRAJ) {
    trajPos[n * 3]     = x;
    trajPos[n * 3 + 1] = y;
    trajPos[n * 3 + 2] = z;
    n++;
    vy -= PROJ_GRAVITY * step;
    x  += vx * step;
    y  += vy * step;
    z  += vz * step;
    if (y < 0) break;
  }
  trajGeo.attributes.position.needsUpdate = true;
  trajGeo.setDrawRange(0, n);
}

// ─── Static world — InstancedMesh (one draw-call per type, fast to build) ────
const dummy = new THREE.Object3D();

function buildObstacleInstances(obstacleData) {
  const rocks = obstacleData.filter(o => o.type === 'rock');
  const walls = obstacleData.filter(o => o.type === 'wall');
  const trees = obstacleData.filter(o => o.type === 'tree');

  const matRock   = new THREE.MeshLambertMaterial({ color: 0x7a7a7a });
  const matWall   = new THREE.MeshLambertMaterial({ color: 0x9b8060 });
  const matTrunk  = new THREE.MeshLambertMaterial({ color: 0x6b4226 });
  const matCanopy = new THREE.MeshLambertMaterial({ color: 0x2d6a2d });

  if (rocks.length) {
    const geo  = new THREE.DodecahedronGeometry(1, 0);
    const im   = new THREE.InstancedMesh(geo, matRock, rocks.length);
    rocks.forEach((o, i) => {
      dummy.position.set(o.x, o.height / 2, o.z);
      dummy.rotation.set(o.rot * 0.3, o.rot, 0);
      dummy.scale.set(o.radius, o.height / 2, o.radius);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    scene.add(im);
  }

  if (walls.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const im  = new THREE.InstancedMesh(geo, matWall, walls.length);
    walls.forEach((o, i) => {
      dummy.position.set(o.x, o.height / 2, o.z);
      dummy.rotation.set(0, o.rot, 0);
      dummy.scale.set(o.width, o.height, o.length);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    scene.add(im);
  }

  if (trees.length) {
    const trunkGeo  = new THREE.CylinderGeometry(0.45, 0.65, 1, 7);
    const canopyGeo = new THREE.ConeGeometry(1, 1, 7);
    const trunkIm   = new THREE.InstancedMesh(trunkGeo,  matTrunk,  trees.length);
    const canopyIm  = new THREE.InstancedMesh(canopyGeo, matCanopy, trees.length);
    trees.forEach((o, i) => {
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(o.x, o.trunkH / 2, o.z);
      dummy.scale.set(1, o.trunkH, 1);
      dummy.updateMatrix();
      trunkIm.setMatrixAt(i, dummy.matrix);

      const cH = o.height - o.trunkH;
      dummy.position.set(o.x, o.trunkH + cH / 2, o.z);
      dummy.scale.set(o.radius * 2.2, cH, o.radius * 2.2);
      dummy.updateMatrix();
      canopyIm.setMatrixAt(i, dummy.matrix);
    });
    trunkIm.instanceMatrix.needsUpdate  = true;
    canopyIm.instanceMatrix.needsUpdate = true;
    trunkIm.castShadow  = canopyIm.castShadow  = true;
    scene.add(trunkIm, canopyIm);
  }
}

// ─── Mountains — InstancedMesh ────────────────────────────────────────────────
function buildMountains() {
  const H    = WORLD_SIZE / 2;
  const ZONE = 120;
  const STEP = 60;

  let ms = 0xabc123;
  const mr = () => {
    ms = (ms * 1664525 + 1013904223) & 0x7fffffff;
    return ms / 0x7fffffff;
  };

  const peaks = [], snows = [];

  function addPeak(cx, cz) {
    const ht = 65 + mr() * 75;
    const r  = 30 + mr() * 35;
    const jx = (mr() - 0.5) * 25;
    const jz = (mr() - 0.5) * 25;
    const rotY = mr() * Math.PI * 2;
    peaks.push({ x: cx + jx, y: ht / 2, z: cz + jz, r, h: ht, rotY });
    if (ht > 95) {
      const sh = ht * 0.22, sr = r * 0.32;
      snows.push({ x: cx + jx, y: ht * 0.82 + sh / 2, z: cz + jz, r: sr, h: sh });
    }
  }

  for (let x = -H; x <= H + 1; x += STEP) {
    addPeak(x, -H + ZONE * 0.55); addPeak(x, -H + ZONE * 0.22);
    addPeak(x,  H - ZONE * 0.55); addPeak(x,  H - ZONE * 0.22);
  }
  for (let z = -H + STEP; z < H; z += STEP) {
    addPeak(-H + ZONE * 0.55, z); addPeak(-H + ZONE * 0.22, z);
    addPeak( H - ZONE * 0.55, z); addPeak( H - ZONE * 0.22, z);
  }

  const peakGeo = new THREE.ConeGeometry(1, 1, 8);
  const peakIm  = new THREE.InstancedMesh(peakGeo,
    new THREE.MeshLambertMaterial({ color: 0x6e7a6e }), peaks.length);
  peaks.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, p.rotY, 0);
    dummy.scale.set(p.r, p.h, p.r);
    dummy.updateMatrix();
    peakIm.setMatrixAt(i, dummy.matrix);
  });
  peakIm.instanceMatrix.needsUpdate = true;
  peakIm.castShadow = true;
  scene.add(peakIm);

  if (snows.length) {
    const snowIm = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7),
      new THREE.MeshLambertMaterial({ color: 0xdde8e8 }), snows.length);
    snows.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(s.r, s.h, s.r);
      dummy.updateMatrix();
      snowIm.setMatrixAt(i, dummy.matrix);
    });
    snowIm.instanceMatrix.needsUpdate = true;
    scene.add(snowIm);
  }
}

// ─── Pickup meshes ────────────────────────────────────────────────────────────
const PICKUP_COLORS = { speed: 0xf59e0b, ammo: 0xef4444, shield: 0x38bdf8, health: 0x4ade80, bomb: 0x222222 };

function buildPickup(type) {
  const g   = new THREE.Group();
  const col = PICKUP_COLORS[type] ?? 0xffffff;

  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(1.3, 10, 10),
    new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: 0.6,
      metalness: 0.2, roughness: 0.4, transparent: true, opacity: 0.88,
    })
  );
  g.add(orb);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.0, 0.18, 8, 32),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 })
  );
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  g.userData.ring = ring;

  g.add(new THREE.PointLight(col, 1.5, 12));
  return g;
}

// ─── Tank mesh factory ───────────────────────────────────────────────────────
// Returns { group, fpHideParts } — fpHideParts are hidden in first-person so
// only the barrel is visible from the gunner's seat.
function buildTank(hexColor) {
  const c      = new THREE.Color(hexColor);
  const cDk    = c.clone().multiplyScalar(0.65);
  const mat    = new THREE.MeshLambertMaterial({ color: c });
  const matDk  = new THREE.MeshLambertMaterial({ color: cDk });
  const matMet = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const matGun = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });

  const root       = new THREE.Group();
  const fpHideParts = [];   // hidden in FP view

  const hull = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.3, 5.2), mat);
  hull.position.y = 0.9;
  hull.castShadow = hull.receiveShadow = true;
  fpHideParts.push(hull);
  root.add(hull);

  for (const side of [-1, 1]) {
    const track = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 5.5), matMet);
    track.position.set(side * 2.15, 0.55, 0);
    track.castShadow = true;
    fpHideParts.push(track);
    root.add(track);
    for (let i = -2; i <= 2; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.25, 0.4), matDk);
      bar.position.set(side * 2.15, 1.12, i * 1.1);
      fpHideParts.push(bar);
      root.add(bar);
    }
  }

  const turretGroup = new THREE.Group();
  turretGroup.name = 'turret';
  turretGroup.position.y = 1.5;

  const turretBody = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.55, 1.0, 8), matDk);
  fpHideParts.push(turretBody);
  turretGroup.add(turretBody);

  const barrelPivot = new THREE.Group();
  barrelPivot.name  = 'barrelPivot';
  barrelPivot.position.y = 0.2;

  // Overhead barrel + muzzle (hidden in FP)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 4.8, 8), matGun);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = 2.4;
  barrel.castShadow = true;
  fpHideParts.push(barrel);
  barrelPivot.add(barrel);

  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, 0.5, 8), matGun);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.z = 4.9;
  fpHideParts.push(muzzle);
  barrelPivot.add(muzzle);

  turretGroup.add(barrelPivot);
  root.add(turretGroup);

  const shieldMesh = new THREE.Mesh(
    new THREE.SphereGeometry(4.8, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0, wireframe: true })
  );
  shieldMesh.name = 'shield';
  shieldMesh.position.y = 1.5;
  root.add(shieldMesh);

  return { group: root, fpHideParts };
}

function makeNameTag(name, hexColor) {
  const cv  = document.createElement('canvas');
  cv.width = 384; cv.height = 80;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.roundRect(2, 2, 380, 76, 12);
  ctx.fill();
  ctx.font = 'bold 48px Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hexColor;
  ctx.fillText(name.slice(0, 12), 192, 40);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
  sp.scale.set(10.5, 2.4, 1);
  sp.position.y = 7.5;
  return sp;
}

// ─── Explosion particles ──────────────────────────────────────────────────────
const explosions = [];
const POOL_GEO   = new THREE.SphereGeometry(0.38, 5, 5);

function spawnExplosion(x, y, z, big, hexColor) {
  const n   = big ? 22 : 9;
  const col = new THREE.Color(hexColor ?? '#ff6600');

  if (big) {
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(6, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffee44, transparent: true, opacity: 1 })
    );
    flash.position.set(x, y, z);
    flash.userData = { flash: true, life: 1, decay: 4 };
    scene.add(flash);
    explosions.push(flash);
  }

  for (let i = 0; i < n; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: i < n / 2 ? 0xff8800 : col, transparent: true, opacity: 1 });
    const p = new THREE.Mesh(POOL_GEO, mat);
    p.position.set(x, y, z);
    const spd = 6 + Math.random() * (big ? 20 : 10);
    const θ   = Math.random() * Math.PI * 2;
    const φ   = Math.random() * Math.PI / 2;
    p.userData = {
      vx: Math.cos(θ) * Math.cos(φ) * spd,
      vy: Math.sin(φ) * spd + (big ? 6 : 2),
      vz: Math.sin(θ) * Math.cos(φ) * spd,
      life: 1, decay: 1.2 + Math.random(),
    };
    scene.add(p);
    explosions.push(p);
  }

  if (big) camShake = 0.7;
}

const blastAnims = [];
function spawnBlast(x, y, z, radius) {
  // Expanding ground ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.1, 1, 40),
    new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.3, z);
  scene.add(ring);
  blastAnims.push({ mesh: ring, life: 1, radius });

  // Central fireball flash
  spawnExplosion(x, y, z, true, '#ff6600');
  camShake = 1.5;
}

function tickBlasts(dt) {
  for (let i = blastAnims.length - 1; i >= 0; i--) {
    const b = blastAnims[i];
    b.life -= dt * 1.8;
    const t = 1 - Math.max(0, b.life);
    const s = b.radius * t;
    b.mesh.scale.set(s, s, s);
    b.mesh.material.opacity = 0.85 * b.life;
    if (b.life <= 0) { scene.remove(b.mesh); blastAnims.splice(i, 1); }
  }
}

function tickExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const p = explosions[i];
    const d = p.userData;
    d.life -= dt * d.decay;
    if (d.flash) {
      p.material.opacity = Math.max(0, d.life);
      p.scale.setScalar(1 + (1 - d.life) * 3);
    } else {
      p.position.x += d.vx * dt;
      p.position.y += d.vy * dt;
      p.position.z += d.vz * dt;
      d.vy          -= 18 * dt;
      p.material.opacity = Math.max(0, d.life);
      p.scale.setScalar(Math.max(0.01, d.life));
    }
    if (d.life <= 0) { scene.remove(p); explosions.splice(i, 1); }
  }
}

// ─── Game state ───────────────────────────────────────────────────────────────
let myId       = null;
let gameState  = null;
let worldSize  = WORLD_SIZE;
let maxHealth  = 3;

// Client-side prediction for local player
const TANK_SPEED_CLIENT      = 30;
const TANK_TURN_CLIENT       = 2.0;
const SPEED_MULT_CLIENT      = 2.1;
const WORLD_HALF_CLIENT      = WORLD_SIZE / 2 - 120; // matches server HALF
const TANK_RADIUS_CLIENT     = 2.8;
let predX = 0, predZ = 0, predYaw = 0;
let predSpeedBoost = false;
let predReady = false;
let clientObstacles = [];

function clientWallCollides(px, pz, radius, wall) {
  const cos = Math.cos(-wall.rot), sin = Math.sin(-wall.rot);
  const dx = px - wall.x, dz = pz - wall.z;
  const lx = cos * dx - sin * dz;
  const lz = sin * dx + cos * dz;
  const nearX = Math.max(-wall.length / 2, Math.min(wall.length / 2, lx));
  const nearZ = Math.max(-wall.width  / 2, Math.min(wall.width  / 2, lz));
  return Math.hypot(lx - nearX, lz - nearZ) < radius;
}
function clientHitsObstacle(px, pz, radius) {
  for (const o of clientObstacles) {
    if (o.type === 'wall') {
      if (clientWallCollides(px, pz, radius, o)) return true;
    } else {
      if (Math.hypot(px - o.x, pz - o.z) < o.radius + radius) return true;
    }
  }
  return false;
}

const tankMeshes   = new Map();
const projMeshes   = new Map();
const pickupMeshes = new Map();

// ─── Input ────────────────────────────────────────────────────────────────────
const keys  = {};
let mouseX = innerWidth / 2, mouseY = innerHeight / 2;
let turretPitch = 0.04;
let firing  = false;
let camShake = 0;

// First-person state
let fpMode  = false;
let fpYaw   = 0;     // accumulated world yaw in FP (radians)
let fpPitch = 0.04;  // pitch in FP mode

// Mouse-drive mode: tank body faces mouse, W moves toward it
let mouseDriveMode = false;
function toggleMouseDrive() {
  mouseDriveMode = !mouseDriveMode;
  const el = document.getElementById('controls');
  if (el) el.innerHTML = mouseDriveMode
    ? 'W/S move · MOUSE steer · SPACE fire · M mode · V view'
    : 'WASD move · MOUSE aim · CLICK/SPACE fire · M mode · V view';
}

window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') { e.preventDefault(); firing = true; }
  if (e.code === 'KeyV') toggleFP();
  if (e.code === 'KeyM') toggleMouseDrive();
});
window.addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'Space') firing = false;
});

function toggleFP() {
  fpMode = !fpMode;
  if (fpMode) {
    const me = gameState?.players?.find(p => p.id === myId);
    fpYaw   = me ? (me.yaw + me.turretYaw) : 0;
    fpPitch = 0.04; // always start level — don't inherit scroll pitch
    canvas.requestPointerLock();
    trajGeo.setDrawRange(0, 0);
  } else {
    document.exitPointerLock();
  }
  document.getElementById('fp-reticle').style.display = fpMode ? 'block' : 'none';
  document.getElementById('crosshair').style.display  = 'none';
  const el = document.getElementById('view-badge');
  if (el) el.textContent = fpMode ? '🎯 FIRST PERSON' : '🗺 OVERHEAD';
}

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && fpMode) {
    fpMode = false;
    const el = document.getElementById('view-badge');
    if (el) el.textContent = '🗺 OVERHEAD';
  }
});

window.addEventListener('mousemove', e => {
  if (fpMode && document.pointerLockElement) {
    fpYaw   += e.movementX * 0.003;
    fpPitch  = Math.max(0, Math.min(Math.PI / 3, fpPitch - e.movementY * 0.003));
    turretPitch = fpPitch;
  } else if (!fpMode) {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }
});
window.addEventListener('mousedown', e => { if (e.button === 0) firing = true; });
window.addEventListener('mouseup',   e => { if (e.button === 0) firing = false; });
// Pitch is controlled by ArrowUp/ArrowDown (and mouse in FP). No scroll.
window.addEventListener('contextmenu', e => e.preventDefault());

// ─── Aim helpers ──────────────────────────────────────────────────────────────
function getAimPoint() {
  const ndc = new THREE.Vector2(
    (mouseX / innerWidth) * 2 - 1,
    -(mouseY / innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const pt = new THREE.Vector3();
  raycaster.ray.intersectPlane(groundPlane, pt);
  return pt;
}

function overheadTurretYaw(tankX, tankZ) {
  const aim = getAimPoint();
  return Math.atan2(aim.x - tankX, aim.z - tankZ);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
let ws;
let inputInterval;

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', name }));
    inputInterval = setInterval(sendInput, 33);
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMsg(msg);
  };

  ws.onclose = () => {
    clearInterval(inputInterval);
    setTimeout(() => connect(name), 2000);
  };

  ws.onerror = () => {
    document.getElementById('playBtn').textContent  = 'RETRY';
    document.getElementById('playBtn').disabled = false;
  };
}

function sendInput() {
  if (!ws || ws.readyState !== 1 || myId === null) return;
  const me = gameState?.players?.find(p => p.id === myId);
  if (me?.dead) return;  // only bail if server confirmed we're dead

  // Fall back to predicted position while waiting for first state message
  const tankX   = me?.x   ?? predX;
  const tankZ   = me?.z   ?? predZ;
  const tankYaw = me?.yaw ?? predYaw;

  let turretYaw;
  let pitch;

  let targetYaw;
  if (fpMode) {
    turretYaw = fpYaw - tankYaw;
    pitch     = fpPitch;
  } else if (mouseDriveMode) {
    const wYaw = overheadTurretYaw(tankX, tankZ);
    targetYaw  = wYaw;   // server rotates body toward this
    turretYaw  = 0;      // turret aligned with body
    pitch      = turretPitch;
  } else {
    const wYaw = overheadTurretYaw(tankX, tankZ);
    turretYaw  = wYaw - tankYaw;
    pitch      = turretPitch;
  }

  ws.send(JSON.stringify({
    t: 'input',
    fwd:   !!(keys['KeyW']),
    back:  !!(keys['KeyS']),
    left:  mouseDriveMode ? false : !!(keys['KeyA'] || keys['ArrowLeft']),
    right: mouseDriveMode ? false : !!(keys['KeyD'] || keys['ArrowRight']),
    fire: firing,
    turretYaw,
    turretPitch: pitch,
    targetYaw,
  }));
}

function handleMsg(msg) {
  switch (msg.t) {
    case 'welcome': {
      myId      = msg.id;
      worldSize = msg.worldSize;
      maxHealth = msg.maxHealth;

      // Init prediction from spawn so no snap on first state
      predX   = msg.spawnX   ?? 0;
      predZ   = msg.spawnZ   ?? 0;
      predYaw = msg.spawnYaw ?? 0;
      predReady = true;

      // Snap camera to spawn before showing game
      camera.position.set(msg.spawnX ?? 0, 110, (msg.spawnZ ?? 0) + 60);
      camera.lookAt(msg.spawnX ?? 0, 0, msg.spawnZ ?? 0);

      buildWorld(msg.obstacles, msg.pickups);
      buildMountains();
      // Pre-compile all WebGL shaders so the first rendered frame is smooth.
      // On first load the GPU has no shader cache; without this every new material
      // compiles on its first draw call, causing a visible stutter.
      renderer.compile(scene, camera);

      document.getElementById('join').style.display = 'none';
      document.getElementById('hud').style.display  = 'block';
      break;
    }
    case 'state':    { gameState = msg; syncMeshes(msg); updateHUD(msg); break; }
    case 'boom':     { spawnExplosion(msg.x, msg.y, msg.z, msg.big, msg.color); break; }
    case 'blast':    { spawnBlast(msg.x, msg.y, msg.z, msg.radius); break; }
    case 'kill':     { addKillFeed(msg.killer, msg.victim, msg.killerColor, msg.victimColor); break; }
    case 'pickup':   { showPickupToast(msg.playerName, msg.kind); break; }
    case 'joined':   { addKillFeed(null, null, null, null, `${msg.name} joined`); break; }
    case 'left':     { addKillFeed(null, null, null, null, `${msg.name} left`); break; }
  }
}

// ─── World build ──────────────────────────────────────────────────────────────
function buildWorld(obstacleData, pickupData) {
  clientObstacles = obstacleData;
  buildObstacleInstances(obstacleData);
  for (const pu of pickupData) {
    const g = buildPickup(pu.type);
    g.position.set(pu.x, 2.2, pu.z);
    g.userData.id   = pu.id;
    g.userData.type = pu.type;
    scene.add(g);
    pickupMeshes.set(pu.id, g);
  }
}

// ─── Mesh sync ────────────────────────────────────────────────────────────────
function syncMeshes(state) {
  const seenPlayers = new Set();
  for (const pd of state.players) {
    seenPlayers.add(pd.id);
    if (!tankMeshes.has(pd.id)) {
      const { group, fpHideParts } = buildTank(pd.color);
      const tag = makeNameTag(pd.name, pd.color);
      fpHideParts.push(tag);
      group.add(tag);
      scene.add(group);
      tankMeshes.set(pd.id, {
        group, fpHideParts,
        targetX: pd.x, targetZ: pd.z, targetYaw: pd.yaw,
        turretYaw: pd.turretYaw,
        state: pd,
        wasFP: null,
      });
    }
    const entry = tankMeshes.get(pd.id);
    entry.targetX   = pd.x;
    entry.targetZ   = pd.z;
    entry.targetYaw = pd.yaw;
    entry.state     = pd;

    // Seed or reconcile client-side prediction for local player
    if (pd.id === myId) {
      predSpeedBoost = pd.speedBoost;
      if (!predReady) {
        predX = pd.x; predZ = pd.z; predYaw = pd.yaw;
        predReady = true;
      } else {
        // Blend prediction toward authoritative server position
        predX   += (pd.x   - predX)   * 0.25;
        predZ   += (pd.z   - predZ)   * 0.25;
        predYaw += (pd.yaw - predYaw) * 0.25;
      }
    }
  }
  for (const [id] of tankMeshes) {
    if (!seenPlayers.has(id)) { scene.remove(tankMeshes.get(id).group); tankMeshes.delete(id); }
  }

  const seenProj = new Set();
  for (const pr of state.projectiles) {
    seenProj.add(pr.id);
    if (!projMeshes.has(pr.id)) {
      const r    = pr.isBomb ? 1.4 : 0.42;
      const seg  = pr.isBomb ? 10  : 7;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, seg, seg),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(pr.color) })
      );
      scene.add(mesh);
      projMeshes.set(pr.id, mesh);
    }
    projMeshes.get(pr.id).position.set(pr.x, pr.y, pr.z);
  }
  for (const [id, m] of projMeshes) {
    if (!seenProj.has(id)) { scene.remove(m); projMeshes.delete(id); }
  }

  for (const pu of state.pickups) {
    const g = pickupMeshes.get(pu.id);
    if (!g) continue;
    g.visible = pu.available;
    // Update position if server moved it (randomised on respawn)
    if (pu.x !== undefined && (g.position.x !== pu.x || g.position.z !== pu.z)) {
      g.position.set(pu.x, g.position.y, pu.z);
    }
  }
}

// ─── Minimap ──────────────────────────────────────────────────────────────────
const mmCanvas = document.getElementById('minimap-canvas');
const mmCtx    = mmCanvas.getContext('2d');
const MM = 200;

function drawMinimap(state) {
  mmCtx.clearRect(0, 0, MM, MM);
  mmCtx.fillStyle = 'rgba(10,20,10,0.8)';
  mmCtx.fillRect(0, 0, MM, MM);
  const toMM = v => ((v + worldSize / 2) / worldSize) * MM;

  // Pickups (bottom layer)
  for (const [, g] of pickupMeshes) {
    if (!g.visible) continue;
    const col = PICKUP_COLORS[g.userData.type];
    if (!col) continue;
    mmCtx.fillStyle = '#' + col.toString(16).padStart(6, '0');
    mmCtx.beginPath();
    mmCtx.arc(toMM(g.position.x), toMM(g.position.z), 1.8, 0, Math.PI * 2);
    mmCtx.fill();
  }

  // Other players — large bright circles with white outline
  for (const p of state.players) {
    if (p.dead || p.id === myId) continue;
    const px = toMM(p.x), pz = toMM(p.z);
    mmCtx.beginPath();
    mmCtx.arc(px, pz, 5.4, 0, Math.PI * 2);
    mmCtx.fillStyle = p.color;
    mmCtx.fill();
  }

  // Self — drawn last so always visible, with a direction arrow
  const me = state.players.find(p => p.id === myId);
  if (me && !me.dead) {
    const mx = toMM(me.x), mz = toMM(me.z);
    const S = Math.sin(me.yaw), C = Math.cos(me.yaw);
    // Direction triangle (tip forward, base backward)
    mmCtx.fillStyle = '#ffffff';
    mmCtx.beginPath();
    mmCtx.moveTo(mx + S * 8,  mz + C * 8);          // tip (forward)
    mmCtx.lineTo(mx - S * 4 + C * 4, mz - C * 4 - S * 4);  // base right
    mmCtx.lineTo(mx - S * 4 - C * 4, mz - C * 4 + S * 4);  // base left
    mmCtx.closePath();
    mmCtx.fill();
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function updateHUD(state) {
  const me = state?.players?.find(p => p.id === myId);
  if (!me) return;

  $('hearts').textContent = '❤️'.repeat(me.health) + '🖤'.repeat(Math.max(0, maxHealth - me.health));
  $('player-name').textContent = me.name.toUpperCase();

  if (me.speedBoost) { $('bp-speed').classList.add('active');  $('speed-t').textContent  = me.speedT.toFixed(0); }
  else                 $('bp-speed').classList.remove('active');
  if (me.shield)     { $('bp-shield').classList.add('active'); $('shield-t').textContent = me.shieldT.toFixed(0); }
  else                 $('bp-shield').classList.remove('active');
  if (me.rapidLeft > 0) { $('bp-ammo').classList.add('active'); $('ammo-n').textContent = me.rapidLeft; }
  else                     $('bp-ammo').classList.remove('active');
  if (me.bombLeft  > 0) $('bp-bomb').classList.add('active');
  else                   $('bp-bomb').classList.remove('active');

  const pitchDeg = Math.round((fpMode ? fpPitch : turretPitch) * (180 / Math.PI));
  $('pitch-deg').textContent = pitchDeg + '°';
  $('pitch-bar').style.width = (((fpMode ? fpPitch : turretPitch) / (Math.PI / 3)) * 100).toFixed(1) + '%';

  if (me.dead) {
    $('respawn-overlay').style.display = 'flex';
    $('respawn-count').textContent = Math.ceil(me.respawnIn);
  } else {
    $('respawn-overlay').style.display = 'none';
  }

  const sorted = [...state.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  $('lb-rows').innerHTML = sorted.slice(0, 8).map(p =>
    `<div class="lb-row${p.id === myId ? ' lb-me' : ''}">
       <span class="lb-name" style="color:${p.color}">${p.name}</span>
       <span class="lb-kd">${p.kills}K / ${p.deaths}D</span>
     </div>`
  ).join('');

  drawMinimap(state);
}

// ─── Kill feed ────────────────────────────────────────────────────────────────
const killFeed = $('killfeed');
function addKillFeed(killer, victim, kCol, vCol, raw) {
  const el = document.createElement('div');
  el.className = 'kf-entry';
  if (raw) {
    el.textContent = raw;
  } else if (killer) {
    el.innerHTML = `<span style="color:${kCol}">${killer}</span> 💥 <span style="color:${vCol}">${victim}</span>`;
  } else {
    el.innerHTML = `💥 <span style="color:${vCol}">${victim}</span> destroyed`;
  }
  killFeed.prepend(el);
  setTimeout(() => el.remove(), 6000);
}

// ─── Pickup toast ─────────────────────────────────────────────────────────────
const PICKUP_LABELS = { speed:'⚡ SPEED', ammo:'🔥 RAPID FIRE', shield:'🛡 SHIELD', health:'❤️ +1 HP', bomb:'💣 BOMB' };
let toastTimeout;
function showPickupToast(name, kind) {
  const el = $('pickup-toast');
  el.textContent = `${name}: ${PICKUP_LABELS[kind] ?? kind}`;
  el.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

// ─── Animation loop ───────────────────────────────────────────────────────────
let prevTime    = performance.now();
let exhaustTime = 0;

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt  = Math.min((now - prevTime) / 1000, 0.05);
  prevTime  = now;
  exhaustTime += dt;

  const me = gameState?.players?.find(p => p.id === myId);

  // Client-side prediction: advance local position from inputs every frame.
  // Server state blends in gradually (reconciliation above) so there's never
  // a hard snap — movement is always 60 fps smooth regardless of tick rate.
  // Use predX/Z immediately from welcome (before first state arrives) so the
  // tank responds to input without waiting up to 33 ms for the first state.
  let smoothX = predReady ? predX : (me?.x ?? 0);
  let smoothZ = predReady ? predZ : (me?.z ?? 0);
  if (predReady && (!me || !me.dead)) {
    const fwd = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
    if (mouseDriveMode) {
      // Snap predYaw toward mouse direction
      const wYaw = overheadTurretYaw(predX, predZ);
      let dy = wYaw - predYaw;
      while (dy >  Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      predYaw += dy * Math.min(1, dt * 12);
    } else {
      if (keys['KeyA'] || keys['ArrowLeft'])  predYaw += TANK_TURN_CLIENT * dt;
      if (keys['KeyD'] || keys['ArrowRight']) predYaw -= TANK_TURN_CLIENT * dt;
    }
    const spd = TANK_SPEED_CLIENT * (predSpeedBoost ? SPEED_MULT_CLIENT : 1);
    const pdx = Math.sin(predYaw) * spd * fwd * dt;
    const pdz = Math.cos(predYaw) * spd * fwd * dt;
    const nx = Math.max(-WORLD_HALF_CLIENT, Math.min(WORLD_HALF_CLIENT, predX + pdx));
    const nz = Math.max(-WORLD_HALF_CLIENT, Math.min(WORLD_HALF_CLIENT, predZ + pdz));
    if (!clientHitsObstacle(nx, predZ, TANK_RADIUS_CLIENT)) predX = nx;
    if (!clientHitsObstacle(predX, nz, TANK_RADIUS_CLIENT)) predZ = nz;
    smoothX = predX;
    smoothZ = predZ;
  }

  // ── Camera
  if (predReady) {
    if (fpMode) {
      // First-person: sit just behind the barrel pivot at barrel height.
      const cosP = Math.cos(fpPitch);
      const sinP = Math.sin(fpPitch);
      const fwdX = Math.sin(fpYaw) * cosP;
      const fwdZ = Math.cos(fpYaw) * cosP;
      const EYE_Y = 1.7;
      const PULL  = 1.2;
      camera.position.set(
        smoothX - fwdX * PULL,
        EYE_Y - sinP * PULL,
        smoothZ - fwdZ * PULL
      );
      camera.lookAt(
        smoothX + fwdX * 2000,
        EYE_Y + sinP * 2000,
        smoothZ + fwdZ * 2000
      );
      trajGeo.setDrawRange(0, 0);
    } else {
      // Overhead follow — smooth lerp toward target
      const tgt = new THREE.Vector3(smoothX, 110, smoothZ + 60);
      camera.position.lerp(tgt, Math.min(1, dt * 5));
      if (camShake > 0) {
        camera.position.x += (Math.random() - 0.5) * camShake * 2;
        camera.position.z += (Math.random() - 0.5) * camShake * 2;
        camShake = Math.max(0, camShake - dt * 3);
      }
      camera.lookAt(smoothX, 0, smoothZ);

      if (!me?.dead) {
        const wYaw = overheadTurretYaw(smoothX, smoothZ);
        updateTrajectory(smoothX, smoothZ, wYaw, turretPitch);
      } else {
        trajGeo.setDrawRange(0, 0);
      }
    }
  }

  // ── Tank mesh updates
  for (const [id, entry] of tankMeshes) {
    const { group, fpHideParts, state: pd } = entry;
    if (!pd) continue;

    group.visible = !pd.dead;
    if (!group.visible) continue;

    const isLocal = id === myId;

    // Toggle FP visibility only when mode changes
    if (isLocal && entry.wasFP !== fpMode) {
      entry.wasFP = fpMode;
      for (const p of fpHideParts) p.visible = !fpMode;
    }

    // Position: local player uses smoothX/Z computed at top of frame (dead-reckoning);
    // remote players lerp to smooth 30 Hz updates.
    if (isLocal) {
      group.position.x = smoothX;
      group.position.z = smoothZ;
    } else {
      group.position.x += (entry.targetX - group.position.x) * Math.min(1, dt * 12);
      group.position.z += (entry.targetZ - group.position.z) * Math.min(1, dt * 12);
    }

    // Body yaw — direct for local player, lerped for remotes
    if (isLocal) {
      group.rotation.y = entry.targetYaw;
    } else {
      let dyaw = entry.targetYaw - group.rotation.y;
      while (dyaw >  Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      group.rotation.y += dyaw * Math.min(1, dt * 18);
    }

    // Gentle idle bob
    group.position.y = Math.sin(exhaustTime * 2.0 + id * 1.7) * 0.03;

    // Turret yaw — use live FP input for local player; smooth server value for remotes
    const turret = group.getObjectByName('turret');
    if (turret) {
      if (isLocal && fpMode) {
        turret.rotation.y = fpYaw - group.rotation.y;
      } else if (isLocal) {
        turret.rotation.y = overheadTurretYaw(pd.x, pd.z) - group.rotation.y;
      } else {
        // Smooth remote turret
        let dty = pd.turretYaw - entry.turretYaw;
        while (dty >  Math.PI) dty -= Math.PI * 2;
        while (dty < -Math.PI) dty += Math.PI * 2;
        entry.turretYaw += dty * Math.min(1, dt * 14);
        turret.rotation.y = entry.turretYaw;
      }
    }

    // Barrel pitch — live for local player in FP, server value otherwise
    const bp = group.getObjectByName('barrelPivot');
    if (bp) bp.rotation.x = -(isLocal && fpMode ? fpPitch : pd.turretPitch);

    const shield = group.getObjectByName('shield');
    if (shield) {
      shield.material.opacity = pd.shield
        ? 0.22 + Math.sin(exhaustTime * 4) * 0.08 : 0;
      if (pd.shield) shield.rotation.y += dt * 1.2;
    }
  }

  // ── Pickup animations
  for (const [, g] of pickupMeshes) {
    if (!g.visible) continue;
    g.rotation.y += dt * 1.6;
    g.position.y  = 2.2 + Math.sin(exhaustTime * 1.8 + g.userData.id * 0.7) * 0.35;
    const ring = g.userData.ring;
    if (ring) ring.rotation.z += dt * 2;
  }

  tickExplosions(dt);
  tickBlasts(dt);
  renderer.render(scene, camera);
}

// ─── Join screen ──────────────────────────────────────────────────────────────
$('playBtn').onclick = () => {
  const name = $('nameInput').value.trim() || 'anon';
  $('playBtn').textContent = 'CONNECTING…';
  $('playBtn').disabled = true;
  connect(name);
};
$('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('playBtn').click();
});

// Module fully loaded — unlock the join button
$('playBtn').disabled = false;
$('playBtn').textContent = 'BATTLE';

animate();
