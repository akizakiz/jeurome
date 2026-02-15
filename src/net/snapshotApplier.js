const seenSnapshotKeys = new Set();

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractPosition(entity) {
  if (!entity || typeof entity !== "object") return null;
  const pos = entity.pos && typeof entity.pos === "object" ? entity.pos : null;
  const x = toFiniteNumber(pos?.x ?? entity.x);
  const y = toFiniteNumber(pos?.y ?? entity.y);
  const z = toFiniteNumber(pos?.z ?? entity.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function applyPlayers(snapshotPlayers, gameState) {
  if (!Array.isArray(snapshotPlayers) || !gameState || typeof gameState !== "object") return;

  const localId = gameState?.network?.playerId;
  const remotePlayers = Array.isArray(gameState.remotePlayers) ? gameState.remotePlayers : [];
  const remoteById = new Map(remotePlayers.map((entry) => [entry?.id, entry]));

  for (const entry of snapshotPlayers) {
    if (!entry || typeof entry !== "object") continue;
    const pos = extractPosition(entry);
    if (!pos) continue;

    if (localId && entry.id === localId && gameState.player?.pos?.set) {
      gameState.player.pos.set(pos.x, pos.y, pos.z);
      continue;
    }

    const remote = remoteById.get(entry.id);
    if (!remote) continue;
    if (remote.targetPos?.set) {
      remote.targetPos.set(pos.x, pos.y, pos.z);
    } else if (remote.pos?.set) {
      remote.pos.set(pos.x, pos.y, pos.z);
    }
  }
}

function applyBallLike(ballLike, gameState) {
  if (!ballLike || typeof ballLike !== "object" || !gameState || typeof gameState !== "object") return;
  const pos = extractPosition(ballLike);
  if (!pos) return;

  const balls = Array.isArray(gameState.balls) ? gameState.balls : [];
  if (balls.length === 0) return;

  let target = null;
  if (ballLike.id != null) {
    target = balls.find((ball) => ball?.id === ballLike.id) || null;
  }
  if (!target) target = balls[0] || null;
  if (!target) return;

  if (target.targetPos?.set) {
    target.targetPos.set(pos.x, pos.y, pos.z);
  } else if (target.pos?.set) {
    target.pos.set(pos.x, pos.y, pos.z);
  }
}

export function applySnapshot(snapshot, gameState) {
  try {
    if (!snapshot || typeof snapshot !== "object") return;

    for (const key of Object.keys(snapshot)) {
      if (seenSnapshotKeys.has(key)) continue;
      seenSnapshotKeys.add(key);
      console.debug("[snapshot] nouvelles clés snapshot:", key);
    }

    if (Array.isArray(snapshot.players)) {
      applyPlayers(snapshot.players, gameState);
    }

    if (snapshot.balloon && typeof snapshot.balloon === "object") {
      applyBallLike(snapshot.balloon, gameState);
    } else if (snapshot.ball && typeof snapshot.ball === "object") {
      applyBallLike(snapshot.ball, gameState);
    }
  } catch {
    // Never throw: snapshot discovery must remain non-fatal.
  }
}
