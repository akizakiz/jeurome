import "./style.css";
import * as THREE from "three";
import {
  MATCH_LIMITS,
  MATCH_MODES,
  normalizeMatchMode,
  normalizeTeam,
  sanitizePlayerName,
} from "./network/protocol.js";
import { cmdInput } from "./net/protocol.js";
import { applySnapshot } from "./net/snapshotApplier.js";
import { createNetworkState, initNetwork, setNetworkStatus, setRoomFlags, setSnapshotMetrics } from "./state/networkState.js";

const uiPanel = document.querySelector("#panel");
const startBtn = document.querySelector("#start-btn");
const statusEl = document.querySelector("#status");
const matchSummaryEl = document.querySelector("#match-summary");
const playerNameInput = document.querySelector("#player-name");
const matchModeInput = document.querySelector("#match-mode");
const botCountInput = document.querySelector("#bot-count");
const matchDurationInput = document.querySelector("#match-duration");
const teamButtons = Array.from(document.querySelectorAll(".team-btn"));
const readyBtn = document.querySelector("#ready-btn");
const roomStateEl = document.querySelector("#room-state");
const hudEl = document.querySelector("#hud");
const hudPlayerEl = document.querySelector("#hud-player");
const hudTeamEl = document.querySelector("#hud-team");
const hudEnergyEl = document.querySelector("#hud-energy");
const hudTimeEl = document.querySelector("#hud-time");
const hudModeEl = document.querySelector("#hud-mode");
const hudScoreEl = document.querySelector("#hud-score");
const hudZoneEl = document.querySelector("#hud-zone");
const hudBoostsEl = document.querySelector("#hud-boosts");
const hudMsgEl = document.querySelector("#hud-msg");
const netDebugEl = document.querySelector("#net-debug");
const canvas = document.querySelector("#game-canvas");

const STORAGE_KEYS = {
  playerName: "colisee.playerName",
  team: "colisee.team",
  mode: "colisee.mode",
};

const TEAM_LABELS = {
  red: "Rouge",
  blue: "Bleu",
};

const MODE_LABELS = {
  [MATCH_MODES.ctf]: "Capture du drapeau",
  [MATCH_MODES.dodgeball]: "Ballon prisonnier",
};
const NET_HUD_REFRESH_MS = 150;
const AUTO_START_WATCHDOG_INTERVAL_MS = 2000;
const AUTO_START_WATCHDOG_TIMEOUT_MS = 10000;
const AUTO_START_WATCHDOG_MAX_ATTEMPTS = 3;

const PLAYER_SPAWN = {
  x: 0,
  y: 1.7,
  z: -18,
  yaw: 0,
  pitch: -0.4,
};

const STATE = {
  mode: "lobby", // lobby | playing | postmatch
  timeLeftSec: MATCH_LIMITS.defaultDurationSec,
  scoreRed: 0,
  scoreBlue: 0,
  session: {
    playerName: "Élève",
    team: "red", // red | blue
  },
  matchConfig: {
    mode: MATCH_MODES.ctf,
    durationSec: MATCH_LIMITS.defaultDurationSec,
    botCount: MATCH_LIMITS.defaultBotCount,
    ctfCapturesToWin: 3,
    dodgeballScoreTarget: 50,
    disabledSec: 10,
  },
  lastMatchSummary: "",
  player: {
    // Spawn near a main gate, looking into the arena.
    pos: new THREE.Vector3(PLAYER_SPAWN.x, PLAYER_SPAWN.y, PLAYER_SPAWN.z),
    vel: new THREE.Vector3(),
    yaw: PLAYER_SPAWN.yaw,
    pitch: PLAYER_SPAWN.pitch,
    onGround: true,
    energy: 100,
    state: "active", // active | fatigued | disabled_spectator
    lastHitTimeSec: -999,
    invulnUntilSec: 0,
    tagCooldownSec: 0,
    fatigueTimerSec: 0,
    speedUntilSec: 0,
    jumpUntilSec: 0,
    shieldCharges: 0,
    shieldUntilSec: 0,
    hasBall: false,
  },
  balls: [],
  objectives: {
    ctf: null,
    dodgeball: {
      ballCap: 10,
      carriedBalls: 0,
      groundBalls: 0,
      projectileBalls: 0,
      totalBalls: 0,
    },
  },
  bots: [],
  botCount: MATCH_LIMITS.defaultBotCount,
  boosts: [],
  boostSpawnCounter: 0,
  nextBoostSpawnSec: 1.5,
  zone: {
    phase: "safe", // safe | warning | active
    timeToActiveSec: 0,
    timeLeftSec: 0,
  },
  statusClearAtSec: 0,
  nowSec: 0,
  remotePlayers: [],
  room: {
    phase: "lobby", // lobby | ready_check | countdown | playing | postmatch
    hostPlayerId: null,
    readyCount: 0,
    totalPlayers: 0,
    countdownLeftSec: 0,
    players: [],
  },
  network: createNetworkState(),
};

const CONSTANTS = {
  gravity: 22,
  speedWalk: 5.5,
  speedSprint: 7.0,
  jumpSpeed: 7.0,
  energyMax: 100,
  tagDamage: 25,
  tagRange: 1.8,
  tagCooldownSec: 0.6,
  regenPerSec: 6,
  regenDelaySec: 2.0,
  fatigueSec: 5.0,
  invulnSec: 1.0,
  boostSpawnIntervalSec: 6.0,
  boostMaxCount: 6,
  boostSpeedSec: 4.0,
  boostJumpSec: 4.0,
  boostShieldSec: 10.0,
  boostSpeedMult: 1.3,
  boostJumpMult: 1.25,
  zoneCycleSec: 25.0,
  zoneWarningSec: 3.0,
  zoneActiveSec: 10.0,
  zoneOffsetSec: 12.0,
  zoneDrainPerSec: 18.0,
  zoneSlowMult: 0.9,
  zoneInnerQ: 0.72,
  botSpeedMult: 0.68,
  botSpacing: 1.35,
  botPlayerAvoidDist: 1.45,
  botRespawnMinPlayerDist: 6.3,
};

const input = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jumpQueued: false,
  sprint: false,
  tagQueued: false,
};

const netHudUi = createNetHudOverlay();
let netHudTimer = null;
let inputSenderTimer = null;
let autoStartWatchdogTimer = null;
let autoStartRequestedAtMs = 0;
let autoStartAttempts = 0;
let autoStartBlocked = false;
let lastSentInputSnapshot = null;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcba46f);
scene.fog = new THREE.Fog(0xcba46f, 82, 235);

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 500);

const hemi = new THREE.HemisphereLight(0xffe1bf, 0x5a4b43, 1.12);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffd7aa, 1.35);
sun.position.set(-28, 36, 16);
scene.add(sun);

const fill = new THREE.DirectionalLight(0xa6b9d8, 0.38);
fill.position.set(24, 22, -18);
scene.add(fill);

const WORLD = {
  arenaA: 34,
  arenaB: 24,
  walkOuterFactor: 1.22,
  seatTier0TopFactor: 1.31,
  seatTier1TopFactor: 1.42,
  seatTier2TopFactor: 1.53,
  wallA: 52.0,
  wallB: 37.0,
  wallHeight: 16.5,
};

const AMBIENCE = {
  flames: [],
  banners: [],
  dust: null,
};

function addMesh(mesh) {
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function buildColosseumWorld() {
  const group = new THREE.Group();
  group.name = "colosseum";

  const sandMat = new THREE.MeshStandardMaterial({
    color: 0xc7a66f,
    roughness: 0.95,
    metalness: 0.02,
    emissive: 0x2c1e0e,
    emissiveIntensity: 0.05,
  });
  const sandTrackMat = new THREE.MeshStandardMaterial({
    color: 0x976e3d,
    roughness: 0.98,
    metalness: 0,
    transparent: true,
    opacity: 0.2,
  });
  const walkMat = new THREE.MeshStandardMaterial({
    color: 0xb1a594,
    roughness: 0.92,
    metalness: 0.03,
  });
  const podiumMat = new THREE.MeshStandardMaterial({
    color: 0xcfc0a5,
    roughness: 0.86,
    metalness: 0.02,
  });
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0xb7ae9b,
    roughness: 0.84,
    metalness: 0.03,
  });
  const stoneTier0Mat = new THREE.MeshStandardMaterial({
    color: 0xbab09f,
    roughness: 0.86,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const stoneTier1Mat = new THREE.MeshStandardMaterial({
    color: 0xb2a794,
    roughness: 0.88,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const stoneTier2Mat = new THREE.MeshStandardMaterial({
    color: 0xa89d8b,
    roughness: 0.9,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const stoneMatDouble = stoneMat.clone();
  stoneMatDouble.side = THREE.DoubleSide;
  const shadowVoidMat = new THREE.MeshStandardMaterial({ color: 0x130f10, roughness: 1, metalness: 0 });
  const bannerRedMat = new THREE.MeshStandardMaterial({
    color: 0xa73a35,
    roughness: 0.9,
    emissive: 0x2b0908,
    emissiveIntensity: 0.14,
  });
  const bannerBlueMat = new THREE.MeshStandardMaterial({
    color: 0x365bb3,
    roughness: 0.9,
    emissive: 0x091229,
    emissiveIntensity: 0.14,
  });

  // Arena sand (ellipse by scaling a unit circle)
  const sand = new THREE.Mesh(new THREE.CircleGeometry(1, 64), sandMat);
  sand.scale.set(WORLD.arenaA, WORLD.arenaB, 1);
  sand.rotation.x = -Math.PI / 2;
  group.add(sand);

  for (let i = 0; i < 4; i++) {
    const track = new THREE.Mesh(new THREE.RingGeometry(0.34 + i * 0.12, 0.38 + i * 0.12, 96), sandTrackMat);
    track.scale.set(WORLD.arenaA, WORLD.arenaB, 1);
    track.rotation.x = -Math.PI / 2;
    track.position.y = 0.022 + i * 0.0015;
    group.add(track);
  }

  // Inner podium wall (low barrier between sand and walkway)
  const podium = new THREE.Mesh(new THREE.CylinderGeometry(1.01, 1.01, 1.6, 72, 1, true), podiumMat);
  podium.scale.set(WORLD.arenaA, 1, WORLD.arenaB);
  podium.position.y = 0.8;
  group.add(podium);

  // Perimeter walkway (between sand and seats)
  const walkOuter = WORLD.walkOuterFactor;
  const walk = new THREE.Mesh(new THREE.RingGeometry(1.02, walkOuter, 96), walkMat);
  walk.scale.set(WORLD.arenaA, WORLD.arenaB, 1);
  walk.rotation.x = -Math.PI / 2;
  walk.position.y = 0.02;
  group.add(walk);

  const walkEdge = new THREE.Mesh(
    new THREE.RingGeometry(walkOuter - 0.02, walkOuter + 0.018, 96),
    new THREE.MeshStandardMaterial({ color: 0x8f8678, roughness: 0.86, metalness: 0.04 }),
  );
  walkEdge.scale.set(WORLD.arenaA, WORLD.arenaB, 1);
  walkEdge.rotation.x = -Math.PI / 2;
  walkEdge.position.y = 0.036;
  group.add(walkEdge);

  // Hypogeum grates (visual only)
  const grateGeo = new THREE.BoxGeometry(4.6, 0.08, 1.6);
  const grateMat = new THREE.MeshStandardMaterial({ color: 0x322f35, roughness: 0.78, metalness: 0.14 });
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Mesh(grateGeo, grateMat);
    g.position.set(-16 + i * 4, 0.04, (i % 2 === 0 ? -3.1 : 3.1));
    group.add(g);
  }

  // Seating tiers (blocky/frustum rings, Minecraft-like silhouette)
  const tier0H = 2.4;
  const tier1H = 2.2;
  const tier2H = 2.0;

  const tier0 = new THREE.Mesh(
    new THREE.CylinderGeometry(WORLD.seatTier0TopFactor, walkOuter, tier0H, 96, 1, true),
    stoneTier0Mat,
  );
  tier0.scale.set(WORLD.arenaA, 1, WORLD.arenaB);
  tier0.position.y = 0.6 + tier0H / 2;
  group.add(tier0);

  const tier1 = new THREE.Mesh(
    new THREE.CylinderGeometry(WORLD.seatTier1TopFactor, WORLD.seatTier0TopFactor, tier1H, 96, 1, true),
    stoneTier1Mat,
  );
  tier1.scale.set(WORLD.arenaA, 1, WORLD.arenaB);
  tier1.position.y = 0.6 + tier0H + tier1H / 2;
  group.add(tier1);

  const tier2 = new THREE.Mesh(
    new THREE.CylinderGeometry(WORLD.seatTier2TopFactor, WORLD.seatTier1TopFactor, tier2H, 96, 1, true),
    stoneTier2Mat,
  );
  tier2.scale.set(WORLD.arenaA, 1, WORLD.arenaB);
  tier2.position.y = 0.6 + tier0H + tier1H + tier2H / 2;
  group.add(tier2);

  // Outer wall
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, WORLD.wallHeight, 96, 1, true), stoneMatDouble);
  wall.scale.set(WORLD.wallA, 1, WORLD.wallB);
  wall.position.y = WORLD.wallHeight / 2;
  group.add(wall);

  // Dark arcades (fake arches) + pillars (Minecraft-like)
  const segmentCount = 72;
  const archGeo = new THREE.BoxGeometry(2.2, 4.5, 0.7);
  const pillarGeo = new THREE.BoxGeometry(1.2, 5.4, 1.0);
  const archMesh = new THREE.InstancedMesh(archGeo, shadowVoidMat, segmentCount);
  const pillarMesh = new THREE.InstancedMesh(pillarGeo, stoneMat, segmentCount);
  const tmp = new THREE.Object3D();

  for (let i = 0; i < segmentCount; i++) {
    const theta = (i / segmentCount) * Math.PI * 2;
    const x = WORLD.wallA * Math.cos(theta);
    const z = WORLD.wallB * Math.sin(theta);
    const yaw = Math.atan2(x, z);

    tmp.position.set(x, 2.8, z);
    tmp.rotation.set(0, yaw, 0);
    tmp.updateMatrix();
    archMesh.setMatrixAt(i, tmp.matrix);

    tmp.position.set(x, 3.1, z);
    tmp.rotation.set(0, yaw + Math.PI / segmentCount, 0);
    tmp.updateMatrix();
    pillarMesh.setMatrixAt(i, tmp.matrix);
  }
  group.add(archMesh);
  group.add(pillarMesh);

  // Two main gates (visual focus)
  const gateFrameMat = new THREE.MeshStandardMaterial({ color: 0xd4c6ae, roughness: 0.84, metalness: 0.03 });
  const gateFrame = new THREE.Mesh(new THREE.BoxGeometry(8.4, 8.6, 1.6), gateFrameMat);
  const gateVoid = new THREE.Mesh(new THREE.BoxGeometry(6.8, 6.2, 1.8), shadowVoidMat);

  const gateAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]; // 4 main gates
  for (const a of gateAngles) {
    const x = WORLD.wallA * Math.cos(a);
    const z = WORLD.wallB * Math.sin(a);
    const yaw = Math.atan2(x, z);

    const frame = gateFrame.clone();
    frame.position.set(x, 4.4, z);
    frame.rotation.y = yaw;
    group.add(frame);

    const hole = gateVoid.clone();
    hole.position.set(x, 3.7, z);
    hole.rotation.y = yaw;
    group.add(hole);
  }

  // Banners for team colors (visual anchor)
  const bannerGeo = new THREE.PlaneGeometry(5.4, 8.4);
  const bannerOffset = WORLD.wallHeight - 3.4;
  const bannerAngles = [Math.PI / 4, (5 * Math.PI) / 4];
  for (let i = 0; i < bannerAngles.length; i++) {
    const a = bannerAngles[i];
    const x = (WORLD.wallA - 0.4) * Math.cos(a);
    const z = (WORLD.wallB - 0.4) * Math.sin(a);
    const yaw = Math.atan2(x, z);
    const banner = new THREE.Mesh(bannerGeo, i === 0 ? bannerRedMat : bannerBlueMat);
    banner.position.set(x, bannerOffset, z);
    banner.rotation.y = yaw;
    AMBIENCE.banners.push({
      mesh: banner,
      baseY: yaw,
      phase: i * 1.7 + 0.6,
    });
    group.add(banner);
  }

  const brazierBaseMat = new THREE.MeshStandardMaterial({ color: 0x5c4f42, roughness: 0.86, metalness: 0.06 });
  const brazierBowlMat = new THREE.MeshStandardMaterial({ color: 0x7a6550, roughness: 0.74, metalness: 0.14 });
  const flameBaseMat = new THREE.MeshStandardMaterial({
    color: 0xffb457,
    roughness: 0.35,
    metalness: 0.02,
    emissive: 0x7d3300,
    emissiveIntensity: 1.1,
  });
  const glowBaseMat = new THREE.MeshBasicMaterial({
    color: 0xffbe75,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const torchAngles = 8;
  for (let i = 0; i < torchAngles; i++) {
    const a = (i / torchAngles) * Math.PI * 2 + Math.PI / 8;
    const x = WORLD.arenaA * 1.19 * Math.cos(a);
    const z = WORLD.arenaB * 1.19 * Math.sin(a);
    const yaw = Math.atan2(x, z);

    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 2.5, 10), brazierBaseMat);
    stand.position.set(x, 1.25, z);
    group.add(stand);

    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.38, 0.34, 10), brazierBowlMat);
    bowl.position.set(x, 2.63, z);
    group.add(bowl);

    const flameMat = flameBaseMat.clone();
    const flame = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), flameMat);
    flame.position.set(x, 2.95, z);
    flame.rotation.y = yaw;
    group.add(flame);

    const glowMat = glowBaseMat.clone();
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 10), glowMat);
    glow.position.set(x, 2.9, z);
    group.add(glow);

    AMBIENCE.flames.push({
      flame,
      glow,
      baseY: 2.95,
      phase: i * 0.87,
    });
  }

  // Upper rim framing the sky (cheap depth cue)
  const rim = new THREE.Mesh(new THREE.RingGeometry(1.03, 1.12, 96), stoneMat);
  rim.scale.set(WORLD.wallA, WORLD.wallB, 1);
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = WORLD.wallHeight + 0.2;
  group.add(rim);

  const dustCount = 150;
  const dustPos = new Float32Array(dustCount * 3);
  const baseX = new Float32Array(dustCount);
  const baseY = new Float32Array(dustCount);
  const baseZ = new Float32Array(dustCount);
  const phase = new Float32Array(dustCount);
  for (let i = 0; i < dustCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.35 + Math.sqrt(Math.random()) * 0.6;
    const x = WORLD.arenaA * 0.9 * radius * Math.cos(angle);
    const z = WORLD.arenaB * 0.9 * radius * Math.sin(angle);
    const y = 1.1 + Math.random() * 8.8;
    baseX[i] = x;
    baseY[i] = y;
    baseZ[i] = z;
    phase[i] = Math.random() * Math.PI * 2;
    const idx = i * 3;
    dustPos[idx] = x;
    dustPos[idx + 1] = y;
    dustPos[idx + 2] = z;
  }

  const dustGeom = new THREE.BufferGeometry();
  dustGeom.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    color: 0xf8d7a8,
    size: 0.18,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const dust = new THREE.Points(dustGeom, dustMat);
  group.add(dust);
  AMBIENCE.dust = {
    points: dust,
    baseX,
    baseY,
    baseZ,
    phase,
  };

  scene.add(group);
}
buildColosseumWorld();

function updateAmbience(nowMs) {
  const t = nowMs * 0.001;

  for (const entry of AMBIENCE.flames) {
    const f = 0.84 + Math.sin(t * 7.4 + entry.phase) * 0.11 + Math.sin(t * 12.6 + entry.phase * 1.9) * 0.06;
    entry.flame.position.y = entry.baseY + Math.sin(t * 5.4 + entry.phase) * 0.05;
    entry.flame.scale.set(1, 0.8 + f * 0.45, 1);
    entry.flame.material.emissiveIntensity = 0.74 + f * 0.78;
    entry.glow.scale.setScalar(0.78 + f * 0.35);
    entry.glow.material.opacity = 0.18 + f * 0.14;
  }

  for (const banner of AMBIENCE.banners) {
    banner.mesh.rotation.y = banner.baseY + Math.sin(t * 0.9 + banner.phase) * 0.055;
    banner.mesh.rotation.z = Math.sin(t * 1.25 + banner.phase * 1.3) * 0.04;
  }

  if (AMBIENCE.dust) {
    const attr = AMBIENCE.dust.points.geometry.getAttribute("position");
    const arr = attr.array;
    for (let i = 0; i < AMBIENCE.dust.phase.length; i++) {
      const idx = i * 3;
      const p = AMBIENCE.dust.phase[i];
      arr[idx] = AMBIENCE.dust.baseX[i] + Math.sin(t * 0.23 + p) * 0.14;
      arr[idx + 1] = AMBIENCE.dust.baseY[i] + Math.sin(t * 0.6 + p * 1.2) * 0.2;
      arr[idx + 2] = AMBIENCE.dust.baseZ[i] + Math.cos(t * 0.2 + p) * 0.14;
    }
    attr.needsUpdate = true;
  }
}

const BOT_VISUALS = {
  geom: new THREE.BoxGeometry(0.56, 1.2, 0.56),
  matActive: new THREE.MeshStandardMaterial({ color: 0x4464b7, roughness: 0.88, emissive: 0x0d1535, emissiveIntensity: 0.22 }),
  matFatigued: new THREE.MeshStandardMaterial({ color: 0x7a7f88, roughness: 0.94 }),
};

const botGroup = new THREE.Group();
botGroup.name = "bots";
scene.add(botGroup);

const TRAINING_DUMMY_POS = new THREE.Vector3(6.2, 1.7, -6.4);

const BOOST_KINDS = ["speed", "shield", "jump"];
const BOOST_VISUALS = {
  geom: new THREE.BoxGeometry(0.7, 0.7, 0.7),
  mats: {
    speed: new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.9, emissive: 0x0c4a2a, emissiveIntensity: 0.6 }),
    shield: new THREE.MeshStandardMaterial({ color: 0xf5c84b, roughness: 0.9, emissive: 0x5a3f00, emissiveIntensity: 0.55 }),
    jump: new THREE.MeshStandardMaterial({ color: 0xa855f7, roughness: 0.9, emissive: 0x2f0a4a, emissiveIntensity: 0.55 }),
  },
};

const boostGroup = new THREE.Group();
boostGroup.name = "boosts";
scene.add(boostGroup);

const ballVisual = {
  geom: new THREE.SphereGeometry(0.55, 16, 16),
  matRedProjectile: new THREE.MeshStandardMaterial({
    color: 0xff6b5f,
    roughness: 0.5,
    emissive: 0x6e2016,
    emissiveIntensity: 0.8,
  }),
  matBlueProjectile: new THREE.MeshStandardMaterial({
    color: 0x5f8dff,
    roughness: 0.5,
    emissive: 0x1a2f7a,
    emissiveIntensity: 0.8,
  }),
  matGround: new THREE.MeshStandardMaterial({
    color: 0xc9ff4a,
    roughness: 0.35,
    emissive: 0x4d7d00,
    emissiveIntensity: 1.0,
  }),
};

const flagVisual = {
  geom: new THREE.BoxGeometry(0.8, 1.8, 0.25),
  matRed: new THREE.MeshStandardMaterial({ color: 0xbc2f34, roughness: 0.88, emissive: 0x280809, emissiveIntensity: 0.2 }),
  matBlue: new THREE.MeshStandardMaterial({ color: 0x2b53c6, roughness: 0.88, emissive: 0x07122d, emissiveIntensity: 0.2 }),
};

const ballGroup = new THREE.Group();
ballGroup.name = "balls";
scene.add(ballGroup);

const flagGroup = new THREE.Group();
flagGroup.name = "flags";
scene.add(flagGroup);

const remotePlayerVisual = {
  geom: new THREE.BoxGeometry(0.62, 1.5, 0.62),
  matRed: new THREE.MeshStandardMaterial({ color: 0xcd4b3b, roughness: 0.84, emissive: 0x2d0d0b, emissiveIntensity: 0.2 }),
  matBlue: new THREE.MeshStandardMaterial({ color: 0x3e72d2, roughness: 0.84, emissive: 0x0a1738, emissiveIntensity: 0.2 }),
  matDisabled: new THREE.MeshStandardMaterial({ color: 0x787f8a, roughness: 1.0 }),
};

const remotePlayerGroup = new THREE.Group();
remotePlayerGroup.name = "remote-players";
scene.add(remotePlayerGroup);

const zoneMat = new THREE.MeshBasicMaterial({
  color: 0xff3b30,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  side: THREE.DoubleSide,
});
let zoneMesh = null;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function clampPitch(pitch) {
  const limit = Math.PI / 2 - 0.01;
  return Math.max(-limit, Math.min(limit, pitch));
}

function setStatus(msg) {
  statusEl.textContent = msg;
  if (!hudMsgEl) return;
  hudMsgEl.textContent = msg;
  if (msg) hudMsgEl.classList.add("show");
  else hudMsgEl.classList.remove("show");
}

function isTypingContext() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

function clampInt(raw, min, max, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

function loadSessionFromStorage() {
  const storedName = sanitizePlayerName(safeStorageGet(STORAGE_KEYS.playerName) || "");
  const storedTeam = normalizeTeam(safeStorageGet(STORAGE_KEYS.team));
  const storedMode = normalizeMatchMode(safeStorageGet(STORAGE_KEYS.mode));
  if (storedName.length >= MATCH_LIMITS.nameMin) {
    STATE.session.playerName = storedName;
  }
  STATE.session.team = storedTeam;
  STATE.matchConfig.mode = storedMode;
}

function saveSessionToStorage() {
  safeStorageSet(STORAGE_KEYS.playerName, STATE.session.playerName);
  safeStorageSet(STORAGE_KEYS.team, STATE.session.team);
  safeStorageSet(STORAGE_KEYS.mode, STATE.matchConfig.mode);
}

function updateTeamButtons() {
  for (const btn of teamButtons) {
    const isActive = btn.dataset.team === STATE.session.team;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

function updateLobbyForm() {
  if (playerNameInput) playerNameInput.value = STATE.session.playerName;
  if (matchModeInput) matchModeInput.value = STATE.matchConfig.mode;
  if (botCountInput) botCountInput.value = String(STATE.matchConfig.botCount);
  if (matchDurationInput) matchDurationInput.value = String(STATE.matchConfig.durationSec);
  if (matchSummaryEl) {
    matchSummaryEl.textContent = STATE.lastMatchSummary;
    matchSummaryEl.classList.toggle("hidden", !STATE.lastMatchSummary);
  }
  updateTeamButtons();
}

function formatRoomPhaseLabel(phase) {
  if (phase === "ready_check") return "Prêt";
  if (phase === "countdown") return "Décompte";
  if (phase === "playing") return "Match";
  if (phase === "postmatch") return "Résultats";
  return "Lobby";
}

function updateNetworkDebugUi() {
  if (!netDebugEl) return;
  const net = STATE.network;
  const mode = net.useOnlineMode ? "online" : "offline";
  const rtt = Number.isFinite(net.rttMs) ? `${Math.round(net.rttMs)}ms` : "--";
  const snapAge = Number.isFinite(net.snapshotAgeMs) ? `${Math.round(net.snapshotAgeMs)}ms` : "--";
  netDebugEl.textContent = `Réseau: ${mode}/${net.status} · RTT ${rtt} · Snap ${snapAge} · Tick ${net.serverTick}`;
  netDebugEl.title = net.serverUrl ? `Serveur: ${net.serverUrl}` : "";
}

function updateRoomUi() {
  const isOnline = STATE.network.useOnlineMode && STATE.network.status === "online";
  updateNetworkDebugUi();
  if (!readyBtn || !roomStateEl) return;

  // No ready gate in online mode: joining a room should be enough to start playing.
  readyBtn.classList.add("hidden");
  roomStateEl.classList.toggle("hidden", !isOnline);

  const phaseLabel = formatRoomPhaseLabel(STATE.room.phase);
  const countdown =
    STATE.room.phase === "countdown" ? ` · Démarrage ${Math.max(0, Math.ceil(STATE.room.countdownLeftSec))}s` : "";
  const base = `${phaseLabel} · ${STATE.room.totalPlayers} joueurs`;
  const host = STATE.room.hostPlayerId === STATE.network.playerId ? " · Hôte" : "";
  roomStateEl.textContent = `${base}${countdown}${host}`;
}

function createNetHudOverlay() {
  const root = document.createElement("div");
  root.id = "net-hud";
  root.innerHTML = `
    <div class="net-hud-row">
      <span class="net-hud-badge" data-role="badge">DÉCONNECTÉ</span>
      <span>phase: <strong data-role="phase">--</strong></span>
    </div>
    <div class="net-hud-row">
      <span>players: <strong data-role="total-players">0</strong></span>
      <span>ready: <strong data-role="ready-count">0</strong></span>
      <span>host: <strong data-role="host-player-id">--</strong></span>
      <span>tick: <strong data-role="last-tick">--</strong></span>
    </div>
    <div class="net-hud-debug" data-role="telemetry">typesSeen: -- · counts: --</div>
    <div class="net-hud-actions">
      <button type="button" data-role="join-btn">Join</button>
      <button type="button" data-role="ready-btn" class="hidden">Ready: OFF</button>
    </div>
  `;
  document.body.append(root);

  const ui = {
    root,
    badge: root.querySelector('[data-role="badge"]'),
    phase: root.querySelector('[data-role="phase"]'),
    totalPlayers: root.querySelector('[data-role="total-players"]'),
    readyCount: root.querySelector('[data-role="ready-count"]'),
    hostPlayerId: root.querySelector('[data-role="host-player-id"]'),
    lastTick: root.querySelector('[data-role="last-tick"]'),
    telemetry: root.querySelector('[data-role="telemetry"]'),
    joinBtn: root.querySelector('[data-role="join-btn"]'),
    readyBtn: root.querySelector('[data-role="ready-btn"]'),
  };

  ui.joinBtn?.addEventListener("click", onNetHudJoinClick);
  ui.readyBtn?.addEventListener("click", onNetHudReadyClick);
  return ui;
}

function getCurrentReadyState(roomState = null) {
  const source = roomState || STATE.network.liveNetworkState?.roomState;
  if (source && Array.isArray(source.players) && STATE.network.playerId) {
    const me = source.players.find((entry) => entry.id === STATE.network.playerId);
    if (me) return !!me.ready;
  }
  return !!STATE.network.isReady;
}

function summarizeTelemetry(telemetry) {
  const typesSeen = Array.isArray(telemetry?.typesSeen) ? telemetry.typesSeen : [];
  const countsEntries = Object.entries(telemetry?.counts || {})
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1]);
  const sentEntries = Object.entries(telemetry?.sentCounts || {})
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1]);

  const typesPreview = typesSeen.slice(0, 4).join(",");
  const typesSuffix = typesSeen.length > 4 ? ",…" : "";
  const countsPreview = countsEntries
    .slice(0, 4)
    .map(([type, count]) => `${type}:${count}`)
    .join(" ");
  const sentPreview = sentEntries
    .slice(0, 4)
    .map(([type, count]) => `${type}:${count}`)
    .join(" ");

  return {
    typesText: typesPreview ? `${typesPreview}${typesSuffix}` : "--",
    countsText: countsPreview || "--",
    sentText: sentPreview || "--",
  };
}

function updateNetHudOverlay() {
  if (!netHudUi) return;
  const live = STATE.network.liveNetworkState || {};
  const roomState = live.roomState || null;
  const connected = !!live.connected;
  const phase = roomState?.phase || "--";
  const totalPlayers = Number.isFinite(roomState?.totalPlayers) ? roomState.totalPlayers : 0;
  const readyCount = Number.isFinite(roomState?.readyCount) ? roomState.readyCount : 0;
  const hostPlayerId = roomState?.hostPlayerId || "--";
  const lastTick = live.lastServerTick ?? "--";
  const readyState = getCurrentReadyState(roomState);
  const telemetry = live.telemetry || STATE.network.transport?.getTelemetry?.() || null;
  const { typesText, countsText, sentText } = summarizeTelemetry(telemetry);

  if (netHudUi.badge) {
    netHudUi.badge.textContent = connected ? "CONNECTÉ" : "DÉCONNECTÉ";
    netHudUi.badge.classList.toggle("connected", connected);
  }
  if (netHudUi.phase) netHudUi.phase.textContent = String(phase);
  if (netHudUi.totalPlayers) netHudUi.totalPlayers.textContent = String(totalPlayers);
  if (netHudUi.readyCount) netHudUi.readyCount.textContent = String(readyCount);
  if (netHudUi.hostPlayerId) netHudUi.hostPlayerId.textContent = String(hostPlayerId);
  if (netHudUi.lastTick) netHudUi.lastTick.textContent = String(lastTick);
  if (netHudUi.telemetry) netHudUi.telemetry.textContent = `typesSeen: ${typesText} · counts: ${countsText} · sent: ${sentText}`;
  if (netHudUi.readyBtn) {
    netHudUi.readyBtn.classList.add("hidden");
    netHudUi.readyBtn.textContent = readyState ? "Ready: ON" : "Ready: OFF";
    netHudUi.readyBtn.disabled = true;
  }
  if (netHudUi.joinBtn) {
    const canJoin = connected && !STATE.network.joinedRoom;
    const canForceStart = connected && STATE.network.joinedRoom && autoStartBlocked && phase !== "playing";
    const visible = canJoin || canForceStart;
    netHudUi.joinBtn.classList.toggle("hidden", !visible);
    netHudUi.joinBtn.disabled = !visible;
    netHudUi.joinBtn.textContent = canForceStart ? "Démarrer" : "Join";
  }
}

function onNetHudJoinClick() {
  if (!isNetworkOnline()) {
    setStatus("Serveur non connecté.");
    return;
  }

  const parsed = parseLobbySettings();
  if (!parsed.ok) {
    setStatus(parsed.message);
    return;
  }

  STATE.session.playerName = parsed.data.playerName;
  STATE.session.team = parsed.data.team;
  STATE.matchConfig.mode = parsed.data.mode;
  STATE.matchConfig.botCount = parsed.data.botCount;
  STATE.matchConfig.durationSec = parsed.data.durationSec;
  saveSessionToStorage();
  updateLobbyForm();

  if (!requestNetworkMatch(parsed.data, { restartWatchdog: true, statusMessage: "Connexion à la room en cours…" })) {
    setStatus("Impossible d'envoyer Join.");
    return;
  }
}

function onNetHudReadyClick() {
  // Ready is intentionally disabled: the match starts automatically once joined.
}

function clearAutoStartWatchdog({ keepBlocked = false } = {}) {
  if (autoStartWatchdogTimer) {
    window.clearInterval(autoStartWatchdogTimer);
    autoStartWatchdogTimer = null;
  }
  autoStartRequestedAtMs = 0;
  autoStartAttempts = 0;
  if (!keepBlocked) autoStartBlocked = false;
}

function buildCurrentNetworkSettings() {
  const safeName = sanitizePlayerName(STATE.session.playerName || playerNameInput?.value || "");
  return {
    playerName: safeName,
    team: normalizeTeam(STATE.session.team),
    mode: normalizeMatchMode(STATE.matchConfig.mode),
    botCount: clampInt(STATE.matchConfig.botCount, MATCH_LIMITS.botMin, MATCH_LIMITS.botMax, MATCH_LIMITS.defaultBotCount),
    durationSec: clampInt(
      STATE.matchConfig.durationSec,
      MATCH_LIMITS.durationMin,
      MATCH_LIMITS.durationMax,
      MATCH_LIMITS.defaultDurationSec,
    ),
  };
}

function startAutoStartWatchdog() {
  clearAutoStartWatchdog();
  autoStartRequestedAtMs = Date.now();

  autoStartWatchdogTimer = window.setInterval(() => {
    if (!isNetworkOnline()) {
      clearAutoStartWatchdog();
      return;
    }

    if (!STATE.network.joinedRoom) return;

    const phase = String(STATE.room.phase || "");
    if (phase === "playing" || STATE.mode === "playing") {
      clearAutoStartWatchdog();
      return;
    }

    if (phase !== "ready_check" && phase !== "countdown") return;

    const elapsed = Date.now() - autoStartRequestedAtMs;
    if (elapsed < AUTO_START_WATCHDOG_INTERVAL_MS) return;

    if (elapsed > AUTO_START_WATCHDOG_TIMEOUT_MS || autoStartAttempts >= AUTO_START_WATCHDOG_MAX_ATTEMPTS) {
      autoStartBlocked = true;
      setStatus("Room connectée mais démarrage bloqué côté serveur.");
      clearAutoStartWatchdog({ keepBlocked: true });
      updateNetHudOverlay();
      return;
    }

    autoStartAttempts += 1;
    const settings = buildCurrentNetworkSettings();
    if (settings.playerName.length < MATCH_LIMITS.nameMin) {
      setStatus(`Nom requis (${MATCH_LIMITS.nameMin}-${MATCH_LIMITS.nameMax} caractères).`);
      return;
    }
    requestNetworkMatch(settings, {
      restartWatchdog: false,
      statusMessage: "Room connectée, tentative de démarrage…",
    });
  }, AUTO_START_WATCHDOG_INTERVAL_MS);
}

function startNetHudLoop() {
  if (netHudTimer) window.clearInterval(netHudTimer);
  updateNetHudOverlay();
  netHudTimer = window.setInterval(updateNetHudOverlay, NET_HUD_REFRESH_MS);
}

function makeNameLabelSprite(name, team) {
  const labelName = String(name || "?").slice(0, 14);
  const canvasLabel = document.createElement("canvas");
  canvasLabel.width = 256;
  canvasLabel.height = 64;
  const ctx = canvasLabel.getContext("2d");
  if (!ctx) return null;
  const bg = team === "blue" ? "rgba(47,97,196,0.82)" : "rgba(192,57,43,0.82)";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 8, 256, 48);
  ctx.fillStyle = "#f4f7ff";
  ctx.font = "700 26px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(labelName, 128, 32);
  const texture = new THREE.CanvasTexture(canvasLabel);
  texture.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.8, 0.7, 1);
  return sprite;
}

function ensureRemotePlayerEntity(entry) {
  const mesh = new THREE.Mesh(
    remotePlayerVisual.geom,
    entry.team === "blue" ? remotePlayerVisual.matBlue : remotePlayerVisual.matRed,
  );
  const label = makeNameLabelSprite(entry.name, entry.team);
  remotePlayerGroup.add(mesh);
  if (label) remotePlayerGroup.add(label);
  return {
    id: entry.id,
    name: entry.name || "Joueur",
    team: normalizeTeam(entry.team),
    state: entry.state || "active",
    pos: new THREE.Vector3(entry.x ?? 0, entry.y ?? 1.7, entry.z ?? 0),
    targetPos: new THREE.Vector3(entry.x ?? 0, entry.y ?? 1.7, entry.z ?? 0),
    mesh,
    label,
  };
}

function syncRemotePlayersFromSnapshot(snapshotPlayers) {
  const byId = new Map(STATE.remotePlayers.map((rp) => [rp.id, rp]));
  const nextRemotePlayers = [];

  for (const entry of snapshotPlayers) {
    let remote = byId.get(entry.id);
    if (!remote) {
      remote = ensureRemotePlayerEntity(entry);
    }
    remote.name = entry.name || remote.name;
    remote.team = normalizeTeam(entry.team);
    remote.state = entry.state || remote.state;
    remote.targetPos.set(entry.x ?? remote.targetPos.x, entry.y ?? remote.targetPos.y, entry.z ?? remote.targetPos.z);
    if (remote.mesh) {
      remote.mesh.material =
        remote.state === "disabled_spectator"
          ? remotePlayerVisual.matDisabled
          : remote.team === "blue"
            ? remotePlayerVisual.matBlue
            : remotePlayerVisual.matRed;
    }
    byId.delete(entry.id);
    nextRemotePlayers.push(remote);
  }

  for (const stale of byId.values()) {
    if (stale?.mesh) remotePlayerGroup.remove(stale.mesh);
    if (stale?.label) remotePlayerGroup.remove(stale.label);
  }

  STATE.remotePlayers = nextRemotePlayers;
}

function updateInterpolatedEntities() {
  for (const remote of STATE.remotePlayers) {
    remote.pos.lerp(remote.targetPos, 0.28);
    if (remote.mesh) {
      remote.mesh.position.copy(remote.pos);
      remote.mesh.position.y = remote.pos.y + 0.75;
    }
    if (remote.label) {
      remote.label.position.set(remote.pos.x, remote.pos.y + 2.05, remote.pos.z);
    }
  }

  for (const ball of STATE.balls) {
    if (!ball.pos || !ball.targetPos) continue;
    ball.pos.lerp(ball.targetPos, 0.35);
    if (ball.mesh) ball.mesh.position.copy(ball.pos);
  }

  if (STATE.objectives.ctf) {
    for (const flag of Object.values(STATE.objectives.ctf.flags || {})) {
      if (!flag?.targetPos || !flag?.pos) continue;
      flag.pos.lerp(flag.targetPos, 0.3);
      if (flag.mesh) {
        flag.mesh.position.set(flag.pos.x, flag.pos.y + 0.85, flag.pos.z);
      }
    }
  }
}

function resetInputState() {
  input.forward = false;
  input.back = false;
  input.left = false;
  input.right = false;
  input.jumpQueued = false;
  input.sprint = false;
  input.tagQueued = false;
}

function clearArenaEntities() {
  for (const boost of STATE.boosts) {
    if (boost?.mesh) boostGroup.remove(boost.mesh);
  }
  for (const bot of STATE.bots) {
    if (bot?.mesh) botGroup.remove(bot.mesh);
  }
  for (const ball of STATE.balls) {
    if (ball?.mesh) ballGroup.remove(ball.mesh);
  }
  for (const flag of Object.values(STATE.objectives.ctf?.flags || {})) {
    if (flag?.mesh) flagGroup.remove(flag.mesh);
  }
  for (const remote of STATE.remotePlayers) {
    if (remote?.mesh) remotePlayerGroup.remove(remote.mesh);
    if (remote?.label) remotePlayerGroup.remove(remote.label);
  }
  STATE.boosts = [];
  STATE.bots = [];
  STATE.balls = [];
  STATE.objectives.ctf = null;
  STATE.remotePlayers = [];
}

function isNetworkOnline() {
  return STATE.network.useOnlineMode && STATE.network.status === "online";
}

function applyPlayingUiState() {
  uiPanel.style.display = "none";
  hudEl.classList.remove("hidden");
  clearAutoStartWatchdog();
}

function syncBoostsFromSnapshot(snapshotBoosts) {
  const byId = new Map(STATE.boosts.map((boost) => [boost.id, boost]));
  const nextBoosts = [];

  for (const nextBoost of snapshotBoosts) {
    let boost = byId.get(nextBoost.id);
    if (!boost) {
      const mat = BOOST_VISUALS.mats[nextBoost.kind] || BOOST_VISUALS.mats.speed;
      const mesh = new THREE.Mesh(BOOST_VISUALS.geom, mat);
      boost = { id: nextBoost.id, kind: nextBoost.kind, mesh };
      boostGroup.add(mesh);
    }
    boost.kind = nextBoost.kind;
    if (boost.mesh) {
      boost.mesh.material = BOOST_VISUALS.mats[nextBoost.kind] || BOOST_VISUALS.mats.speed;
      boost.mesh.position.set(nextBoost.x, nextBoost.y ?? 0.55, nextBoost.z);
    }
    byId.delete(nextBoost.id);
    nextBoosts.push(boost);
  }

  for (const stale of byId.values()) {
    if (stale?.mesh) boostGroup.remove(stale.mesh);
  }

  STATE.boosts = nextBoosts;
}

function syncBotsFromSnapshot(snapshotBots) {
  const byId = new Map(STATE.bots.map((bot) => [bot.id, bot]));
  const nextBots = [];

  for (const nextBot of snapshotBots) {
    let bot = byId.get(nextBot.id);
    if (!bot) {
      bot = {
        id: nextBot.id,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        yaw: 0,
        energy: 100,
        state: "active",
        mesh: createBotMesh(),
      };
    }

    bot.pos.set(nextBot.x, nextBot.y ?? 1.7, nextBot.z);
    bot.yaw = nextBot.yaw ?? bot.yaw;
    bot.energy = nextBot.energy ?? bot.energy;
    bot.state = nextBot.state || bot.state;
    if (bot.mesh) {
      bot.mesh.position.copy(bot.pos);
      bot.mesh.material = bot.state === "active" ? BOT_VISUALS.matActive : BOT_VISUALS.matFatigued;
    }
    byId.delete(nextBot.id);
    nextBots.push(bot);
  }

  for (const stale of byId.values()) {
    if (stale?.mesh) botGroup.remove(stale.mesh);
  }

  STATE.bots = nextBots;
  STATE.botCount = nextBots.length;
}

function syncBallsFromSnapshot(snapshotBalls) {
  const byId = new Map(STATE.balls.map((ball) => [ball.id, ball]));
  const nextBalls = [];

  for (const nextBall of snapshotBalls) {
    let ball = byId.get(nextBall.id);
    if (!ball) {
      const kind = nextBall.kind === "ground" ? "ground" : "projectile";
      const mesh = new THREE.Mesh(
        ballVisual.geom,
        kind === "ground"
          ? ballVisual.matGround
          : nextBall.team === "blue"
            ? ballVisual.matBlueProjectile
            : ballVisual.matRedProjectile,
      );
      const x = nextBall.x ?? 0;
      const y = nextBall.y ?? 1;
      const z = nextBall.z ?? 0;
      ball = {
        id: nextBall.id,
        kind,
        team: nextBall.team,
        mesh,
        pos: new THREE.Vector3(x, y, z),
        targetPos: new THREE.Vector3(x, y, z),
      };
      ballGroup.add(mesh);
    }

    ball.kind = nextBall.kind === "ground" ? "ground" : "projectile";
    ball.team = nextBall.team;
    const x = nextBall.x ?? 0;
    const y = nextBall.y ?? 1;
    const z = nextBall.z ?? 0;
    ball.targetPos.set(x, y, z);
    if (ball.mesh) {
      ball.mesh.material =
        ball.kind === "ground"
          ? ballVisual.matGround
          : nextBall.team === "blue"
            ? ballVisual.matBlueProjectile
            : ballVisual.matRedProjectile;
    }
    byId.delete(nextBall.id);
    nextBalls.push(ball);
  }

  for (const stale of byId.values()) {
    if (stale?.mesh) ballGroup.remove(stale.mesh);
  }

  STATE.balls = nextBalls;
}

function ensureFlagMesh(team) {
  if (!STATE.objectives.ctf) STATE.objectives.ctf = { flags: {}, captures: { red: 0, blue: 0 } };
  const existing = STATE.objectives.ctf.flags[team];
  if (existing?.mesh) return existing;

  const mesh = new THREE.Mesh(flagVisual.geom, team === "blue" ? flagVisual.matBlue : flagVisual.matRed);
  flagGroup.add(mesh);
  const created = {
    team,
    mesh,
    pos: new THREE.Vector3(0, PLAYER_SPAWN.y, 0),
    targetPos: new THREE.Vector3(0, PLAYER_SPAWN.y, 0),
    carrierId: null,
    isAtBase: true,
  };
  STATE.objectives.ctf.flags[team] = created;
  return created;
}

function syncObjectivesFromSnapshot(objectives) {
  const ctf = objectives?.ctf;
  if (!ctf) {
    for (const flag of Object.values(STATE.objectives.ctf?.flags || {})) {
      if (flag?.mesh) flagGroup.remove(flag.mesh);
    }
    STATE.objectives.ctf = null;
  } else {
    if (!STATE.objectives.ctf) STATE.objectives.ctf = { flags: {}, captures: { red: 0, blue: 0 } };
    STATE.objectives.ctf.captures.red = Number(ctf.captures?.red || 0);
    STATE.objectives.ctf.captures.blue = Number(ctf.captures?.blue || 0);

    for (const team of ["red", "blue"]) {
      const incoming = ctf.flags?.[team];
      if (!incoming) continue;
      const flag = ensureFlagMesh(team);
      flag.carrierId = incoming.carrierId || null;
      flag.isAtBase = Boolean(incoming.isAtBase);
      flag.targetPos.set(Number(incoming.pos?.x || 0), Number(incoming.pos?.y || 1.7), Number(incoming.pos?.z || 0));
      if (flag.mesh) flag.mesh.visible = true;
    }
  }

  const dodgeball = objectives?.dodgeball;
  STATE.objectives.dodgeball = {
    ballCap: Number(dodgeball?.ballCap || 10),
    carriedBalls: Number(dodgeball?.carriedBalls || 0),
    groundBalls: Number(dodgeball?.groundBalls || 0),
    projectileBalls: Number(dodgeball?.projectileBalls || 0),
    totalBalls: Number(dodgeball?.totalBalls || 0),
  };
}

function applyServerSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  setSnapshotMetrics(STATE.network, STATE.network.transport, Number(snapshot.serverTick || 0));

  STATE.timeLeftSec = Number(snapshot.timeLeftSec ?? STATE.timeLeftSec);
  STATE.nowSec = Number(snapshot.nowSec ?? STATE.nowSec);
  STATE.scoreRed = Number(snapshot.score?.red ?? STATE.scoreRed);
  STATE.scoreBlue = Number(snapshot.score?.blue ?? STATE.scoreBlue);
  STATE.zone.phase = snapshot.zone?.phase || STATE.zone.phase;
  STATE.zone.timeToActiveSec = Number(snapshot.zone?.timeToActiveSec ?? STATE.zone.timeToActiveSec);
  STATE.zone.timeLeftSec = Number(snapshot.zone?.timeLeftSec ?? STATE.zone.timeLeftSec);
  STATE.lastMatchSummary = String(snapshot.lastMatchSummary || "");

  if (snapshot.matchConfig) {
    STATE.matchConfig.mode = normalizeMatchMode(snapshot.matchConfig.mode || STATE.matchConfig.mode);
    STATE.matchConfig.botCount = clampInt(
      snapshot.matchConfig.botCount,
      MATCH_LIMITS.botMin,
      MATCH_LIMITS.botMax,
      STATE.matchConfig.botCount,
    );
    STATE.matchConfig.durationSec = clampInt(
      snapshot.matchConfig.durationSec,
      MATCH_LIMITS.durationMin,
      MATCH_LIMITS.durationMax,
      STATE.matchConfig.durationSec,
    );
    STATE.matchConfig.ctfCapturesToWin = clampInt(
      snapshot.matchConfig.ctfCapturesToWin,
      1,
      7,
      STATE.matchConfig.ctfCapturesToWin,
    );
    STATE.matchConfig.dodgeballScoreTarget = clampInt(
      snapshot.matchConfig.dodgeballScoreTarget,
      5,
      200,
      STATE.matchConfig.dodgeballScoreTarget,
    );
    STATE.matchConfig.disabledSec = clampInt(snapshot.matchConfig.disabledSec, 5, 20, STATE.matchConfig.disabledSec);
  }

  if (snapshot.room) {
    STATE.room.phase = snapshot.room.phase || STATE.room.phase;
    STATE.room.hostPlayerId = snapshot.room.hostPlayerId || null;
    STATE.room.readyCount = Number(snapshot.room.readyCount || 0);
    STATE.room.totalPlayers = Number(snapshot.room.totalPlayers || 0);
    STATE.room.countdownLeftSec = Number(snapshot.room.countdownLeftSec || 0);
    STATE.room.players = Array.isArray(snapshot.room.players) ? snapshot.room.players : [];
    const me = STATE.room.players.find((entry) => entry.id === STATE.network.playerId);
    STATE.network.isReady = !!me?.ready;
    updateRoomUi();
  }

  const players = Array.isArray(snapshot.players) ? snapshot.players : [];
  const localPlayer = players.find((entry) => entry.id === STATE.network.playerId) || null;

  if (localPlayer) {
    STATE.session.playerName = localPlayer.name || STATE.session.playerName;
    STATE.session.team = normalizeTeam(localPlayer.team);
    const p = STATE.player;
    p.pos.set(localPlayer.x ?? p.pos.x, localPlayer.y ?? p.pos.y, localPlayer.z ?? p.pos.z);
    p.yaw = Number(localPlayer.yaw ?? p.yaw);
    p.pitch = clampPitch(Number(localPlayer.pitch ?? p.pitch));
    p.energy = Number(localPlayer.energy ?? p.energy);
    p.state = localPlayer.state || p.state;
    p.onGround = Boolean(localPlayer.onGround);
    p.tagCooldownSec = Number(localPlayer.tagCooldownSec ?? p.tagCooldownSec);
    p.fatigueTimerSec = Number(localPlayer.disabledTimerSec ?? localPlayer.fatigueTimerSec ?? p.fatigueTimerSec);
    p.speedUntilSec = STATE.nowSec + Number(localPlayer.speedLeftSec || 0);
    p.jumpUntilSec = STATE.nowSec + Number(localPlayer.jumpLeftSec || 0);
    p.shieldCharges = Number(localPlayer.shieldCharges || 0);
    p.shieldUntilSec = STATE.nowSec + Number(localPlayer.shieldLeftSec || 0);
    p.hasBall = Boolean(localPlayer.hasBall);
  }

  syncRemotePlayersFromSnapshot(players.filter((entry) => entry.id !== STATE.network.playerId));
  syncBotsFromSnapshot(Array.isArray(snapshot.bots) ? snapshot.bots : []);
  syncBallsFromSnapshot(Array.isArray(snapshot.balls) ? snapshot.balls : []);
  syncObjectivesFromSnapshot(snapshot.objectives);
  syncBoostsFromSnapshot(Array.isArray(snapshot.boosts) ? snapshot.boosts : []);

  const previousMode = STATE.mode;
  const snapshotMode = snapshot.mode || STATE.mode;
  if (snapshotMode === "playing") {
    STATE.mode = "playing";
    applyPlayingUiState();
    if (STATE.network.startedViaNetwork) {
      requestPointerLock();
      STATE.network.startedViaNetwork = false;
    }
  } else if (snapshotMode === "postmatch") {
    STATE.mode = "postmatch";
    if (previousMode !== "postmatch") enterLobbyMode(true);
  } else {
    STATE.mode = "lobby";
    if (previousMode !== "lobby") enterLobbyMode(false);
  }
}

function applyServerEvent(message) {
  if (!message || typeof message !== "object") return;
  if (message.event === "error") {
    const reason = String(message.payload?.reason || "Erreur réseau.");
    STATE.network.lastNetworkError = reason;
    setStatus(reason);
    return;
  }

  if (message.event === "match_end") {
    STATE.lastMatchSummary = String(message.payload?.summary || STATE.lastMatchSummary);
  } else if (message.event === "player_disabled_spectator" && message.payload?.targetId === STATE.network.playerId) {
    setStatus(`Touché: spectateur ${STATE.matchConfig.disabledSec}s`);
  } else if (message.event === "player_reenabled" && message.payload?.playerId === STATE.network.playerId) {
    setStatus("Retour en jeu");
  } else if (message.event === "flag_capture") {
    setStatus(`Capture ${message.payload?.byTeam === "blue" ? "Bleue" : "Rouge"}!`);
  } else if (message.event === "ball_hit" && message.payload?.targetId === STATE.network.playerId) {
    setStatus("Touché par ballon");
  } else if (message.event === "ball_pass") {
    if (message.payload?.targetId === STATE.network.playerId) {
      setStatus("Passe reçue");
    } else if (message.payload?.sourceId === STATE.network.playerId) {
      setStatus("Passe envoyée");
    }
  } else if (message.event === "ball_pickup" && message.payload?.byId === STATE.network.playerId) {
    setStatus("Ballon ramassé");
  } else if (message.event === "dry_throw" && message.payload?.playerId === STATE.network.playerId) {
    setStatus("Ramasse un ballon avant de tirer");
  }
}

function applyRoomState(payload) {
  if (!payload || typeof payload !== "object") return;
  STATE.room.phase = payload.phase || STATE.room.phase;
  STATE.room.hostPlayerId = payload.hostPlayerId || null;
  STATE.room.readyCount = Number(payload.readyCount || 0);
  STATE.room.totalPlayers = Number(payload.totalPlayers || 0);
  STATE.room.countdownLeftSec = Number(payload.countdownLeftSec || 0);
  STATE.room.players = Array.isArray(payload.players) ? payload.players : [];

  if (payload.matchConfig) {
    STATE.matchConfig.mode = normalizeMatchMode(payload.matchConfig.mode || STATE.matchConfig.mode);
    STATE.matchConfig.botCount = clampInt(
      payload.matchConfig.botCount,
      MATCH_LIMITS.botMin,
      MATCH_LIMITS.botMax,
      STATE.matchConfig.botCount,
    );
    STATE.matchConfig.durationSec = clampInt(
      payload.matchConfig.durationSec,
      MATCH_LIMITS.durationMin,
      MATCH_LIMITS.durationMax,
      STATE.matchConfig.durationSec,
    );
    STATE.matchConfig.ctfCapturesToWin = clampInt(
      payload.matchConfig.ctfCapturesToWin,
      1,
      7,
      STATE.matchConfig.ctfCapturesToWin,
    );
    STATE.matchConfig.dodgeballScoreTarget = clampInt(
      payload.matchConfig.dodgeballScoreTarget,
      5,
      200,
      STATE.matchConfig.dodgeballScoreTarget,
    );
    STATE.matchConfig.disabledSec = clampInt(payload.matchConfig.disabledSec, 5, 20, STATE.matchConfig.disabledSec);
  }

  const me = STATE.room.players.find((entry) => entry.id === STATE.network.playerId);
  setRoomFlags(STATE.network, { isReady: !!me?.ready });
  updateRoomUi();
}

function initNetworkClient() {
  if (!STATE.network.useOnlineMode) return;

  const { wsClient, NetworkState } = initNetwork({
    url: STATE.network.serverUrl,
    debug: STATE.network.debug,
    onStatus: (status) => {
      setNetworkStatus(STATE.network, status);
      if (status === "connecting") {
        setStatus("Connexion au réseau LatteStream…");
      } else if (status === "online") {
        STATE.network.lastNetworkError = "";
        setStatus("Réseau connecté. Connexion à la room…");
        if (!STATE.network.joinedRoom) {
          const parsed = parseLobbySettings();
          if (parsed.ok) {
            STATE.session.playerName = parsed.data.playerName;
            STATE.session.team = parsed.data.team;
            STATE.matchConfig.mode = parsed.data.mode;
            STATE.matchConfig.botCount = parsed.data.botCount;
            STATE.matchConfig.durationSec = parsed.data.durationSec;
            saveSessionToStorage();
            requestNetworkMatch(parsed.data, { restartWatchdog: true, statusMessage: "Connexion à la room en cours…" });
          } else {
            setStatus(parsed.message);
          }
        }
      } else if (STATE.network.useOnlineMode) {
        clearAutoStartWatchdog();
        setRoomFlags(STATE.network, { joinedRoom: false, isReady: false });
        if (STATE.mode === "playing") {
          clearArenaEntities();
          resetInputState();
          enterLobbyMode(false);
          setStatus("Connexion perdue. Retour au lobby local.");
        } else {
          setStatus("Réseau indisponible, mode solo local disponible.");
        }
      }
      updateRoomUi();
    },
    onWelcome: (payload) => {
      STATE.network.playerId = payload.playerId || STATE.network.playerId;
      STATE.network.startedViaNetwork = true;
      setRoomFlags(STATE.network, { joinedRoom: true });
      setStatus("Connecté à la room.");
      if (payload.assignedSession?.playerName) STATE.session.playerName = payload.assignedSession.playerName;
      if (payload.assignedSession?.team) STATE.session.team = normalizeTeam(payload.assignedSession.team);
      if (payload.matchConfig) {
        STATE.matchConfig.mode = normalizeMatchMode(payload.matchConfig.mode || STATE.matchConfig.mode);
        STATE.matchConfig.botCount = clampInt(
          payload.matchConfig.botCount,
          MATCH_LIMITS.botMin,
          MATCH_LIMITS.botMax,
          STATE.matchConfig.botCount,
        );
        STATE.matchConfig.durationSec = clampInt(
          payload.matchConfig.durationSec,
          MATCH_LIMITS.durationMin,
          MATCH_LIMITS.durationMax,
          STATE.matchConfig.durationSec,
        );
        STATE.matchConfig.ctfCapturesToWin = clampInt(
          payload.matchConfig.ctfCapturesToWin,
          1,
          7,
          STATE.matchConfig.ctfCapturesToWin,
        );
        STATE.matchConfig.dodgeballScoreTarget = clampInt(
          payload.matchConfig.dodgeballScoreTarget,
          5,
          200,
          STATE.matchConfig.dodgeballScoreTarget,
        );
        STATE.matchConfig.disabledSec = clampInt(payload.matchConfig.disabledSec, 5, 20, STATE.matchConfig.disabledSec);
      }
      updateLobbyForm();
      updateRoomUi();
      updateNetHudOverlay();
    },
    onRoomState: (payload) => {
      applyRoomState(payload);
    },
    onSnapshot: (payload) => {
      applyServerSnapshot(payload);
    },
    onEvent: (payload) => {
      applyServerEvent(payload);
    },
  });

  STATE.network.transport = wsClient;
  STATE.network.liveNetworkState = NetworkState;
}

function requestNetworkMatch(settings, { restartWatchdog = true, statusMessage = "Connexion à la room en cours…" } = {}) {
  if (!STATE.network.transport || !isNetworkOnline()) {
    return false;
  }

  autoStartBlocked = false;
  STATE.network.transport.sendHello({
    name: settings.playerName,
    team: settings.team,
    matchConfig: {
      mode: settings.mode,
      botCount: settings.botCount,
      durationSec: settings.durationSec,
      ctfCapturesToWin: STATE.matchConfig.ctfCapturesToWin,
      dodgeballScoreTarget: STATE.matchConfig.dodgeballScoreTarget,
      disabledSec: STATE.matchConfig.disabledSec,
    },
    requestStart: true,
  });
  if (restartWatchdog) startAutoStartWatchdog();
  STATE.network.startedViaNetwork = true;
  setStatus(statusMessage);
  return true;
}

function buildNetworkInputState() {
  return {
    left: !!input.left,
    right: !!input.right,
    up: !!input.forward,
    down: !!input.back,
    action: !!input.jumpQueued,
  };
}

function buildInputSnapshot(inputState) {
  return {
    left: inputState.left,
    right: inputState.right,
    up: inputState.up,
    down: inputState.down,
    action: inputState.action,
    sprint: !!input.sprint,
    tagQueued: !!input.tagQueued,
    yaw: STATE.player.yaw,
    pitch: STATE.player.pitch,
  };
}

function hasInputSnapshotChanged(current, previous) {
  if (!previous) return true;
  return (
    current.left !== previous.left ||
    current.right !== previous.right ||
    current.up !== previous.up ||
    current.down !== previous.down ||
    current.action !== previous.action ||
    current.sprint !== previous.sprint ||
    current.tagQueued !== previous.tagQueued ||
    current.yaw !== previous.yaw ||
    current.pitch !== previous.pitch
  );
}

function sendCurrentInput() {
  if (STATE.mode !== "playing") return;
  const wsClient = STATE.network.transport;
  if (!wsClient) return;
  if (STATE.network.liveNetworkState?.connected === false) return;

  const inputState = buildNetworkInputState();
  const snapshot = buildInputSnapshot(inputState);
  if (!hasInputSnapshotChanged(snapshot, lastSentInputSnapshot)) return;

  const actionQueued = snapshot.tagQueued;
  const isDodgeball = STATE.matchConfig.mode === MATCH_MODES.dodgeball;
  const payload = {
    seq: ++STATE.network.inputSeq,
    dtMs: 50,
    input: {
      forward: inputState.up,
      back: inputState.down,
      left: inputState.left,
      right: inputState.right,
      sprint: snapshot.sprint,
      jump: inputState.action,
      action: actionQueued,
      tag: !isDodgeball && actionQueued,
      throw: isDodgeball && actionQueued,
      yaw: snapshot.yaw,
      pitch: snapshot.pitch,
    },
  };

  const command = cmdInput(payload);
  const sent = wsClient.send(command.type, command.payload);
  if (!sent) return;

  lastSentInputSnapshot = snapshot;
  input.jumpQueued = false;
  input.tagQueued = false;
}

function startInputSender() {
  if (inputSenderTimer) return;
  inputSenderTimer = window.setInterval(() => {
    sendCurrentInput();
  }, 50);
}

function stopInputSender() {
  if (!inputSenderTimer) return;
  window.clearInterval(inputSenderTimer);
  inputSenderTimer = null;
  lastSentInputSnapshot = null;
}

function resetPlayerForMatch() {
  const p = STATE.player;
  p.state = "active";
  p.energy = CONSTANTS.energyMax;
  p.pos.set(PLAYER_SPAWN.x, PLAYER_SPAWN.y, PLAYER_SPAWN.z);
  p.vel.set(0, 0, 0);
  p.yaw = PLAYER_SPAWN.yaw;
  p.pitch = PLAYER_SPAWN.pitch;
  p.onGround = true;
  p.lastHitTimeSec = STATE.nowSec;
  p.invulnUntilSec = STATE.nowSec + CONSTANTS.invulnSec;
  p.tagCooldownSec = 0;
  p.fatigueTimerSec = 0;
  p.speedUntilSec = 0;
  p.jumpUntilSec = 0;
  p.shieldCharges = 0;
  p.shieldUntilSec = 0;
  p.hasBall = false;
}

function getPlayerScoreTeam() {
  return STATE.session.team;
}

function getBotScoreTeam() {
  return getPlayerScoreTeam() === "red" ? "blue" : "red";
}

function addPointToTeam(team) {
  if (team === "blue") STATE.scoreBlue += 1;
  else STATE.scoreRed += 1;
}

function parseLobbySettings() {
  const playerName = sanitizePlayerName(playerNameInput?.value || "");
  const mode = normalizeMatchMode(matchModeInput?.value || STATE.matchConfig.mode);
  const team = normalizeTeam(STATE.session.team);
  const botCount = clampInt(botCountInput?.value, MATCH_LIMITS.botMin, MATCH_LIMITS.botMax, MATCH_LIMITS.defaultBotCount);
  const durationSec = clampInt(
    matchDurationInput?.value,
    MATCH_LIMITS.durationMin,
    MATCH_LIMITS.durationMax,
    MATCH_LIMITS.defaultDurationSec,
  );

  if (playerName.length < MATCH_LIMITS.nameMin) {
    return { ok: false, message: `Nom requis (${MATCH_LIMITS.nameMin}-${MATCH_LIMITS.nameMax} caractères).` };
  }

  if (playerNameInput) playerNameInput.value = playerName;
  if (matchModeInput) matchModeInput.value = mode;
  if (botCountInput) botCountInput.value = String(botCount);
  if (matchDurationInput) matchDurationInput.value = String(durationSec);
  return {
    ok: true,
    data: { playerName, team, mode, botCount, durationSec },
  };
}

function enterLobbyMode(showSummary = false) {
  STATE.mode = showSummary ? "postmatch" : "lobby";
  uiPanel.style.display = "";
  hudEl.classList.add("hidden");
  if (showSummary) {
    startBtn.textContent = STATE.network.useOnlineMode ? "Rejouer (LatteStream)" : "Rejouer le match";
  } else {
    startBtn.textContent = STATE.network.useOnlineMode ? "Entrer (LatteStream)" : "Entrer dans le Colisée";
  }
  if (matchSummaryEl) matchSummaryEl.classList.toggle("hidden", !showSummary || !STATE.lastMatchSummary);
  updateLobbyForm();
}

function startMatch() {
  resetInputState();
  clearArenaEntities();
  STATE.remotePlayers = [];
  STATE.network.startedViaNetwork = false;
  STATE.mode = "playing";
  STATE.timeLeftSec = STATE.matchConfig.durationSec;
  STATE.scoreRed = 0;
  STATE.scoreBlue = 0;
  STATE.botCount = STATE.matchConfig.botCount;
  STATE.statusClearAtSec = 0;
  STATE.nowSec = 0;
  STATE.nextBoostSpawnSec = 1.5;
  STATE.boostSpawnCounter = 0;
  STATE.zone.phase = "safe";
  STATE.zone.timeToActiveSec = 0;
  STATE.zone.timeLeftSec = 0;
  STATE.lastMatchSummary = "";
  if (zoneMesh) {
    zoneMesh.visible = false;
    zoneMat.opacity = 0;
  }
  resetPlayerForMatch();
  uiPanel.style.display = "none";
  hudEl.classList.remove("hidden");
  setStatus("");
  updateHud();
  requestPointerLock();
}

function finishMatch() {
  if (STATE.mode !== "playing") return;
  const winner =
    STATE.scoreRed === STATE.scoreBlue ? "Égalité" : STATE.scoreRed > STATE.scoreBlue ? "Rouge gagne" : "Bleu gagne";
  const myScore = STATE.session.team === "red" ? STATE.scoreRed : STATE.scoreBlue;
  const enemyScore = STATE.session.team === "red" ? STATE.scoreBlue : STATE.scoreRed;
  STATE.lastMatchSummary = `Temps écoulé — ${winner}. Toi (${TEAM_LABELS[STATE.session.team]}): ${myScore} · Adverse: ${enemyScore}.`;
  if (document.pointerLockElement === canvas) {
    document.exitPointerLock?.();
  }
  setStatus(`Score final: ${STATE.scoreRed} - ${STATE.scoreBlue}`);
  enterLobbyMode(true);
  resetInputState();
}

function requestPointerLock() {
  if (navigator.webdriver) return;
  try {
    canvas.requestPointerLock?.();
  } catch {
    setStatus("Pointer lock indisponible. Clique dans la page pour jouer.");
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

document.addEventListener("keydown", (e) => {
  if (isTypingContext() && e.code !== "Enter" && e.code !== "Escape") return;
  if (STATE.mode !== "playing" && e.code !== "KeyF") return;
  if (e.code === "KeyW") input.forward = true;
  if (e.code === "ArrowUp") input.forward = true;
  if (e.code === "KeyS") input.back = true;
  if (e.code === "ArrowDown") input.back = true;
  if (e.code === "KeyA") input.left = true;
  if (e.code === "ArrowLeft") input.left = true;
  if (e.code === "KeyD") input.right = true;
  if (e.code === "ArrowRight") input.right = true;
  if (e.code === "Space") input.jumpQueued = true;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") input.sprint = true;
  if (e.code === "KeyF") toggleFullscreen();
});

document.addEventListener("keyup", (e) => {
  if (STATE.mode !== "playing") return;
  if (e.code === "KeyW") input.forward = false;
  if (e.code === "ArrowUp") input.forward = false;
  if (e.code === "KeyS") input.back = false;
  if (e.code === "ArrowDown") input.back = false;
  if (e.code === "KeyA") input.left = false;
  if (e.code === "ArrowLeft") input.left = false;
  if (e.code === "KeyD") input.right = false;
  if (e.code === "ArrowRight") input.right = false;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") input.sprint = false;
});

document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  const sensitivity = 0.0022;
  STATE.player.yaw -= e.movementX * sensitivity;
  STATE.player.pitch = clampPitch(STATE.player.pitch - e.movementY * sensitivity);
});

document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement === canvas) setStatus("");
  else if (STATE.mode === "playing") setStatus("Souris libérée. Clique pour reprendre.");
});

canvas.addEventListener("click", () => {
  if (STATE.mode !== "playing") return;
  if (document.pointerLockElement !== canvas && !navigator.webdriver) {
    requestPointerLock();
    return;
  }
  input.tagQueued = true;
});

startBtn.addEventListener("click", async () => {
  const parsed = parseLobbySettings();
  if (!parsed.ok) {
    setStatus(parsed.message);
    return;
  }
  STATE.session.playerName = parsed.data.playerName;
  STATE.session.team = parsed.data.team;
  STATE.matchConfig.mode = parsed.data.mode;
  STATE.matchConfig.botCount = parsed.data.botCount;
  STATE.matchConfig.durationSec = parsed.data.durationSec;
  saveSessionToStorage();

  if (requestNetworkMatch(parsed.data)) {
    return;
  }

  startMatch();
});

readyBtn?.classList.add("hidden");

for (const btn of teamButtons) {
  btn.addEventListener("click", () => {
    STATE.session.team = normalizeTeam(btn.dataset.team);
    updateTeamButtons();
  });
}

matchModeInput?.addEventListener("change", () => {
  STATE.matchConfig.mode = normalizeMatchMode(matchModeInput.value);
});

playerNameInput?.addEventListener("blur", () => {
  const cleaned = sanitizePlayerName(playerNameInput.value);
  playerNameInput.value = cleaned;
});

loadSessionFromStorage();
initNetworkClient();
updateLobbyForm();
enterLobbyMode(false);
startNetHudLoop();
startInputSender();

window.addEventListener("beforeunload", () => {
  if (netHudTimer) {
    window.clearInterval(netHudTimer);
    netHudTimer = null;
  }
  clearAutoStartWatchdog();
  stopInputSender();
});

function updateHud() {
  updateNetworkDebugUi();
  const p = STATE.player;
  if (hudPlayerEl) hudPlayerEl.textContent = STATE.session.playerName;
  if (hudTeamEl) hudTeamEl.textContent = TEAM_LABELS[STATE.session.team];
  if (hudModeEl) hudModeEl.textContent = MODE_LABELS[STATE.matchConfig.mode] || STATE.matchConfig.mode;
  hudEnergyEl.textContent = String(Math.round(p.energy));
  const t = Math.max(0, Math.floor(STATE.timeLeftSec));
  const mm = String(Math.floor(t / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  hudTimeEl.textContent = `${mm}:${ss}`;
  hudScoreEl.textContent = `${STATE.scoreRed} - ${STATE.scoreBlue}`;

  if (hudZoneEl) {
    if (STATE.matchConfig.mode === MATCH_MODES.ctf) {
      const captures = STATE.objectives.ctf?.captures || { red: STATE.scoreRed, blue: STATE.scoreBlue };
      hudZoneEl.textContent = `CTF R${captures.red}/${STATE.matchConfig.ctfCapturesToWin} · B${captures.blue}/${STATE.matchConfig.ctfCapturesToWin}`;
    } else if (STATE.matchConfig.mode === MATCH_MODES.dodgeball) {
      hudZoneEl.textContent = `Cible ${STATE.matchConfig.dodgeballScoreTarget} pts`;
    } else {
      const z = STATE.zone;
      if (z.phase === "active") hudZoneEl.textContent = `ACTIVE ${Math.ceil(z.timeLeftSec)}s`;
      else if (z.phase === "warning") hudZoneEl.textContent = `Bientôt ${Math.ceil(z.timeToActiveSec)}s`;
      else hudZoneEl.textContent = `Dans ${Math.ceil(z.timeToActiveSec)}s`;
    }
  }

  if (hudBoostsEl) {
    if (p.state === "disabled_spectator") {
      hudBoostsEl.textContent = `Spectateur libre ${Math.max(0, p.fatigueTimerSec).toFixed(1)}s`;
    } else if (STATE.matchConfig.mode === MATCH_MODES.ctf) {
      const redFlag = STATE.objectives.ctf?.flags?.red;
      const blueFlag = STATE.objectives.ctf?.flags?.blue;
      const redStatus = redFlag?.carrierId ? `Porté` : redFlag?.isAtBase ? `Base` : `Au sol`;
      const blueStatus = blueFlag?.carrierId ? `Porté` : blueFlag?.isAtBase ? `Base` : `Au sol`;
      hudBoostsEl.textContent = `Drapeau R:${redStatus} · B:${blueStatus}`;
    } else if (STATE.matchConfig.mode === MATCH_MODES.dodgeball) {
      const dodge = STATE.objectives.dodgeball || {
        ballCap: 10,
        carriedBalls: 0,
        groundBalls: 0,
        projectileBalls: 0,
        totalBalls: STATE.balls.length,
      };
      hudBoostsEl.textContent = `Ballon: ${p.hasBall ? "Oui" : "Non"} · Sol ${dodge.groundBalls} · Vol ${dodge.projectileBalls} · Jeu ${dodge.totalBalls}/${dodge.ballCap}`;
    } else {
      const parts = [];
      if (STATE.nowSec < p.speedUntilSec) parts.push(`Vitesse ${Math.ceil(p.speedUntilSec - STATE.nowSec)}s`);
      if (STATE.nowSec < p.jumpUntilSec) parts.push(`Saut ${Math.ceil(p.jumpUntilSec - STATE.nowSec)}s`);
      if (p.shieldCharges > 0 && STATE.nowSec < p.shieldUntilSec) parts.push(`Bouclier x${p.shieldCharges}`);
      hudBoostsEl.textContent = parts.length ? parts.join(" · ") : "Aucun";
    }
  }
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function playableEllipseAxes() {
  return {
    a: WORLD.arenaA * WORLD.walkOuterFactor - 0.6,
    b: WORLD.arenaB * WORLD.walkOuterFactor - 0.6,
  };
}

function clampToPlayableEllipse(pos) {
  const { a, b } = playableEllipseAxes();
  const q = (pos.x * pos.x) / (a * a) + (pos.z * pos.z) / (b * b);
  if (q <= 1) return;
  const s = 1 / Math.sqrt(q);
  pos.x *= s;
  pos.z *= s;
}

function samplePointInEllipse(a, b) {
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random());
  return new THREE.Vector3(a * r * Math.cos(t), 0, b * r * Math.sin(t));
}

function sampleBotSpawn(a, b) {
  const minDistSq = CONSTANTS.botRespawnMinPlayerDist * CONSTANTS.botRespawnMinPlayerDist;
  const playerPos = STATE.player.pos;
  let best = samplePointInEllipse(a * 0.75, b * 0.75);
  let bestDistSq = -1;

  for (let i = 0; i < 18; i++) {
    const candidate = samplePointInEllipse(a * 0.75, b * 0.75);
    const dx = candidate.x - playerPos.x;
    const dz = candidate.z - playerPos.z;
    const distSq = dx * dx + dz * dz;
    if (distSq >= minDistSq) {
      return new THREE.Vector3(candidate.x, 1.7, candidate.z);
    }
    if (distSq > bestDistSq) {
      best = candidate;
      bestDistSq = distSq;
    }
  }

  return new THREE.Vector3(best.x, 1.7, best.z);
}

function getBoostSpawnPositions() {
  const { a, b } = playableEllipseAxes();
  const radius = 0.62;
  const offset = -Math.PI / 2;
  const positions = [];
  for (let i = 0; i < 6; i++) {
    const ang = offset + (i / 6) * Math.PI * 2;
    positions.push(new THREE.Vector3(a * radius * Math.cos(ang), 0.55, b * radius * Math.sin(ang)));
  }
  return positions;
}

function createBoost(kind, pos, spawnIndex) {
  const mesh = new THREE.Mesh(BOOST_VISUALS.geom, BOOST_VISUALS.mats[kind]);
  mesh.position.copy(pos);
  mesh.rotation.y = spawnIndex * 0.8;
  boostGroup.add(mesh);
  return {
    id: `boost-${STATE.boostSpawnCounter}`,
    kind,
    spawnIndex,
    baseY: pos.y,
    phase: spawnIndex * 0.9,
    mesh,
  };
}

function spawnBoostIfPossible() {
  if (STATE.boosts.length >= CONSTANTS.boostMaxCount) return;
  const spawns = getBoostSpawnPositions();
  for (let attempt = 0; attempt < spawns.length; attempt++) {
    const spawnIndex = (STATE.boostSpawnCounter + attempt) % spawns.length;
    if (STATE.boosts.some((b) => b.spawnIndex === spawnIndex)) continue;
    const kind = BOOST_KINDS[STATE.boostSpawnCounter % BOOST_KINDS.length];
    const boost = createBoost(kind, spawns[spawnIndex], spawnIndex);
    STATE.boosts.push(boost);
    STATE.boostSpawnCounter++;
    return;
  }
  STATE.boostSpawnCounter++;
}

function removeBoostAt(index) {
  const [boost] = STATE.boosts.splice(index, 1);
  if (boost?.mesh) boostGroup.remove(boost.mesh);
}

function flashStatus(msg, seconds) {
  setStatus(msg);
  STATE.statusClearAtSec = Math.max(STATE.statusClearAtSec, STATE.nowSec + seconds);
}

function applyBoostToPlayer(kind) {
  const p = STATE.player;
  if (kind === "speed") {
    p.speedUntilSec = STATE.nowSec + CONSTANTS.boostSpeedSec;
    flashStatus("Boost: Vitesse!", 1.1);
  } else if (kind === "shield") {
    p.shieldCharges = Math.min(1, p.shieldCharges + 1);
    p.shieldUntilSec = STATE.nowSec + CONSTANTS.boostShieldSec;
    flashStatus("Boost: Bouclier!", 1.1);
  } else if (kind === "jump") {
    p.jumpUntilSec = STATE.nowSec + CONSTANTS.boostJumpSec;
    flashStatus("Boost: Saut!", 1.1);
  }
}

function updateBoosts(dt) {
  // Spawn
  while (STATE.nowSec >= STATE.nextBoostSpawnSec) {
    spawnBoostIfPossible();
    STATE.nextBoostSpawnSec += CONSTANTS.boostSpawnIntervalSec;
  }

  // Animate + pickup
  const p = STATE.player;
  for (let i = STATE.boosts.length - 1; i >= 0; i--) {
    const boost = STATE.boosts[i];
    if (boost.mesh) {
      boost.mesh.rotation.y += dt * 1.4;
      boost.mesh.position.y = boost.baseY + Math.sin(STATE.nowSec * 2.2 + boost.phase) * 0.08;
    }

    if (p.state !== "active") continue;
    const dx = boost.mesh.position.x - p.pos.x;
    const dz = boost.mesh.position.z - p.pos.z;
    if (dx * dx + dz * dz < 1.25 * 1.25) {
      applyBoostToPlayer(boost.kind);
      removeBoostAt(i);
    }
  }
}

function ensureZoneMesh() {
  if (zoneMesh) return;
  const { a, b } = playableEllipseAxes();
  const innerR = Math.sqrt(CONSTANTS.zoneInnerQ);
  zoneMesh = new THREE.Mesh(new THREE.RingGeometry(innerR, 1.0, 96), zoneMat);
  zoneMesh.rotation.x = -Math.PI / 2;
  zoneMesh.position.y = 0.03;
  zoneMesh.scale.set(a, b, 1);
  zoneMesh.visible = false;
  scene.add(zoneMesh);
}

function updateZoneState() {
  ensureZoneMesh();
  const cycle = CONSTANTS.zoneCycleSec;
  const t = (STATE.nowSec + CONSTANTS.zoneOffsetSec) % cycle;

  let phase = "safe";
  let timeToActiveSec = cycle - t;
  let timeLeftSec = 0;
  let opacity = 0;
  let visible = false;

  if (t < CONSTANTS.zoneActiveSec) {
    phase = "active";
    timeLeftSec = CONSTANTS.zoneActiveSec - t;
    timeToActiveSec = 0;
    opacity = 0.35;
    visible = true;
  } else if (t > cycle - CONSTANTS.zoneWarningSec) {
    phase = "warning";
    timeToActiveSec = cycle - t;
    const progress = 1 - timeToActiveSec / CONSTANTS.zoneWarningSec; // 0..1
    opacity = 0.12 + 0.23 * Math.min(1, Math.max(0, progress));
    visible = true;
  }

  STATE.zone.phase = phase;
  STATE.zone.timeToActiveSec = timeToActiveSec;
  STATE.zone.timeLeftSec = timeLeftSec;

  if (zoneMesh) {
    zoneMesh.visible = visible;
    zoneMat.opacity = opacity;
  }
}

function isInRedZone(pos) {
  const { a, b } = playableEllipseAxes();
  const q = (pos.x * pos.x) / (a * a) + (pos.z * pos.z) / (b * b);
  return q >= CONSTANTS.zoneInnerQ;
}

function applyZoneDamage(entity, dt, restPos) {
  if (STATE.zone.phase !== "active") return false;
  if (entity.state !== "active") return false;
  if (!isInRedZone(entity.pos)) return false;

  entity.energy = Math.max(0, entity.energy - CONSTANTS.zoneDrainPerSec * dt);
  entity.lastHitTimeSec = STATE.nowSec;
  if (entity.energy <= 0) {
    fatigueEntity(entity, restPos);
  }
  return true;
}

function getPlayerRestPos() {
  const { a } = playableEllipseAxes();
  return new THREE.Vector3(-a + 1.0, 1.7, 0);
}

function getBotRestPos(index) {
  const { a, b } = playableEllipseAxes();
  const z = ((index % 6) - 2.5) * 1.6;
  return new THREE.Vector3(a - 1.0, 1.7, Math.max(-b + 1.0, Math.min(b - 1.0, z)));
}

function respawnPlayer() {
  const p = STATE.player;
  p.state = "active";
  p.energy = CONSTANTS.energyMax;
  p.fatigueTimerSec = 0;
  p.tagCooldownSec = 0;
  p.lastHitTimeSec = STATE.nowSec;
  p.invulnUntilSec = STATE.nowSec + CONSTANTS.invulnSec;
  p.speedUntilSec = 0;
  p.jumpUntilSec = 0;
  p.shieldCharges = 0;
  p.shieldUntilSec = 0;
  p.pos.set(PLAYER_SPAWN.x, PLAYER_SPAWN.y, PLAYER_SPAWN.z);
  p.vel.set(0, 0, 0);
  setStatus("");
}

function createBotMesh() {
  const mesh = new THREE.Mesh(BOT_VISUALS.geom, BOT_VISUALS.matActive);
  botGroup.add(mesh);
  return mesh;
}

function createBot(index) {
  const { a, b } = playableEllipseAxes();
  const n = Math.max(1, STATE.botCount);
  const angle = (index / n) * Math.PI * 2;
  let p = index === 0 ? TRAINING_DUMMY_POS.clone() : new THREE.Vector3(a * 0.64 * Math.cos(angle), 1.7, b * 0.64 * Math.sin(angle));
  if (index !== 0) {
    const dx = p.x - STATE.player.pos.x;
    const dz = p.z - STATE.player.pos.z;
    if (dx * dx + dz * dz < CONSTANTS.botRespawnMinPlayerDist * CONSTANTS.botRespawnMinPlayerDist) {
      p = new THREE.Vector3(-p.x, 1.7, -p.z);
    }
  }
  const bot = {
    id: `bot-${index}`,
    ai: index === 0 ? "dummy" : "wander",
    pos: new THREE.Vector3(p.x, 1.7, p.z),
    vel: new THREE.Vector3(),
    yaw: index === 0 ? 0 : angle + Math.PI,
    energy: CONSTANTS.energyMax,
    state: "active",
    lastHitTimeSec: -999,
    invulnUntilSec: 0,
    tagCooldownSec: (index % 5) * 0.1,
    fatigueTimerSec: 0,
    target: samplePointInEllipse(a * 0.85, b * 0.85),
    mesh: createBotMesh(),
  };
  bot.mesh.position.copy(bot.pos);
  return bot;
}

function ensureBots() {
  while (STATE.bots.length < STATE.botCount) {
    STATE.bots.push(createBot(STATE.bots.length));
  }
  while (STATE.bots.length > STATE.botCount) {
    const bot = STATE.bots.pop();
    if (bot?.mesh) botGroup.remove(bot.mesh);
  }
}

function setBotVisualState(bot) {
  if (!bot.mesh) return;
  bot.mesh.material = bot.state === "active" ? BOT_VISUALS.matActive : BOT_VISUALS.matFatigued;
}

function applyEnergyRegen(entity, dt) {
  if (entity.state !== "active") return;
  if (STATE.nowSec - entity.lastHitTimeSec < CONSTANTS.regenDelaySec) return;
  entity.energy = Math.min(CONSTANTS.energyMax, entity.energy + CONSTANTS.regenPerSec * dt);
}

function fatigueEntity(entity, restPos) {
  entity.state = "fatigued";
  entity.fatigueTimerSec = CONSTANTS.fatigueSec;
  entity.vel.set(0, 0, 0);
  entity.pos.copy(restPos);
  if ("speedUntilSec" in entity) entity.speedUntilSec = 0;
  if ("jumpUntilSec" in entity) entity.jumpUntilSec = 0;
  if ("shieldCharges" in entity) entity.shieldCharges = 0;
  if ("shieldUntilSec" in entity) entity.shieldUntilSec = 0;
  if ("onGround" in entity) entity.onGround = true;
  if (entity.mesh) {
    entity.mesh.position.copy(entity.pos);
    entity.mesh.material = BOT_VISUALS.matFatigued;
  }
}

function dealDamage(target, amount, restPos) {
  if (target.state !== "active") return false;
  if (STATE.nowSec < (target.invulnUntilSec || 0)) return false;

  const hasShield = (target.shieldCharges || 0) > 0 && STATE.nowSec < (target.shieldUntilSec || 0);
  if (hasShield) {
    target.shieldCharges = Math.max(0, (target.shieldCharges || 0) - 1);
    target.lastHitTimeSec = STATE.nowSec;
    if (target.shieldCharges <= 0) target.shieldUntilSec = 0;
    if (target === STATE.player) flashStatus("Bouclier!", 0.8);
    return false;
  }

  target.energy = Math.max(0, target.energy - amount);
  target.lastHitTimeSec = STATE.nowSec;
  if (target.energy <= 0) {
    fatigueEntity(target, restPos);
    return true;
  }
  return false;
}

function forward2DFromYaw(yaw) {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

function canTag(attacker, target) {
  if (attacker.state !== "active") return false;
  if (attacker.tagCooldownSec > 0) return false;
  if (target.state !== "active") return false;

  const dx = target.pos.x - attacker.pos.x;
  const dz = target.pos.z - attacker.pos.z;
  const distSq = dx * dx + dz * dz;
  if (distSq > CONSTANTS.tagRange * CONSTANTS.tagRange) return false;

  const dist = Math.sqrt(distSq) || 1;
  const f = forward2DFromYaw(attacker.yaw);
  const dot = (f.x * dx + f.z * dz) / dist;
  return dot > 0.15;
}

function tryTag(attacker, target, targetRestPos) {
  if (!canTag(attacker, target)) return false;
  attacker.tagCooldownSec = CONSTANTS.tagCooldownSec;
  return dealDamage(target, CONSTANTS.tagDamage, targetRestPos);
}

function keepBotAwayFromPlayer(bot, player) {
  if (bot.state !== "active") return;
  const dx = bot.pos.x - player.pos.x;
  const dz = bot.pos.z - player.pos.z;
  const minDist = CONSTANTS.botPlayerAvoidDist;
  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist) return;
  const dist = Math.sqrt(distSq) || 0.0001;
  const push = minDist - dist;
  bot.pos.x += (dx / dist) * push;
  bot.pos.z += (dz / dist) * push;
  clampToPlayableEllipse(bot.pos);
}

function resolveBotSpacing(player) {
  const minDist = CONSTANTS.botSpacing;
  const minDistSq = minDist * minDist;

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < STATE.bots.length; i++) {
      keepBotAwayFromPlayer(STATE.bots[i], player);
    }

    for (let i = 0; i < STATE.bots.length; i++) {
      const a = STATE.bots[i];
      if (a.state !== "active") continue;
      for (let j = i + 1; j < STATE.bots.length; j++) {
        const b = STATE.bots[j];
        if (b.state !== "active") continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const distSq = dx * dx + dz * dz;
        if (distSq >= minDistSq) continue;
        const dist = Math.sqrt(distSq) || 0.0001;
        const nx = dx / dist;
        const nz = dz / dist;
        const pushHalf = (minDist - dist) * 0.5;
        a.pos.x -= nx * pushHalf;
        a.pos.z -= nz * pushHalf;
        b.pos.x += nx * pushHalf;
        b.pos.z += nz * pushHalf;
        clampToPlayableEllipse(a.pos);
        clampToPlayableEllipse(b.pos);
      }
    }
  }
}

function update(dt) {
  if (STATE.mode !== "playing") return;

  if (isNetworkOnline()) {
    setSnapshotMetrics(STATE.network, STATE.network.transport);
    return;
  }

  STATE.nowSec += dt;
  STATE.timeLeftSec = Math.max(0, STATE.timeLeftSec - dt);
  if (STATE.timeLeftSec <= 0) {
    finishMatch();
    return;
  }

  ensureBots();

  const p = STATE.player;
  updateZoneState();

  if (p.shieldCharges > 0 && STATE.nowSec >= p.shieldUntilSec) {
    p.shieldCharges = 0;
    p.shieldUntilSec = 0;
  }

  if (STATE.statusClearAtSec > 0 && STATE.nowSec >= STATE.statusClearAtSec && p.state !== "fatigued") {
    if (navigator.webdriver || document.pointerLockElement === canvas) {
      setStatus("");
      STATE.statusClearAtSec = 0;
    }
  }

  const dir = new THREE.Vector3();
  const forward = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  const right = new THREE.Vector3(forward.z, 0, -forward.x);
  if (input.forward) dir.add(forward);
  if (input.back) dir.sub(forward);
  if (input.right) dir.add(right);
  if (input.left) dir.sub(right);
  if (dir.lengthSq() > 0) dir.normalize();

  const speedBoost = STATE.nowSec < p.speedUntilSec ? CONSTANTS.boostSpeedMult : 1;
  const inZone = STATE.zone.phase === "active" && isInRedZone(p.pos);
  const zoneSlow = inZone ? CONSTANTS.zoneSlowMult : 1;
  const speed = (input.sprint ? CONSTANTS.speedSprint : CONSTANTS.speedWalk) * speedBoost * zoneSlow;
  if (p.state === "active") {
    p.vel.x = dir.x * speed;
    p.vel.z = dir.z * speed;
  } else {
    p.vel.x = 0;
    p.vel.z = 0;
  }

  if (p.state === "active" && p.onGround && input.jumpQueued) {
    const jumpMult = STATE.nowSec < p.jumpUntilSec ? CONSTANTS.boostJumpMult : 1;
    p.vel.y = CONSTANTS.jumpSpeed * jumpMult;
    p.onGround = false;
  }
  input.jumpQueued = false;

  if (p.state === "active") {
    p.vel.y -= CONSTANTS.gravity * dt;
    p.pos.addScaledVector(p.vel, dt);
  }

  // floor collision
  if (p.pos.y < 1.7) {
    p.pos.y = 1.7;
    p.vel.y = 0;
    p.onGround = true;
  }

  // keep inside playable oval (sand + walkway)
  clampToPlayableEllipse(p.pos);

  // Zone rouge (fatigue possible)
  applyZoneDamage(p, dt, getPlayerRestPos());

  // Boosts (spawn + animation + pickup)
  updateBoosts(dt);

  p.tagCooldownSec = Math.max(0, p.tagCooldownSec - dt);
  applyEnergyRegen(p, dt);

  if (p.state === "fatigued") {
    p.fatigueTimerSec = Math.max(0, p.fatigueTimerSec - dt);
    setStatus(`Fatigué… retour dans ${p.fatigueTimerSec.toFixed(1)} s`);
    if (p.fatigueTimerSec <= 0) respawnPlayer();
  }

  // Player tags closest bot in front when clicking
  if (input.tagQueued) {
    input.tagQueued = false;
    if (p.state === "active") {
      if (p.tagCooldownSec > 0) {
        flashStatus(`Tag recharge ${p.tagCooldownSec.toFixed(1)}s`, 0.35);
      } else {
        let bestBotIndex = -1;
        let bestDistSq = Infinity;
        let nearestAnyDistSq = Infinity;
        let nearestAnyAhead = false;
        for (let i = 0; i < STATE.bots.length; i++) {
          const bot = STATE.bots[i];
          if (bot.state !== "active") continue;
          const dx = bot.pos.x - p.pos.x;
          const dz = bot.pos.z - p.pos.z;
          const d = dx * dx + dz * dz;
          if (d < nearestAnyDistSq) {
            nearestAnyDistSq = d;
            const dist = Math.sqrt(d) || 1;
            const f = forward2DFromYaw(p.yaw);
            nearestAnyAhead = (f.x * dx + f.z * dz) / dist > 0.15;
          }
          if (!canTag(p, bot)) continue;
          if (d < bestDistSq) {
            bestDistSq = d;
            bestBotIndex = i;
          }
        }
        if (bestBotIndex >= 0) {
          const bestBot = STATE.bots[bestBotIndex];
          const fatigued = tryTag(p, bestBot, getBotRestPos(bestBotIndex));
          if (fatigued) {
            addPointToTeam(getPlayerScoreTeam());
            flashStatus("Tag réussi: adversaire fatigué!", 0.8);
          } else {
            flashStatus(`Touché! Énergie cible: ${Math.round(bestBot.energy)}`, 0.5);
          }
        } else if (nearestAnyDistSq < CONSTANTS.tagRange * CONSTANTS.tagRange) {
          flashStatus(nearestAnyAhead ? "Tag bloqué (cooldown/invulnérable)" : "Vise l'adversaire devant toi", 0.45);
        } else {
          flashStatus("Trop loin pour taguer", 0.45);
        }
      }
    }
  }

  // Bots: simple wandering + occasional tag on player
  const { a, b } = playableEllipseAxes();
  const playerRestPos = getPlayerRestPos();
  for (let i = 0; i < STATE.bots.length; i++) {
    const bot = STATE.bots[i];
    bot.tagCooldownSec = Math.max(0, bot.tagCooldownSec - dt);
    const botRestPos = getBotRestPos(i);

    if (bot.state === "fatigued") {
      bot.fatigueTimerSec = Math.max(0, bot.fatigueTimerSec - dt);
      if (bot.fatigueTimerSec <= 0) {
        // respawn
        const sp = bot.ai === "dummy" ? TRAINING_DUMMY_POS : sampleBotSpawn(a, b);
        bot.state = "active";
        bot.energy = CONSTANTS.energyMax;
        bot.lastHitTimeSec = STATE.nowSec;
        bot.invulnUntilSec = STATE.nowSec + CONSTANTS.invulnSec;
        bot.pos.set(sp.x, 1.7, sp.z);
        bot.vel.set(0, 0, 0);
        bot.target = samplePointInEllipse(a * 0.85, b * 0.85);
        setBotVisualState(bot);
      }
    } else if (bot.ai === "dummy") {
      // Training dummy: stays near spawn, never tags.
      bot.pos.copy(TRAINING_DUMMY_POS);
      bot.vel.set(0, 0, 0);
      applyZoneDamage(bot, dt, botRestPos);
      applyEnergyRegen(bot, dt);
    } else {
      const dx = bot.target.x - bot.pos.x;
      const dz = bot.target.z - bot.pos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 2.5) bot.target = samplePointInEllipse(a * 0.85, b * 0.85);
      const desiredYaw = Math.atan2(dx, dz);
      let dy = desiredYaw - bot.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      bot.yaw += dy * Math.min(1, dt * 2.6);

      const f = forward2DFromYaw(bot.yaw);
      const slowBot = STATE.zone.phase === "active" && isInRedZone(bot.pos) ? CONSTANTS.zoneSlowMult : 1;
      const speedBot = CONSTANTS.speedWalk * CONSTANTS.botSpeedMult * slowBot;
      bot.vel.x = f.x * speedBot;
      bot.vel.z = f.z * speedBot;
      bot.vel.y -= CONSTANTS.gravity * dt;
      bot.pos.x += bot.vel.x * dt;
      bot.pos.z += bot.vel.z * dt;
      bot.pos.y += bot.vel.y * dt;
      if (bot.pos.y < 1.7) {
        bot.pos.y = 1.7;
        bot.vel.y = 0;
      }

      clampToPlayableEllipse(bot.pos);
      applyZoneDamage(bot, dt, botRestPos);
      applyEnergyRegen(bot, dt);

      const fatiguedPlayer = tryTag(bot, p, playerRestPos);
      if (fatiguedPlayer) {
        addPointToTeam(getBotScoreTeam());
      }
    }
  }

  resolveBotSpacing(p);

  for (let i = 0; i < STATE.bots.length; i++) {
    const bot = STATE.bots[i];
    if (bot.mesh) bot.mesh.position.copy(bot.pos);
  }
}

function render(nowMs = performance.now()) {
  updateInterpolatedEntities();
  updateAmbience(nowMs);
  ballVisual.matGround.emissiveIntensity = 0.85 + Math.sin(nowMs * 0.0042) * 0.22;
  const p = STATE.player;
  camera.position.copy(p.pos);
  const lookDir = new THREE.Vector3(
    Math.sin(p.yaw) * Math.cos(p.pitch),
    Math.sin(p.pitch),
    Math.cos(p.yaw) * Math.cos(p.pitch),
  );
  camera.lookAt(p.pos.clone().add(lookDir));
  renderer.render(scene, camera);
  updateHud();
}

let last = performance.now();
let useDeterministicTime = false;
let lastAppliedNetworkSnapshot = null;
function animate(now) {
  const liveSnapshot = STATE.network.liveNetworkState?.lastSnapshot || null;
  if (liveSnapshot && liveSnapshot !== lastAppliedNetworkSnapshot) {
    applySnapshot(liveSnapshot, STATE);
    lastAppliedNetworkSnapshot = liveSnapshot;
  }

  if (!useDeterministicTime) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render(now);
  } else {
    render(now);
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

window.render_game_to_text = () => {
  const p = STATE.player;
  const payload = {
    mode: STATE.mode,
    network: {
      useOnlineMode: STATE.network.useOnlineMode,
      status: STATE.network.status,
      serverUrl: STATE.network.serverUrl,
      playerId: STATE.network.playerId,
      serverTick: STATE.network.serverTick,
      snapshotAgeMs: STATE.network.snapshotAgeMs,
      rttMs: STATE.network.rttMs,
      lastError: STATE.network.lastNetworkError,
    },
    session: {
      playerName: STATE.session.playerName,
      team: STATE.session.team,
      teamLabel: TEAM_LABELS[STATE.session.team],
    },
    matchConfig: {
      mode: STATE.matchConfig.mode,
      durationSec: STATE.matchConfig.durationSec,
      botCount: STATE.matchConfig.botCount,
      disabledSec: STATE.matchConfig.disabledSec,
      ctfCapturesToWin: STATE.matchConfig.ctfCapturesToWin,
      dodgeballScoreTarget: STATE.matchConfig.dodgeballScoreTarget,
    },
    lastMatchSummary: STATE.lastMatchSummary,
    note: "Coordinates: x right, y up, z forward (toward the Colisée).",
    timeLeftSec: Number(STATE.timeLeftSec.toFixed(2)),
    score: { red: STATE.scoreRed, blue: STATE.scoreBlue },
    player: {
      x: Number(p.pos.x.toFixed(2)),
      y: Number(p.pos.y.toFixed(2)),
      z: Number(p.pos.z.toFixed(2)),
      yaw: Number(p.yaw.toFixed(3)),
      pitch: Number(p.pitch.toFixed(3)),
      energy: Math.round(p.energy),
      onGround: p.onGround,
      state: p.state,
      tagCooldownSec: Number(p.tagCooldownSec.toFixed(2)),
      fatigueTimerSec: Number(p.fatigueTimerSec.toFixed(2)),
      speedLeftSec: Number(Math.max(0, p.speedUntilSec - STATE.nowSec).toFixed(2)),
      jumpLeftSec: Number(Math.max(0, p.jumpUntilSec - STATE.nowSec).toFixed(2)),
      shieldCharges: p.shieldCharges,
      shieldLeftSec: Number(Math.max(0, p.shieldUntilSec - STATE.nowSec).toFixed(2)),
      hasBall: p.hasBall,
    },
    remotePlayers: STATE.remotePlayers.map((rp) => ({
      id: rp.id,
      name: rp.name,
      team: rp.team,
      x: Number((rp.pos?.x ?? 0).toFixed(2)),
      z: Number((rp.pos?.z ?? 0).toFixed(2)),
      energy: Math.round(rp.energy ?? 0),
      state: rp.state,
    })),
    objectives: {
      ctf: STATE.objectives.ctf
        ? {
            captures: { ...STATE.objectives.ctf.captures },
            flags: {
              red: {
                carrierId: STATE.objectives.ctf.flags?.red?.carrierId || null,
                isAtBase: !!STATE.objectives.ctf.flags?.red?.isAtBase,
              },
              blue: {
                carrierId: STATE.objectives.ctf.flags?.blue?.carrierId || null,
                isAtBase: !!STATE.objectives.ctf.flags?.blue?.isAtBase,
              },
            },
          }
        : null,
      dodgeball: STATE.objectives.dodgeball,
      activeBalls: STATE.balls.length,
    },
    zone: {
      phase: STATE.zone.phase,
      timeToActiveSec: Number(STATE.zone.timeToActiveSec.toFixed(2)),
      timeLeftSec: Number(STATE.zone.timeLeftSec.toFixed(2)),
    },
    hudMessage: (hudMsgEl?.textContent || "").trim(),
    boosts: STATE.boosts.map((b) => ({
      id: b.id,
      kind: b.kind,
      x: Number((b.mesh?.position.x ?? 0).toFixed(2)),
      z: Number((b.mesh?.position.z ?? 0).toFixed(2)),
    })),
    bots: STATE.bots.map((b) => ({
      id: b.id,
      x: Number(b.pos.x.toFixed(2)),
      z: Number(b.pos.z.toFixed(2)),
      energy: Math.round(b.energy ?? 0),
      state: b.state,
    })),
    balls: STATE.balls.map((b) => ({
      id: b.id,
      kind: b.kind || "projectile",
      team: b.team,
      x: Number((b.mesh?.position.x ?? 0).toFixed(2)),
      z: Number((b.mesh?.position.z ?? 0).toFixed(2)),
    })),
  };
  return JSON.stringify(payload);
};

window.advanceTime = (ms) => {
  useDeterministicTime = true;
  const step = 1 / 60;
  const steps = Math.max(1, Math.round(ms / (1000 * step)));
  for (let i = 0; i < steps; i++) update(step);
  render();
};
