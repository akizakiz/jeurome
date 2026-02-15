import {
  MATCH_LIMITS,
  MATCH_MODES,
  normalizeMatchMode,
  normalizeTeam,
  sanitizeMatchConfig,
  sanitizePlayerName,
} from "../src/network/protocol.js";

const PLAYER_HEIGHT = 1.7;

const WORLD = {
  arenaA: 34,
  arenaB: 24,
  walkOuterFactor: 1.22,
};

const CONSTANTS = {
  gravity: 22,
  speedWalk: 6.4,
  speedSprint: 8.2,
  speedSpectator: 11.5,
  jumpSpeed: 7.6,
  tagRange: 2.0,
  tagCooldownSec: 0.55,
  throwSpeed: 13.5,
  throwCooldownSec: 0.9,
  throwGravity: 18,
  ballRadius: 0.55,
  ballTtlSec: 4.0,
  ballPickupRange: 1.35,
  ballGroundY: 0.58,
  dodgeballBallCap: 10,
  dodgeballSpawnRadiusFactor: 0.56,
  invulnSec: 1.0,
  botSpeedMult: 0.72,
  botRespawnMinPlayerDist: 7.0,
  flagPickupRange: 1.7,
  flagCaptureRange: 2.0,
  flagReturnSec: 12,
  spectatorMinY: 2.5,
  spectatorMaxY: 17,
  spectatorOuterFactor: 1.28,
};

function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function copyVec3(to, from) {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

function setVec3(target, x, y, z) {
  target.x = x;
  target.y = y;
  target.z = z;
}

function addScaledVec3(target, src, scale) {
  target.x += src.x * scale;
  target.y += src.y * scale;
  target.z += src.z * scale;
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function distSq2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function playableEllipseAxes() {
  return {
    a: WORLD.arenaA * WORLD.walkOuterFactor - 0.8,
    b: WORLD.arenaB * WORLD.walkOuterFactor - 0.8,
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

function clampToSpectatorBounds(pos) {
  const { a, b } = playableEllipseAxes();
  const outerA = a * CONSTANTS.spectatorOuterFactor;
  const outerB = b * CONSTANTS.spectatorOuterFactor;
  const q = (pos.x * pos.x) / (outerA * outerA) + (pos.z * pos.z) / (outerB * outerB);
  if (q > 1) {
    const s = 1 / Math.sqrt(q);
    pos.x *= s;
    pos.z *= s;
  }
  pos.y = Math.max(CONSTANTS.spectatorMinY, Math.min(CONSTANTS.spectatorMaxY, pos.y));
}

function samplePointInEllipse(a, b) {
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random());
  return vec3(a * r * Math.cos(t), 0, b * r * Math.sin(t));
}

function sampleBotSpawn(playerPos) {
  const { a, b } = playableEllipseAxes();
  const minDistSq = CONSTANTS.botRespawnMinPlayerDist * CONSTANTS.botRespawnMinPlayerDist;
  let best = samplePointInEllipse(a * 0.75, b * 0.75);
  let bestDistSq = -1;

  for (let i = 0; i < 20; i++) {
    const candidate = samplePointInEllipse(a * 0.75, b * 0.75);
    const dx = candidate.x - playerPos.x;
    const dz = candidate.z - playerPos.z;
    const d = dx * dx + dz * dz;
    if (d >= minDistSq) return vec3(candidate.x, PLAYER_HEIGHT, candidate.z);
    if (d > bestDistSq) {
      best = candidate;
      bestDistSq = d;
    }
  }

  return vec3(best.x, PLAYER_HEIGHT, best.z);
}

function clampPitch(pitch) {
  const limit = Math.PI / 2 - 0.01;
  return Math.max(-limit, Math.min(limit, pitch));
}

function normalizeYaw(yaw) {
  let value = yaw;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function forward2DFromYaw(yaw) {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

function forward3DFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: Math.cos(yaw) * cp,
  };
}

function playerSpawnForTeam(team, index = 0) {
  const laneOffset = (index % 6) * 2 - 5;
  if (team === "blue") {
    return {
      x: laneOffset,
      y: PLAYER_HEIGHT,
      z: 18,
      yaw: Math.PI,
      pitch: -0.4,
    };
  }
  return {
    x: laneOffset,
    y: PLAYER_HEIGHT,
    z: -18,
    yaw: 0,
    pitch: -0.4,
  };
}

function spectatorRestPosForTeam(team) {
  return team === "blue" ? vec3(-22, 7, 22) : vec3(22, 7, -22);
}

function enemyTeam(team) {
  return team === "blue" ? "red" : "blue";
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pushEvent(state, event, payload) {
  state.pendingEvents.push({
    event,
    atSec: round(state.nowSec, 3),
    payload,
  });
}

function addPointToTeam(state, team, amount = 1) {
  if (team === "blue") state.score.blue += amount;
  else state.score.red += amount;
}

function countReadyPlayers(state) {
  let count = 0;
  for (const player of state.players.values()) {
    if (player.ready) count += 1;
  }
  return count;
}

function allPlayersReady(state) {
  if (state.players.size === 0) return false;
  return countReadyPlayers(state) === state.players.size;
}

function computeTeamSpawnIndex(state, playerId, team) {
  let index = 0;
  for (const player of state.players.values()) {
    if (player.team !== team) continue;
    if (player.id === playerId) return index;
    index += 1;
  }
  return index;
}

function createPlayer(playerId, playerName, team) {
  const spawn = playerSpawnForTeam(team, 0);
  return {
    id: playerId,
    kind: "player",
    name: playerName,
    team,
    ready: false,
    pos: vec3(spawn.x, spawn.y, spawn.z),
    vel: vec3(),
    yaw: spawn.yaw,
    pitch: spawn.pitch,
    onGround: true,
    state: "active", // active | disabled_spectator
    disabledTimerSec: 0,
    invulnUntilSec: 0,
    tagCooldownSec: 0,
    throwCooldownSec: 0,
    hasBall: false,
    input: {
      seq: 0,
      forward: false,
      back: false,
      left: false,
      right: false,
      sprint: false,
      jump: false,
      action: false,
      yaw: spawn.yaw,
      pitch: spawn.pitch,
    },
    lastInputDtMs: 50,
    pingMs: null,
  };
}

function createBot(state, index) {
  const { a, b } = playableEllipseAxes();
  const n = Math.max(1, state.matchConfig.botCount);
  const angle = (index / n) * Math.PI * 2;
  const pos = vec3(a * 0.66 * Math.cos(angle), PLAYER_HEIGHT, b * 0.66 * Math.sin(angle));
  return {
    id: `bot-${index}`,
    kind: "bot",
    team: index % 2 === 0 ? "red" : "blue",
    pos,
    vel: vec3(),
    yaw: angle + Math.PI,
    pitch: -0.25,
    state: "active",
    disabledTimerSec: 0,
    invulnUntilSec: 0,
    tagCooldownSec: (index % 6) * 0.08,
    throwCooldownSec: (index % 5) * 0.11,
    hasBall: false,
    target: samplePointInEllipse(a * 0.84, b * 0.84),
  };
}

function resetPlayerForMatch(state, player) {
  const spawnIndex = computeTeamSpawnIndex(state, player.id, player.team);
  const spawn = playerSpawnForTeam(player.team, spawnIndex);
  setVec3(player.pos, spawn.x, spawn.y, spawn.z);
  setVec3(player.vel, 0, 0, 0);
  player.yaw = spawn.yaw;
  player.pitch = spawn.pitch;
  player.onGround = true;
  player.state = "active";
  player.disabledTimerSec = 0;
  player.invulnUntilSec = state.nowSec + CONSTANTS.invulnSec;
  player.tagCooldownSec = 0;
  player.throwCooldownSec = 0;
  player.hasBall = false;
  player.input.action = false;
  player.input.jump = false;
}

function resetBotForMatch(state, bot, referencePos) {
  const spawn = sampleBotSpawn(referencePos);
  setVec3(bot.pos, spawn.x, spawn.y, spawn.z);
  setVec3(bot.vel, 0, 0, 0);
  bot.state = "active";
  bot.disabledTimerSec = 0;
  bot.invulnUntilSec = state.nowSec + CONSTANTS.invulnSec;
  bot.throwCooldownSec = 0;
  bot.tagCooldownSec = 0;
  bot.hasBall = false;
}

function ensureBots(state) {
  while (state.bots.length < state.matchConfig.botCount) {
    state.bots.push(createBot(state, state.bots.length));
  }
  while (state.bots.length > state.matchConfig.botCount) {
    state.bots.pop();
  }
}

function allEntities(state) {
  return [...state.players.values(), ...state.bots];
}

function findEntityById(state, id) {
  if (state.players.has(id)) return state.players.get(id);
  return state.bots.find((bot) => bot.id === id) || null;
}

function canMeleeTag(state, attacker, target) {
  if (!attacker || !target) return false;
  if (attacker.id === target.id) return false;
  if (attacker.team === target.team) return false;
  if (attacker.state !== "active" || target.state !== "active") return false;
  if (attacker.tagCooldownSec > 0) return false;
  if (state.nowSec < (target.invulnUntilSec || 0)) return false;

  const dx = target.pos.x - attacker.pos.x;
  const dz = target.pos.z - attacker.pos.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > CONSTANTS.tagRange * CONSTANTS.tagRange) return false;

  const f = forward2DFromYaw(attacker.yaw);
  const dist = Math.sqrt(d2) || 1;
  const dot = (f.x * dx + f.z * dz) / dist;
  return dot > 0.12;
}

function dropCarriedFlagByCarrier(state, carrierId, dropPos) {
  if (!state.ctf) return;
  for (const flag of Object.values(state.ctf.flags)) {
    if (flag.carrierId !== carrierId) continue;
    flag.carrierId = null;
    flag.isAtBase = false;
    flag.returnTimerSec = CONSTANTS.flagReturnSec;
    flag.pos = vec3(dropPos.x, PLAYER_HEIGHT, dropPos.z);
    pushEvent(state, "flag_drop", {
      flagTeam: flag.team,
      carrierId,
      x: round(flag.pos.x, 2),
      z: round(flag.pos.z, 2),
    });
  }
}

function disableEntity(state, target, sourceId, sourceTeam, reason) {
  if (!target || target.state !== "active") return false;
  if (state.nowSec < (target.invulnUntilSec || 0)) return false;

  target.state = "disabled_spectator";
  target.disabledTimerSec = state.matchConfig.disabledSec;
  setVec3(target.vel, 0, 0, 0);
  target.tagCooldownSec = 0;
  target.throwCooldownSec = 0;
  if (state.matchConfig.mode === MATCH_MODES.dodgeball && target.hasBall) {
    target.hasBall = false;
    spawnGroundBallAt(state, target.pos.x, target.pos.z);
    pushEvent(state, "ball_drop", { byId: target.id, reason: "disabled" });
  }

  if (target.kind === "player") {
    const rest = spectatorRestPosForTeam(target.team);
    copyVec3(target.pos, rest);
  }

  dropCarriedFlagByCarrier(state, target.id, target.pos);

  if (sourceTeam && sourceTeam !== target.team && state.matchConfig.mode === MATCH_MODES.dodgeball) {
    addPointToTeam(state, sourceTeam, 1);
  }

  pushEvent(state, "player_disabled_spectator", {
    targetId: target.id,
    targetTeam: target.team,
    sourceId,
    sourceTeam,
    reason,
    disabledSec: state.matchConfig.disabledSec,
    score: { ...state.score },
  });
  return true;
}

function respawnEntity(state, entity) {
  if (!entity) return;

  if (entity.kind === "player") {
    const spawnIndex = computeTeamSpawnIndex(state, entity.id, entity.team);
    const spawn = playerSpawnForTeam(entity.team, spawnIndex);
    setVec3(entity.pos, spawn.x, spawn.y, spawn.z);
    setVec3(entity.vel, 0, 0, 0);
    entity.yaw = spawn.yaw;
    entity.pitch = spawn.pitch;
    entity.onGround = true;
    entity.state = "active";
    entity.disabledTimerSec = 0;
    entity.invulnUntilSec = state.nowSec + CONSTANTS.invulnSec;
    entity.input.action = false;
    entity.input.jump = false;
    pushEvent(state, "player_reenabled", { playerId: entity.id });
    return;
  }

  const reference = Array.from(state.players.values())[0]?.pos || vec3(0, PLAYER_HEIGHT, 0);
  resetBotForMatch(state, entity, reference);
}

function createCtfState() {
  return {
    captures: { red: 0, blue: 0 },
    flags: {
      red: {
        team: "red",
        homePos: vec3(0, PLAYER_HEIGHT, -20),
        pos: vec3(0, PLAYER_HEIGHT, -20),
        carrierId: null,
        isAtBase: true,
        returnTimerSec: 0,
      },
      blue: {
        team: "blue",
        homePos: vec3(0, PLAYER_HEIGHT, 20),
        pos: vec3(0, PLAYER_HEIGHT, 20),
        carrierId: null,
        isAtBase: true,
        returnTimerSec: 0,
      },
    },
  };
}

function resetFlagToHome(flag) {
  flag.carrierId = null;
  flag.isAtBase = true;
  flag.returnTimerSec = 0;
  flag.pos = vec3(flag.homePos.x, flag.homePos.y, flag.homePos.z);
}

function updateCtf(state, dt) {
  if (!state.ctf) return;

  const entities = allEntities(state);
  for (const entity of entities) {
    if (entity.state !== "active") continue;

    const enemy = enemyTeam(entity.team);
    const enemyFlag = state.ctf.flags[enemy];
    const homeFlag = state.ctf.flags[entity.team];

    if (!enemyFlag.carrierId && distSq(entity.pos, enemyFlag.pos) <= CONSTANTS.flagPickupRange * CONSTANTS.flagPickupRange) {
      enemyFlag.carrierId = entity.id;
      enemyFlag.isAtBase = false;
      enemyFlag.returnTimerSec = 0;
      pushEvent(state, "flag_pickup", {
        flagTeam: enemyFlag.team,
        carrierId: entity.id,
        carrierTeam: entity.team,
      });
    }

    if (enemyFlag.carrierId === entity.id) {
      enemyFlag.pos = vec3(entity.pos.x, PLAYER_HEIGHT, entity.pos.z);
      const canCapture = homeFlag.isAtBase;
      const nearHome = distSq(entity.pos, homeFlag.homePos) <= CONSTANTS.flagCaptureRange * CONSTANTS.flagCaptureRange;
      if (canCapture && nearHome) {
        addPointToTeam(state, entity.team, 1);
        state.ctf.captures[entity.team] += 1;
        resetFlagToHome(enemyFlag);
        pushEvent(state, "flag_capture", {
          byTeam: entity.team,
          carrierId: entity.id,
          captures: { ...state.ctf.captures },
          score: { ...state.score },
        });
      }
    }
  }

  for (const flag of Object.values(state.ctf.flags)) {
    if (flag.carrierId || flag.isAtBase) continue;
    flag.returnTimerSec = Math.max(0, flag.returnTimerSec - dt);
    if (flag.returnTimerSec <= 0) {
      resetFlagToHome(flag);
      pushEvent(state, "flag_return", { flagTeam: flag.team });
    }
  }
}

function spawnBall(state, owner) {
  if (!owner?.hasBall) return false;
  const dir = forward3DFromYawPitch(owner.yaw, owner.pitch);
  const speed = CONSTANTS.throwSpeed;
  const ball = {
    id: `ball-${state.ballCounter++}`,
    kind: "projectile",
    ownerId: owner.id,
    team: owner.team,
    pos: vec3(owner.pos.x + dir.x * 1.1, owner.pos.y + 1.0, owner.pos.z + dir.z * 1.1),
    vel: vec3(dir.x * speed, dir.y * speed * 0.55 + 1.3, dir.z * speed),
    ttlSec: CONSTANTS.ballTtlSec,
  };
  owner.hasBall = false;
  state.balls.push(ball);
  pushEvent(state, "ball_throw", {
    ballId: ball.id,
    ownerId: owner.id,
    ownerTeam: owner.team,
    x: round(ball.pos.x, 2),
    z: round(ball.pos.z, 2),
  });
  return true;
}

function spawnGroundBallAt(state, x, z) {
  const ball = {
    id: `ball-${state.ballCounter++}`,
    kind: "ground",
    ownerId: null,
    team: null,
    pos: vec3(x, CONSTANTS.ballGroundY, z),
    vel: null,
    ttlSec: 0,
  };
  clampToPlayableEllipse(ball.pos);
  ball.pos.y = CONSTANTS.ballGroundY;
  state.balls.push(ball);
  return ball;
}

function toGroundBall(ball, x = ball.pos.x, z = ball.pos.z) {
  ball.kind = "ground";
  ball.ownerId = null;
  ball.team = null;
  setVec3(ball.pos, x, CONSTANTS.ballGroundY, z);
  ball.vel = null;
  ball.ttlSec = 0;
  clampToPlayableEllipse(ball.pos);
  ball.pos.y = CONSTANTS.ballGroundY;
}

function countCarriedBalls(state) {
  let count = 0;
  for (const entity of allEntities(state)) {
    if (entity.hasBall) count += 1;
  }
  return count;
}

function countGroundBalls(state) {
  let count = 0;
  for (const ball of state.balls) {
    if (ball.kind === "ground") count += 1;
  }
  return count;
}

function countProjectileBalls(state) {
  let count = 0;
  for (const ball of state.balls) {
    if (ball.kind === "projectile") count += 1;
  }
  return count;
}

function countDodgeballBallsInPlay(state) {
  return state.balls.length + countCarriedBalls(state);
}

function spawnInitialDodgeballBalls(state) {
  state.balls = [];
  const { a, b } = playableEllipseAxes();
  const r = CONSTANTS.dodgeballSpawnRadiusFactor;
  const count = CONSTANTS.dodgeballBallCap;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = a * r * Math.cos(angle);
    const z = b * r * Math.sin(angle);
    spawnGroundBallAt(state, x, z);
  }
}

function ensureDodgeballBallInvariant(state) {
  if (state.matchConfig.mode !== MATCH_MODES.dodgeball || state.mode !== "playing") return;

  let total = countDodgeballBallsInPlay(state);
  while (total < CONSTANTS.dodgeballBallCap) {
    const { a, b } = playableEllipseAxes();
    const p = samplePointInEllipse(a * 0.62, b * 0.62);
    spawnGroundBallAt(state, p.x, p.z);
    total += 1;
  }
}

function findClosestGroundBall(state, entity, maxDistSq = Infinity) {
  let best = null;
  let bestIndex = -1;
  let bestDistSq = maxDistSq;
  for (let i = 0; i < state.balls.length; i++) {
    const ball = state.balls[i];
    if (ball.kind !== "ground") continue;
    const d = distSq2D(entity.pos, ball.pos);
    if (d >= bestDistSq) continue;
    best = ball;
    bestIndex = i;
    bestDistSq = d;
  }
  return { ball: best, index: bestIndex, distSq: bestDistSq };
}

function tryPickupGroundBall(state, entity) {
  if (state.matchConfig.mode !== MATCH_MODES.dodgeball) return false;
  if (!entity || entity.state !== "active" || entity.hasBall) return false;
  const maxDistSq = CONSTANTS.ballPickupRange * CONSTANTS.ballPickupRange;
  const found = findClosestGroundBall(state, entity, maxDistSq);
  if (!found.ball || found.index < 0) return false;

  const [picked] = state.balls.splice(found.index, 1);
  entity.hasBall = true;
  pushEvent(state, "ball_pickup", {
    byId: entity.id,
    byTeam: entity.team,
    ballId: picked.id,
  });
  return true;
}

function updateBalls(state, dt) {
  if (state.matchConfig.mode !== MATCH_MODES.dodgeball) {
    state.balls = [];
    for (const entity of allEntities(state)) {
      entity.hasBall = false;
    }
    return;
  }

  const entities = allEntities(state);
  for (let i = state.balls.length - 1; i >= 0; i--) {
    const ball = state.balls[i];
    if (ball.kind !== "projectile") continue;
    ball.ttlSec -= dt;
    ball.vel.y -= CONSTANTS.throwGravity * dt;
    addScaledVec3(ball.pos, ball.vel, dt);

    const outOfBounds =
      ball.ttlSec <= 0 ||
      ball.pos.y < 0.35 ||
      ((ball.pos.x * ball.pos.x) / (playableEllipseAxes().a ** 2) + (ball.pos.z * ball.pos.z) / (playableEllipseAxes().b ** 2)) > 1.2;

    if (outOfBounds) {
      toGroundBall(ball);
      pushEvent(state, "ball_drop", { ballId: ball.id, reason: "out" });
      continue;
    }

    let hitTarget = null;
    for (const entity of entities) {
      if (entity.id === ball.ownerId) continue;
      if (entity.state !== "active") continue;
      if (distSq(entity.pos, ball.pos) <= (CONSTANTS.ballRadius + 0.75) ** 2) {
        hitTarget = entity;
        break;
      }
    }

    if (hitTarget) {
      if (hitTarget.team === ball.team) {
        if (!hitTarget.hasBall) {
          hitTarget.hasBall = true;
          pushEvent(state, "ball_pass", {
            ballId: ball.id,
            sourceId: ball.ownerId,
            sourceTeam: ball.team,
            targetId: hitTarget.id,
            targetTeam: hitTarget.team,
          });
          state.balls.splice(i, 1);
        } else {
          toGroundBall(ball, hitTarget.pos.x, hitTarget.pos.z);
          pushEvent(state, "ball_pass", {
            ballId: ball.id,
            sourceId: ball.ownerId,
            sourceTeam: ball.team,
            targetId: hitTarget.id,
            targetTeam: hitTarget.team,
            dropped: true,
          });
        }
        continue;
      }

      const disabled = disableEntity(state, hitTarget, ball.ownerId, ball.team, "ball_hit");
      pushEvent(state, "ball_hit", {
        ballId: ball.id,
        sourceId: ball.ownerId,
        sourceTeam: ball.team,
        targetId: hitTarget.id,
        disabled,
        score: { ...state.score },
      });
      toGroundBall(ball, hitTarget.pos.x, hitTarget.pos.z);
      pushEvent(state, "ball_drop", { ballId: ball.id, reason: "hit" });
    }
  }

  ensureDodgeballBallInvariant(state);
}

function updateSpectatorMovement(player, dt) {
  const input = player.input;
  player.yaw = normalizeYaw(Number.isFinite(input.yaw) ? input.yaw : player.yaw);
  player.pitch = clampPitch(Number.isFinite(input.pitch) ? input.pitch : player.pitch);

  const fwd = forward3DFromYawPitch(player.yaw, player.pitch);
  const right = { x: Math.cos(player.yaw), y: 0, z: -Math.sin(player.yaw) };

  let mx = 0;
  let my = 0;
  let mz = 0;

  if (input.forward) {
    mx += fwd.x;
    mz += fwd.z;
  }
  if (input.back) {
    mx -= fwd.x;
    mz -= fwd.z;
  }
  if (input.right) {
    mx += right.x;
    mz += right.z;
  }
  if (input.left) {
    mx -= right.x;
    mz -= right.z;
  }
  if (input.jump) my += 1;
  if (input.sprint) my -= 1;

  const mag = Math.sqrt(mx * mx + my * my + mz * mz);
  if (mag > 0) {
    mx /= mag;
    my /= mag;
    mz /= mag;
  }

  const speed = CONSTANTS.speedSpectator;
  player.pos.x += mx * speed * dt;
  player.pos.y += my * speed * dt;
  player.pos.z += mz * speed * dt;
  clampToSpectatorBounds(player.pos);

  input.jump = false;
}

function updateActiveMovement(player, dt) {
  const input = player.input;
  player.yaw = normalizeYaw(Number.isFinite(input.yaw) ? input.yaw : player.yaw);
  player.pitch = clampPitch(Number.isFinite(input.pitch) ? input.pitch : player.pitch);

  const fwd = forward2DFromYaw(player.yaw);
  const rightX = fwd.z;
  const rightZ = -fwd.x;

  let mx = 0;
  let mz = 0;
  if (input.forward) {
    mx += fwd.x;
    mz += fwd.z;
  }
  if (input.back) {
    mx -= fwd.x;
    mz -= fwd.z;
  }
  if (input.right) {
    mx += rightX;
    mz += rightZ;
  }
  if (input.left) {
    mx -= rightX;
    mz -= rightZ;
  }

  const mag = Math.sqrt(mx * mx + mz * mz);
  if (mag > 0) {
    mx /= mag;
    mz /= mag;
  }

  const speed = input.sprint ? CONSTANTS.speedSprint : CONSTANTS.speedWalk;
  player.vel.x = mx * speed;
  player.vel.z = mz * speed;

  if (player.onGround && input.jump) {
    player.vel.y = CONSTANTS.jumpSpeed;
    player.onGround = false;
  }
  input.jump = false;

  player.vel.y -= CONSTANTS.gravity * dt;
  addScaledVec3(player.pos, player.vel, dt);

  if (player.pos.y < PLAYER_HEIGHT) {
    player.pos.y = PLAYER_HEIGHT;
    player.vel.y = 0;
    player.onGround = true;
  }

  clampToPlayableEllipse(player.pos);
}

function nearestEnemyForEntity(state, entity) {
  const entities = allEntities(state);
  let best = null;
  let bestDistSq = Infinity;

  for (const target of entities) {
    if (target.id === entity.id) continue;
    if (target.team === entity.team) continue;
    if (target.state !== "active") continue;
    const d = distSq(entity.pos, target.pos);
    if (d < bestDistSq) {
      best = target;
      bestDistSq = d;
    }
  }

  return best;
}

function processPlayerActions(state) {
  for (const player of state.players.values()) {
    if (player.state !== "active") {
      player.input.action = false;
      continue;
    }
    if (!player.input.action) continue;

    if (state.matchConfig.mode === MATCH_MODES.ctf) {
      if (player.tagCooldownSec <= 0) {
        const target = nearestEnemyForEntity(state, player);
        if (target && canMeleeTag(state, player, target)) {
          player.tagCooldownSec = CONSTANTS.tagCooldownSec;
          disableEntity(state, target, player.id, player.team, "tag");
          pushEvent(state, "tag_contact", {
            sourceId: player.id,
            sourceTeam: player.team,
            targetId: target.id,
          });
        }
      }
    } else if (state.matchConfig.mode === MATCH_MODES.dodgeball) {
      if (player.throwCooldownSec <= 0) {
        if (spawnBall(state, player)) {
          player.throwCooldownSec = CONSTANTS.throwCooldownSec;
        } else {
          pushEvent(state, "dry_throw", { playerId: player.id, team: player.team });
        }
      }
    }

    player.input.action = false;
  }
}

function updateBots(state, dt) {
  const { a, b } = playableEllipseAxes();
  const players = Array.from(state.players.values());
  const referencePlayerPos = players[0]?.pos || vec3(0, PLAYER_HEIGHT, 0);

  for (const bot of state.bots) {
    bot.tagCooldownSec = Math.max(0, bot.tagCooldownSec - dt);
    bot.throwCooldownSec = Math.max(0, bot.throwCooldownSec - dt);

    if (bot.state === "disabled_spectator") {
      bot.disabledTimerSec = Math.max(0, bot.disabledTimerSec - dt);
      if (bot.disabledTimerSec <= 0) respawnEntity(state, bot);
      continue;
    }

    const enemy = nearestEnemyForEntity(state, bot);
    const groundTarget =
      state.matchConfig.mode === MATCH_MODES.dodgeball && !bot.hasBall ? findClosestGroundBall(state, bot).ball : null;

    if (groundTarget) {
      const dx = groundTarget.pos.x - bot.pos.x;
      const dz = groundTarget.pos.z - bot.pos.z;
      bot.yaw = Math.atan2(dx, dz);
    } else if (enemy) {
      const dx = enemy.pos.x - bot.pos.x;
      const dz = enemy.pos.z - bot.pos.z;
      bot.yaw = Math.atan2(dx, dz);
    } else {
      const dx = bot.target.x - bot.pos.x;
      const dz = bot.target.z - bot.pos.z;
      if (dx * dx + dz * dz < 3.5) bot.target = samplePointInEllipse(a * 0.84, b * 0.84);
      bot.yaw = Math.atan2(dx, dz);
    }

    const f = forward2DFromYaw(bot.yaw);
    const speed = CONSTANTS.speedWalk * CONSTANTS.botSpeedMult;
    bot.vel.x = f.x * speed;
    bot.vel.z = f.z * speed;
    bot.vel.y -= CONSTANTS.gravity * dt;
    addScaledVec3(bot.pos, bot.vel, dt);

    if (bot.pos.y < PLAYER_HEIGHT) {
      bot.pos.y = PLAYER_HEIGHT;
      bot.vel.y = 0;
    }

    clampToPlayableEllipse(bot.pos);

    if (state.matchConfig.mode === MATCH_MODES.ctf) {
      if (!enemy || enemy.state !== "active") continue;
      if (bot.tagCooldownSec <= 0 && canMeleeTag(state, bot, enemy)) {
        bot.tagCooldownSec = CONSTANTS.tagCooldownSec + Math.random() * 0.25;
        disableEntity(state, enemy, bot.id, bot.team, "tag");
      }
    } else if (state.matchConfig.mode === MATCH_MODES.dodgeball) {
      tryPickupGroundBall(state, bot);
      if (!enemy || enemy.state !== "active") continue;
      if (!bot.hasBall) continue;
      if (bot.throwCooldownSec <= 0 && distSq(bot.pos, enemy.pos) < 21 * 21) {
        bot.throwCooldownSec = CONSTANTS.throwCooldownSec + Math.random() * 0.25;
        bot.pitch = -0.12;
        spawnBall(state, bot);
      }
    }
  }

  if (state.bots.length === 0) return;

  for (let i = 0; i < state.bots.length; i++) {
    const aBot = state.bots[i];
    if (aBot.state !== "active") continue;
    for (let j = i + 1; j < state.bots.length; j++) {
      const bBot = state.bots[j];
      if (bBot.state !== "active") continue;
      const dx = bBot.pos.x - aBot.pos.x;
      const dz = bBot.pos.z - aBot.pos.z;
      const d2 = dx * dx + dz * dz;
      const minD = 1.2;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2) || 0.0001;
      const nx = dx / d;
      const nz = dz / d;
      const push = (minD - d) * 0.5;
      aBot.pos.x -= nx * push;
      aBot.pos.z -= nz * push;
      bBot.pos.x += nx * push;
      bBot.pos.z += nz * push;
      clampToPlayableEllipse(aBot.pos);
      clampToPlayableEllipse(bBot.pos);
    }
  }

  for (const bot of state.bots) {
    if (bot.state !== "active") continue;
    const dx = bot.pos.x - referencePlayerPos.x;
    const dz = bot.pos.z - referencePlayerPos.z;
    if (dx * dx + dz * dz < 1.6 * 1.6) {
      const d = Math.sqrt(dx * dx + dz * dz) || 0.0001;
      bot.pos.x += (dx / d) * 0.2;
      bot.pos.z += (dz / d) * 0.2;
      clampToPlayableEllipse(bot.pos);
    }
  }
}

function startMatchInternal(state) {
  state.mode = "playing";
  state.room.phase = "playing";
  state.room.countdownLeftSec = 0;
  state.nowSec = 0;
  state.timeLeftSec = state.matchConfig.durationSec;
  state.score.red = 0;
  state.score.blue = 0;
  state.lastMatchSummary = "";
  state.zone.phase = "safe";
  state.zone.timeToActiveSec = 0;
  state.zone.timeLeftSec = 0;
  state.boosts = [];
  state.balls = [];
  state.ballCounter = 0;
  state.ctf = createCtfState();

  ensureBots(state);

  for (const player of state.players.values()) {
    player.ready = false;
    resetPlayerForMatch(state, player);
  }

  const refPos = Array.from(state.players.values())[0]?.pos || vec3(0, PLAYER_HEIGHT, 0);
  for (const bot of state.bots) {
    resetBotForMatch(state, bot, refPos);
  }

  if (state.matchConfig.mode === MATCH_MODES.dodgeball) {
    spawnInitialDodgeballBalls(state);
    ensureDodgeballBallInvariant(state);
  }

  pushEvent(state, "match_start", {
    matchConfig: { ...state.matchConfig },
  });
}

function finishMatch(state, reason = "time") {
  if (state.mode !== "playing") return;
  state.mode = "postmatch";
  state.room.phase = "postmatch";
  state.room.countdownLeftSec = 0;

  for (const player of state.players.values()) {
    player.ready = false;
  }

  const winner =
    state.score.red === state.score.blue ? "Égalité" : state.score.red > state.score.blue ? "Rouge gagne" : "Bleu gagne";

  const modeLabel = state.matchConfig.mode === MATCH_MODES.dodgeball ? "Ballon prisonnier" : "Capture du drapeau";
  state.lastMatchSummary = `${modeLabel} terminé — ${winner}. Score ${state.score.red}-${state.score.blue}.`;

  pushEvent(state, "match_end", {
    reason,
    mode: state.matchConfig.mode,
    score: { ...state.score },
    summary: state.lastMatchSummary,
  });
}

function updateRoomFlow(state, dt) {
  if (state.mode === "playing") return;
  if (state.players.size === 0) {
    state.room.phase = "lobby";
    state.room.countdownLeftSec = 0;
    return;
  }
  startMatchInternal(state);
}

function updatePlayers(state, dt) {
  for (const player of state.players.values()) {
    player.tagCooldownSec = Math.max(0, player.tagCooldownSec - dt);
    player.throwCooldownSec = Math.max(0, player.throwCooldownSec - dt);

    if (player.state === "disabled_spectator") {
      updateSpectatorMovement(player, dt);
      player.disabledTimerSec = Math.max(0, player.disabledTimerSec - dt);
      if (player.disabledTimerSec <= 0) respawnEntity(state, player);
      continue;
    }

    updateActiveMovement(player, dt);
    if (state.matchConfig.mode === MATCH_MODES.dodgeball) {
      tryPickupGroundBall(state, player);
    }
  }
}

function evaluateWinConditions(state) {
  if (state.matchConfig.mode === MATCH_MODES.ctf) {
    if (state.ctf.captures.red >= state.matchConfig.ctfCapturesToWin) {
      finishMatch(state, "ctf_target");
      return;
    }
    if (state.ctf.captures.blue >= state.matchConfig.ctfCapturesToWin) {
      finishMatch(state, "ctf_target");
      return;
    }
  }

  if (state.matchConfig.mode === MATCH_MODES.dodgeball) {
    if (state.score.red >= state.matchConfig.dodgeballScoreTarget || state.score.blue >= state.matchConfig.dodgeballScoreTarget) {
      finishMatch(state, "dodgeball_target");
      return;
    }
  }

  if (state.timeLeftSec <= 0) finishMatch(state, "time");
}

export function createServerState() {
  return {
    mode: "lobby",
    hostPlayerId: null,
    serverTick: 0,
    nowSec: 0,
    timeLeftSec: MATCH_LIMITS.defaultDurationSec,
    score: { red: 0, blue: 0 },
    zone: {
      phase: "safe",
      timeToActiveSec: 0,
      timeLeftSec: 0,
    },
    matchConfig: {
      mode: MATCH_MODES.ctf,
      botCount: MATCH_LIMITS.defaultBotCount,
      durationSec: MATCH_LIMITS.defaultDurationSec,
      ctfCapturesToWin: 3,
      dodgeballScoreTarget: 50,
      disabledSec: 10,
    },
    players: new Map(),
    bots: [],
    boosts: [],
    balls: [],
    ballCounter: 0,
    ctf: createCtfState(),
    room: {
      phase: "lobby", // lobby | ready_check | countdown | playing | postmatch
      countdownLeftSec: 0,
      countdownDurationSec: 5,
      minReadyPlayers: 2,
    },
    lastMatchSummary: "",
    pendingEvents: [],
  };
}

export function registerPlayer(state, { playerId, playerName, team }) {
  const cleanName = sanitizePlayerName(playerName || "");
  if (cleanName.length < MATCH_LIMITS.nameMin) {
    return { ok: false, error: `Nom requis (${MATCH_LIMITS.nameMin}-${MATCH_LIMITS.nameMax} caractères).` };
  }

  const normalizedTeam = normalizeTeam(team);
  const existing = state.players.get(playerId);
  if (existing) {
    existing.name = cleanName;
    existing.team = normalizedTeam;
    existing.ready = false;
    pushEvent(state, "join", { playerId, playerName: existing.name, team: existing.team, reconnect: true });
    return { ok: true, player: existing };
  }

  const player = createPlayer(playerId, cleanName, normalizedTeam);
  state.players.set(playerId, player);
  if (!state.hostPlayerId) state.hostPlayerId = playerId;
  if (state.room.phase === "lobby") state.room.phase = "ready_check";
  pushEvent(state, "join", { playerId, playerName: player.name, team: player.team, reconnect: false });
  return { ok: true, player };
}

export function removePlayer(state, playerId) {
  const player = state.players.get(playerId);
  if (!player) return false;
  state.players.delete(playerId);
  pushEvent(state, "leave", { playerId, playerName: player.name, team: player.team });

  dropCarriedFlagByCarrier(state, playerId, player.pos);
  if (state.matchConfig.mode === MATCH_MODES.dodgeball && player.hasBall) {
    spawnGroundBallAt(state, player.pos.x, player.pos.z);
  }

  if (state.players.size === 0) {
    state.mode = "lobby";
    state.hostPlayerId = null;
    state.timeLeftSec = state.matchConfig.durationSec;
    state.bots = [];
    state.balls = [];
    state.room.phase = "lobby";
    state.room.countdownLeftSec = 0;
  } else if (state.hostPlayerId === playerId) {
    state.hostPlayerId = state.players.keys().next().value || null;
  }

  if (state.mode !== "playing" && state.room.phase !== "lobby") {
    state.room.phase = "ready_check";
    state.room.countdownLeftSec = 0;
  }
  if (state.matchConfig.mode === MATCH_MODES.dodgeball) {
    ensureDodgeballBallInvariant(state);
  }
  return true;
}

export function applyPlayerInput(state, playerId, rawPayload) {
  const player = state.players.get(playerId);
  if (!player) return;

  const payload = rawPayload || {};
  const input = payload.input || {};

  player.input.seq = Number(payload.seq || player.input.seq || 0);
  player.lastInputDtMs = Math.max(0, Math.min(1000, Number(payload.dtMs || player.lastInputDtMs || 50)));

  player.input.forward = !!input.forward;
  player.input.back = !!input.back;
  player.input.left = !!input.left;
  player.input.right = !!input.right;
  player.input.sprint = !!input.sprint;
  player.input.jump = player.input.jump || !!input.jump;
  player.input.action = player.input.action || !!input.action || !!input.tag || !!input.throw;

  if (Number.isFinite(input.yaw)) player.input.yaw = Number(input.yaw);
  if (Number.isFinite(input.pitch)) player.input.pitch = Number(input.pitch);
}

export function markPlayerPing(state, playerId, pingMs) {
  const player = state.players.get(playerId);
  if (!player) return;
  player.pingMs = Math.max(0, Math.min(60000, Number(pingMs || 0)));
}

export function configureRoom(state, rawConfig, requestedByPlayerId = null) {
  if (state.players.size === 0) return { ok: false, error: "Aucun joueur connecté." };
  if (state.mode === "playing") return { ok: false, error: "Match en cours." };
  if (requestedByPlayerId && state.hostPlayerId && requestedByPlayerId !== state.hostPlayerId) {
    return { ok: false, error: "Seul l'hôte peut modifier la room." };
  }

  const sanitized = sanitizeMatchConfig(rawConfig || state.matchConfig);
  state.matchConfig = {
    ...state.matchConfig,
    ...sanitized,
    mode: normalizeMatchMode(sanitized.mode),
  };
  state.mode = "lobby";
  state.room.phase = "ready_check";
  state.room.countdownLeftSec = 0;
  for (const player of state.players.values()) {
    player.ready = false;
    player.hasBall = false;
  }
  for (const bot of state.bots) {
    bot.hasBall = false;
  }
  state.balls = [];
  return { ok: true };
}

export function setPlayerReady(state, playerId, ready) {
  const player = state.players.get(playerId);
  if (!player) return { ok: false, error: "Joueur introuvable." };
  if (state.mode === "playing") return { ok: false, error: "Match déjà lancé." };
  player.ready = !!ready;

  if (state.room.phase === "lobby" || state.room.phase === "postmatch") {
    state.room.phase = "ready_check";
  }
  if (state.room.phase === "countdown" && !player.ready) {
    state.room.phase = "ready_check";
    state.room.countdownLeftSec = 0;
    pushEvent(state, "countdown_cancel", { reason: "player_unready", playerId });
  }
  return { ok: true, ready: player.ready };
}

export function buildRoomState(state) {
  const players = Array.from(state.players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    team: player.team,
    ready: !!player.ready,
    isHost: player.id === state.hostPlayerId,
  }));
  return {
    phase: state.room.phase,
    hostPlayerId: state.hostPlayerId,
    readyCount: countReadyPlayers(state),
    totalPlayers: state.players.size,
    minReadyPlayers: Math.min(state.room.minReadyPlayers, state.players.size || state.room.minReadyPlayers),
    countdownLeftSec: round(state.room.countdownLeftSec, 2),
    matchConfig: { ...state.matchConfig },
    players,
  };
}

export function startMatch(state, rawConfig) {
  const configured = configureRoom(state, rawConfig);
  if (!configured.ok) return configured;
  startMatchInternal(state);
  return { ok: true };
}

export function tickServerState(state, dtSec) {
  const dt = Math.max(0.001, Math.min(0.05, dtSec));
  state.serverTick += 1;

  if (state.mode !== "playing") {
    updateRoomFlow(state, dt);
    return;
  }

  state.nowSec += dt;
  state.timeLeftSec = Math.max(0, state.timeLeftSec - dt);

  updatePlayers(state, dt);
  processPlayerActions(state);
  updateBots(state, dt);

  if (state.matchConfig.mode === MATCH_MODES.ctf) {
    updateCtf(state, dt);
    state.score.red = state.ctf.captures.red;
    state.score.blue = state.ctf.captures.blue;
  }

  updateBalls(state, dt);
  if (state.matchConfig.mode === MATCH_MODES.dodgeball) {
    ensureDodgeballBallInvariant(state);
  }
  evaluateWinConditions(state);
}

export function buildSnapshot(state) {
  const ctfPayload = state.ctf
    ? {
        captures: { ...state.ctf.captures },
        flags: {
          red: {
            ...state.ctf.flags.red,
            homePos: {
              x: round(state.ctf.flags.red.homePos.x, 2),
              y: round(state.ctf.flags.red.homePos.y, 2),
              z: round(state.ctf.flags.red.homePos.z, 2),
            },
            pos: {
              x: round(state.ctf.flags.red.pos.x, 2),
              y: round(state.ctf.flags.red.pos.y, 2),
              z: round(state.ctf.flags.red.pos.z, 2),
            },
          },
          blue: {
            ...state.ctf.flags.blue,
            homePos: {
              x: round(state.ctf.flags.blue.homePos.x, 2),
              y: round(state.ctf.flags.blue.homePos.y, 2),
              z: round(state.ctf.flags.blue.homePos.z, 2),
            },
            pos: {
              x: round(state.ctf.flags.blue.pos.x, 2),
              y: round(state.ctf.flags.blue.pos.y, 2),
              z: round(state.ctf.flags.blue.pos.z, 2),
            },
          },
        },
      }
    : null;

  const dodgeballStats = {
    scoreTarget: state.matchConfig.dodgeballScoreTarget,
    ballCap: CONSTANTS.dodgeballBallCap,
    carriedBalls: countCarriedBalls(state),
    groundBalls: countGroundBalls(state),
    projectileBalls: countProjectileBalls(state),
    totalBalls: countDodgeballBallsInPlay(state),
  };

  return {
    mode: state.mode,
    room: buildRoomState(state),
    serverTick: state.serverTick,
    nowSec: round(state.nowSec, 3),
    timeLeftSec: round(state.timeLeftSec, 2),
    score: {
      red: state.score.red,
      blue: state.score.blue,
    },
    matchConfig: {
      mode: state.matchConfig.mode,
      botCount: state.matchConfig.botCount,
      durationSec: state.matchConfig.durationSec,
      ctfCapturesToWin: state.matchConfig.ctfCapturesToWin,
      dodgeballScoreTarget: state.matchConfig.dodgeballScoreTarget,
      disabledSec: state.matchConfig.disabledSec,
    },
    world: {
      mapId: "colosseum_realistic_v1",
      arenaA: WORLD.arenaA,
      arenaB: WORLD.arenaB,
      walkOuterFactor: WORLD.walkOuterFactor,
    },
    zone: {
      phase: state.zone.phase,
      timeToActiveSec: round(state.zone.timeToActiveSec, 2),
      timeLeftSec: round(state.zone.timeLeftSec, 2),
    },
    lastMatchSummary: state.lastMatchSummary,
    players: Array.from(state.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      team: player.team,
      ready: !!player.ready,
      x: round(player.pos.x, 3),
      y: round(player.pos.y, 3),
      z: round(player.pos.z, 3),
      yaw: round(player.yaw, 4),
      pitch: round(player.pitch, 4),
      state: player.state,
      disabledTimerSec: round(player.disabledTimerSec, 2),
      onGround: player.onGround,
      tagCooldownSec: round(player.tagCooldownSec, 2),
      throwCooldownSec: round(player.throwCooldownSec, 2),
      hasBall: !!player.hasBall,
      inputSeq: player.input.seq,
      pingMs: player.pingMs,
    })),
    bots: state.bots.map((bot) => ({
      id: bot.id,
      team: bot.team,
      x: round(bot.pos.x, 3),
      y: round(bot.pos.y, 3),
      z: round(bot.pos.z, 3),
      yaw: round(bot.yaw, 4),
      state: bot.state,
      disabledTimerSec: round(bot.disabledTimerSec, 2),
      hasBall: !!bot.hasBall,
    })),
    balls: state.balls.map((ball) => ({
      id: ball.id,
      kind: ball.kind || "projectile",
      ownerId: ball.ownerId,
      team: ball.team,
      x: round(ball.pos.x, 3),
      y: round(ball.pos.y, 3),
      z: round(ball.pos.z, 3),
    })),
    objectives: {
      ctf: ctfPayload,
      dodgeball: dodgeballStats,
    },
    boosts: [],
  };
}

export function consumeEvents(state) {
  const events = state.pendingEvents;
  state.pendingEvents = [];
  return events;
}
