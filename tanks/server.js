/**
 * server.js — Tank Battle multiplayer server
 * Authoritative physics at 30 Hz. Clients send input; server simulates everything.
 */
const express = require('express');
const { WebSocketServer } = require('ws');
const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');

const PORT = process.env.PORT || 3000;

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_RATE       = 30;
const WORLD_SIZE      = 1500;
const TANK_RADIUS     = 2.8;
const TANK_SPEED      = 30;
const TANK_TURN_SPEED = 2.0;
const TANK_BACK_MULT  = 0.55;
const PROJ_SPEED      = 110;
const PROJ_GRAVITY    = 28;
const PROJ_RADIUS     = 0.6;
const PROJ_LIFETIME   = 14;
const FIRE_COOLDOWN   = 0.75;
const MAX_HEALTH      = 5;
const BLAST_RADIUS    = TANK_RADIUS * 4;  // bomb area of effect
const BOMB_DAMAGE     = 3;
const RESPAWN_SECS    = 5;
const SHIELD_SECS     = 9;
const SPEED_SECS      = 11;
const RAPID_SHOTS     = 20;
const RAPID_COOLDOWN  = 0.18;
const PICKUP_RADIUS   = 3.5;
const PICKUP_RESPAWN  = 22;
const MOUNTAIN_ZONE   = 120;      // tanks stop this far from edge
const HALF = WORLD_SIZE / 2 - MOUNTAIN_ZONE;

const PLAYER_COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63',
  '#00bcd4','#cddc39','#ff5722','#607d8b',
];

// ─── Seeded RNG ───────────────────────────────────────────────────────────────
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s ^= s >>> 16;
    return (s >>> 0) / 0x100000000;
  };
}

// ─── World generation ────────────────────────────────────────────────────────
function generateWorld() {
  const rng = mkRng(0xdeadbeef);
  const obstacles = [];
  const pickups   = [];

  const safe = WORLD_SIZE / 2 - MOUNTAIN_ZONE - 20;
  const place = () => ({
    x: (rng() - 0.5) * safe * 2,
    z: (rng() - 0.5) * safe * 2,
  });

  for (let i = 0; i < 130; i++) {
    const { x, z } = place();
    const r = 3.5 + rng() * 8;
    obstacles.push({ id: `rock_${i}`, type: 'rock', x, z,
      radius: r, height: 2.5 + rng() * 5, rot: rng() * Math.PI * 2 });
  }

  for (let i = 0; i < 65; i++) {
    const { x, z } = place(25);
    const len = 12 + rng() * 30;
    const w   = 2.5 + rng() * 2.5;
    const rot = rng() * Math.PI;
    const br  = Math.hypot(len / 2, w / 2);
    obstacles.push({ id: `wall_${i}`, type: 'wall', x, z,
      length: len, width: w, rot, radius: br,
      height: 3 + rng() * 2 });
  }

  for (let i = 0; i < 85; i++) {
    const { x, z } = place(18);
    obstacles.push({ id: `tree_${i}`, type: 'tree', x, z,
      radius: 1.4 + rng() * 0.9,
      trunkH: 2 + rng() * 2.5,
      height: 8 + rng() * 12 });
  }

  const ptypes = ['speed', 'ammo', 'shield', 'health', 'bomb'];
  for (let i = 0; i < 55; i++) {
    let px, pz, tries = 0;
    do {
      const p = place();
      px = p.x; pz = p.z;
    } while (hitsObstacle(px, pz, PICKUP_RADIUS + 8, obstacles) && ++tries < 50);
    pickups.push({ id: i, type: ptypes[i % ptypes.length],
      x: px, z: pz, available: true, respawnAt: null });
  }

  return { obstacles, pickups };
}

// Dense grid of candidate spawn points, built once after world gen.
// Filtered to exclude obstacle overlaps so players never spawn inside rocks/walls.
let spawnCandidates = null;
function buildSpawnCandidates() {
  const SAFE = WORLD_SIZE / 2 - MOUNTAIN_ZONE - 80; // well inside mountain ring
  const STEP = 70;
  const out  = [];
  for (let x = -SAFE; x <= SAFE; x += STEP)
    for (let z = -SAFE; z <= SAFE; z += STEP)
      if (!hitsObstacle(x, z, TANK_RADIUS * 5, obstacles))
        out.push({ x, z });
  return out;
}

function spawnPoint() {
  if (!spawnCandidates) spawnCandidates = buildSpawnCandidates();
  const living = [...players.values()].filter(p => !p.dead);
  // maximin: pick candidate whose nearest living player is farthest away
  let best = spawnCandidates[Math.floor(Math.random() * spawnCandidates.length)];
  let bestD = -1;
  for (const pt of spawnCandidates) {
    const d = living.length === 0
      ? Infinity
      : living.reduce((m, p) => Math.min(m, Math.hypot(pt.x - p.x, pt.z - p.z)), Infinity);
    if (d > bestD) { bestD = d; best = pt; }
  }
  // Small jitter so players on the same candidate don't overlap; validate before using
  const jx = best.x + (Math.random() - 0.5) * 30;
  const jz = best.z + (Math.random() - 0.5) * 30;
  return hitsObstacle(jx, jz, TANK_RADIUS * 2, obstacles)
    ? { x: best.x, z: best.z }
    : { x: jx, z: jz };
}

// ─── Collision helpers ────────────────────────────────────────────────────────
function wallCollides(px, pz, radius, wall) {
  const cos = Math.cos(-wall.rot), sin = Math.sin(-wall.rot);
  const dx = px - wall.x, dz = pz - wall.z;
  const lx = cos * dx - sin * dz;
  const lz = sin * dx + cos * dz;
  const nearX = Math.max(-wall.length / 2, Math.min(wall.length / 2, lx));
  const nearZ = Math.max(-wall.width  / 2, Math.min(wall.width  / 2, lz));
  return Math.hypot(lx - nearX, lz - nearZ) < radius;
}

function hitsObstacle(px, pz, radius, obstacles) {
  for (const o of obstacles) {
    if (o.type === 'wall') {
      if (wallCollides(px, pz, radius, o)) return true;
    } else {
      if (Math.hypot(px - o.x, pz - o.z) < o.radius + radius) return true;
    }
  }
  return false;
}

// ─── Game state ───────────────────────────────────────────────────────────────
let { obstacles, pickups } = generateWorld();
const players     = new Map();
const projectiles = new Map();
let projId   = 0;
let colorIdx = 0;

// ─── Player factory ───────────────────────────────────────────────────────────
function makePlayer(ws, name) {
  const sp    = spawnPoint();
  const color = PLAYER_COLORS[colorIdx++ % PLAYER_COLORS.length];
  return {
    id: ws._id, name: name.slice(0, 16) || 'tank', color,
    x: sp.x, z: sp.z,
    yaw: Math.atan2(-sp.x, -sp.z), // face center
    turretYaw: 0, turretPitch: 0.04,
    health: MAX_HEALTH,
    shield: false,     shieldT: 0,
    speedBoost: false, speedT: 0,
    rapidLeft: 0, bombLeft: 0,
    dead: false, respawnAt: null,
    fireCooldown: 0,
    kills: 0, deaths: 0,
    input: { fwd: false, back: false, left: false, right: false,
             fire: false, turretYaw: 0, turretPitch: 0.04 },
    ws,
  };
}

function respawn(p) {
  const sp   = spawnPoint();
  p.x        = sp.x; p.z = sp.z;
  p.yaw      = Math.atan2(-sp.x, -sp.z); // face center
  p.health   = MAX_HEALTH;
  p.dead     = false; p.respawnAt = null;
  p.shield   = false; p.shieldT   = 0;
  p.speedBoost = false; p.speedT  = 0;
  p.rapidLeft  = 0; p.bombLeft = 0;
  p.fireCooldown = 0;
}

function die(p, killerId) {
  if (p.dead) return;
  p.dead      = true;
  p.health    = 0;
  p.respawnAt = Date.now() + RESPAWN_SECS * 1000;
  p.deaths++;
  const killer = [...players.values()].find(k => k.id === killerId);
  if (killer && killer.id !== p.id) killer.kills++;
  broadcast({ t: 'boom', x: p.x, y: 1.5, z: p.z, big: true, color: p.color });
  broadcast({ t: 'kill',
    killer: killer?.name ?? null, victim: p.name,
    killerColor: killer?.color ?? '#fff', victimColor: p.color });
}

// ─── Projectile firing ────────────────────────────────────────────────────────
function bombExplode(pr, excludeId = null) {
  broadcast({ t: 'blast', x: pr.x, y: pr.y, z: pr.z, radius: BLAST_RADIUS });
  for (const p of players.values()) {
    if (p.id === pr.ownerId || p.dead) continue;
    if (excludeId !== null && p.id === excludeId) continue;
    if (Math.hypot(pr.x - p.x, pr.z - p.z) > BLAST_RADIUS) continue;
    if (p.shield) {
      p.shield = false; p.shieldT = 0;
      broadcast({ t: 'boom', x: p.x, y: 1.5, z: p.z, big: false, color: '#00d4ff' });
      continue;
    }
    p.health -= BOMB_DAMAGE;
    if (p.health <= 0) die(p, pr.ownerId);
    else broadcast({ t: 'boom', x: p.x, y: 1.5, z: p.z, big: false, color: '#333333' });
  }
}

function fire(p) {
  const totalYaw = p.yaw + p.turretYaw;
  const pitch    = p.turretPitch;
  const bLen = 1.8;
  const bx = p.x + Math.sin(totalYaw) * Math.cos(pitch) * bLen;
  const by = 1.7 + Math.sin(pitch) * bLen;
  const bz = p.z + Math.cos(totalYaw) * Math.cos(pitch) * bLen;
  const isBomb = p.bombLeft > 0;
  if (isBomb) p.bombLeft--;
  projectiles.set(projId, {
    id: projId++, ownerId: p.id, color: isBomb ? '#333333' : p.color,
    x: bx, y: by, z: bz,
    vx: Math.sin(totalYaw) * Math.cos(pitch) * PROJ_SPEED,
    vy: Math.sin(pitch) * PROJ_SPEED,
    vz: Math.cos(totalYaw) * Math.cos(pitch) * PROJ_SPEED,
    life: PROJ_LIFETIME, isBomb,
  });
}

// ─── Pickup application ───────────────────────────────────────────────────────
function applyPickup(p, pu) {
  pu.available = false;
  pu.respawnAt = Date.now() + PICKUP_RESPAWN * 1000;
  switch (pu.type) {
    case 'speed':  p.speedBoost = true; p.speedT = SPEED_SECS; break;
    case 'ammo':   p.rapidLeft = RAPID_SHOTS; p.fireCooldown = 0; break;
    case 'shield': p.shield = true; p.shieldT = SHIELD_SECS; break;
    case 'health': p.health = Math.min(MAX_HEALTH, p.health + 1); break;
    case 'bomb':   p.bombLeft = 1; p.fireCooldown = 0; break;
  }
  broadcast({ t: 'pickup', playerName: p.name, playerColor: p.color,
               pickupId: pu.id, kind: pu.type });
}

// ─── Main tick ────────────────────────────────────────────────────────────────
const DT = 1 / TICK_RATE;

function tick() {
  const now = Date.now();

  for (const p of players.values()) {
    if (p.dead) {
      if (now >= p.respawnAt) respawn(p);
      continue;
    }

    if (p.shieldT > 0 && (p.shieldT -= DT) <= 0) p.shield = false;
    if (p.speedT  > 0 && (p.speedT  -= DT) <= 0) p.speedBoost = false;
    p.fireCooldown = Math.max(0, p.fireCooldown - DT);

    const inp   = p.input;
    const speed = TANK_SPEED * (p.speedBoost ? 2.1 : 1);
    if (inp.targetYaw !== undefined) {
      // Mouse-drive: rotate body toward target yaw at 3× normal turn speed
      let dy = inp.targetYaw - p.yaw;
      while (dy >  Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      p.yaw += Math.sign(dy) * Math.min(Math.abs(dy), TANK_TURN_SPEED * 3 * DT);
    } else {
      if (inp.left)  p.yaw += TANK_TURN_SPEED * DT;
      if (inp.right) p.yaw -= TANK_TURN_SPEED * DT;
    }

    const fwd = inp.fwd ? 1 : (inp.back ? -TANK_BACK_MULT : 0);
    const dx  = Math.sin(p.yaw) * speed * fwd * DT;
    const dz  = Math.cos(p.yaw) * speed * fwd * DT;

    const nx = Math.max(-HALF, Math.min(HALF, p.x + dx));
    if (!hitsObstacle(nx, p.z, TANK_RADIUS, obstacles)) p.x = nx;
    const nz = Math.max(-HALF, Math.min(HALF, p.z + dz));
    if (!hitsObstacle(p.x, nz, TANK_RADIUS, obstacles)) p.z = nz;

    p.turretYaw   = inp.turretYaw;
    p.turretPitch = Math.max(0, Math.min(Math.PI / 2.2, inp.turretPitch));

    if (inp.fire && p.fireCooldown <= 0) {
      fire(p);
      p.fireCooldown = p.rapidLeft > 0 ? RAPID_COOLDOWN : FIRE_COOLDOWN;
      if (p.rapidLeft > 0) p.rapidLeft--;
    }

    for (const pu of pickups) {
      if (!pu.available) continue;
      if (Math.hypot(p.x - pu.x, p.z - pu.z) < TANK_RADIUS + PICKUP_RADIUS)
        applyPickup(p, pu);
    }
  }

  const alive = [...players.values()].filter(p => !p.dead);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < TANK_RADIUS * 2.1) {
        if (!a.shield && !b.shield) { die(a, b.id); die(b, a.id); }
        else if (!a.shield)         { die(a, b.id); }
        else if (!b.shield)         { die(b, a.id); }
      }
    }
  }

  for (const [id, pr] of projectiles) {
    pr.vy -= PROJ_GRAVITY * DT;
    pr.x  += pr.vx * DT;
    pr.y  += pr.vy * DT;
    pr.z  += pr.vz * DT;
    pr.life -= DT;

    const oob = Math.abs(pr.x) > WORLD_SIZE / 2 || Math.abs(pr.z) > WORLD_SIZE / 2;
    if (pr.y < 0 || pr.life <= 0 || oob) {
      if (pr.y < 0 && !oob) {
        if (pr.isBomb) { bombExplode(pr); }
        broadcast({ t: 'boom', x: pr.x, y: 0.1, z: pr.z, big: pr.isBomb, color: pr.color });
      }
      projectiles.delete(id);
      continue;
    }

    if (hitsObstacle(pr.x, pr.z, PROJ_RADIUS, obstacles)) {
      if (pr.isBomb) bombExplode(pr);
      broadcast({ t: 'boom', x: pr.x, y: pr.y, z: pr.z, big: pr.isBomb, color: pr.color });
      projectiles.delete(id);
      continue;
    }

    let hit = false;
    for (const p of players.values()) {
      if (p.id === pr.ownerId || p.dead) continue;
      if (Math.hypot(pr.x - p.x, pr.z - p.z) < TANK_RADIUS * 1.8 && pr.y < 5 && pr.y > -1) {
        if (pr.isBomb) {
          // Handle the directly hit player explicitly before area blast
          if (p.shield) {
            p.shield = false; p.shieldT = 0;
            broadcast({ t: 'boom', x: p.x, y: 1.5, z: p.z, big: false, color: '#00d4ff' });
          } else {
            p.health -= BOMB_DAMAGE;
            if (p.health <= 0) die(p, pr.ownerId);
            else broadcast({ t: 'boom', x: p.x, y: 1.5, z: p.z, big: false, color: '#333333' });
          }
          bombExplode(pr, p.id); // splash damage on other nearby players, skip the direct-hit player
          broadcast({ t: 'boom', x: pr.x, y: pr.y, z: pr.z, big: true, color: '#333333' });
        } else if (p.shield) {
          broadcast({ t: 'boom', x: pr.x, y: pr.y, z: pr.z, big: false, color: '#00d4ff' });
        } else {
          p.health--;
          broadcast({ t: 'boom', x: pr.x, y: pr.y, z: pr.z,
            big: p.health <= 0, color: pr.color });
          if (p.health <= 0) die(p, pr.ownerId);
        }
        projectiles.delete(id);
        hit = true;
        break;
      }
    }
    if (hit) continue;
  }

  const puSafe = WORLD_SIZE / 2 - MOUNTAIN_ZONE - 20;
  for (const pu of pickups)
    if (!pu.available && pu.respawnAt && now >= pu.respawnAt) {
      pu.available = true; pu.respawnAt = null;
      // Move to a new random position each respawn, avoiding obstacles
      let rx, rz, rt = 0;
      do {
        rx = (Math.random() - 0.5) * puSafe * 2;
        rz = (Math.random() - 0.5) * puSafe * 2;
      } while (hitsObstacle(rx, rz, PICKUP_RADIUS + 8, obstacles) && ++rt < 50);
      pu.x = rx; pu.z = rz;
    }

  broadcastState();
}

// ─── Network ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const httpServer  = http.createServer(app);

const certPath = path.join(__dirname, 'cert.pem');
const keyPath  = path.join(__dirname, 'key.pem');
const httpsServer = fs.existsSync(certPath) && fs.existsSync(keyPath)
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : null;

// Attach a WebSocket server to both HTTP and HTTPS
const wss      = new WebSocketServer({ server: httpServer });
const wssHttps = httpsServer ? new WebSocketServer({ server: httpsServer }) : null;
let wsCtr    = 0;

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const p of players.values())
    if (p.ws.readyState === 1) p.ws.send(s);
}

function broadcastState() {
  const msg = {
    t: 'state',
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: +p.x.toFixed(2), z: +p.z.toFixed(2),
      yaw: +p.yaw.toFixed(3),
      turretYaw:   +p.turretYaw.toFixed(3),
      turretPitch: +p.turretPitch.toFixed(3),
      health: p.health, maxHealth: MAX_HEALTH,
      shield:     p.shield,
      speedBoost: p.speedBoost,
      rapidLeft:  p.rapidLeft,
      bombLeft:   p.bombLeft,
      shieldT:    +p.shieldT.toFixed(1),
      speedT:     +p.speedT.toFixed(1),
      dead: p.dead,
      respawnIn: p.dead ? Math.max(0, (p.respawnAt - Date.now()) / 1000) : 0,
      kills: p.kills, deaths: p.deaths,
    })),
    projectiles: [...projectiles.values()].map(pr => ({
      id: pr.id, ownerId: pr.ownerId, color: pr.color, isBomb: !!pr.isBomb,
      x: +pr.x.toFixed(2), y: +pr.y.toFixed(2), z: +pr.z.toFixed(2),
    })),
    pickups: pickups.map(pu => ({ id: pu.id, available: pu.available, x: pu.x, z: pu.z })),
  };
  broadcast(msg);
}

function onConnection(ws) {
  ws._id = wsCtr++;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      const p = makePlayer(ws, msg.name || 'tank');
      players.set(ws._id, p);
      ws.send(JSON.stringify({
        t: 'welcome',
        id: ws._id,
        worldSize: WORLD_SIZE,
        maxHealth: MAX_HEALTH,
        spawnX: p.x, spawnZ: p.z,   // so client can snap camera immediately
        obstacles,
        pickups: pickups.map(({ id, type, x, z }) => ({ id, type, x, z })),
      }));
      broadcast({ t: 'joined', name: p.name, color: p.color });
    }

    if (msg.t === 'input') {
      const p = players.get(ws._id);
      if (!p) return;
      p.input = {
        fwd:   !!msg.fwd,
        back:  !!msg.back,
        left:  !!msg.left,
        right: !!msg.right,
        fire:  !!msg.fire,
        turretYaw:   +msg.turretYaw   || 0,
        turretPitch: +msg.turretPitch || 0.25,
        targetYaw: msg.targetYaw !== undefined ? +msg.targetYaw : undefined,
      };
    }
  });

  ws.on('close', () => {
    const p = players.get(ws._id);
    if (p) broadcast({ t: 'left', name: p.name, color: p.color });
    players.delete(ws._id);
  });

  ws.on('error', () => ws.close());
}

wss.on('connection', onConnection);
if (wssHttps) wssHttps.on('connection', onConnection);

setInterval(tick, 1000 / TICK_RATE);

const HTTPS_PORT = 3443;
httpServer.listen(PORT, () => console.log(`Tank Battle (HTTP)  → http://localhost:${PORT}`));
if (httpsServer) httpsServer.listen(HTTPS_PORT, () => console.log(`Tank Battle (HTTPS) → https://localhost:${HTTPS_PORT}`));
