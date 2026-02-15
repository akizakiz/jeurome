import crypto from "node:crypto";
import process from "node:process";

import cors from "cors";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import LatteStreamServer from "@lattestream/server";
import { z } from "zod";

import {
  MATCH_LIMITS,
  MATCH_MODES,
  MESSAGE_TYPES,
  NETWORK_TICK_RATE,
  PROTOCOL_VERSION,
  normalizeMatchMode,
  normalizeTeam,
  sanitizeMatchConfig,
  sanitizePlayerName,
} from "../src/network/protocol.js";
import {
  applyPlayerInput,
  buildRoomState,
  buildSnapshot,
  configureRoom,
  consumeEvents,
  createServerState,
  markPlayerPing,
  registerPlayer,
  removePlayer,
  setPlayerReady,
  startMatch,
  tickServerState,
} from "./sim.js";

const parsedPort = Number.parseInt(process.env.PORT || "8787", 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 8787;

const parsedTickRate = Number.parseInt(process.env.TICK_RATE || String(NETWORK_TICK_RATE), 10);
const TICK_RATE = Number.isFinite(parsedTickRate) && parsedTickRate > 0 ? parsedTickRate : NETWORK_TICK_RATE;
const TICK_MS = Math.max(20, Math.round(1000 / TICK_RATE));

const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim();
const SESSION_TTL = String(process.env.SESSION_TTL || "12h").trim();
const SESSION_IDLE_TIMEOUT_MS = Number.parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || "45000", 10);
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || "*").trim();

const LS_SECRET_KEY = String(process.env.LS_SECRET_KEY || "").trim();
const LS_CLUSTER = String(process.env.LS_CLUSTER || "eu1").trim();

const rooms = new Map();
const sessionsByToken = new Map();
const playerTokenByRoomPlayer = new Map();

const latteServer = LS_SECRET_KEY
  ? new LatteStreamServer(LS_SECRET_KEY, {
      cluster: LS_CLUSTER || "eu1",
      useTLS: true,
      enableBatching: true,
    })
  : null;

if (!SESSION_SECRET) {
  console.warn("[relay] SESSION_SECRET manquant. Définis une valeur forte en production.");
}
if (!latteServer) {
  console.warn("[relay] LS_SECRET_KEY manquant. Les endpoints auth/publish LatteStream échoueront.");
}

const app = express();
app.use(helmet());
app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    credentials: false,
  }),
);

const joinSchema = z.object({
  roomId: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(MATCH_LIMITS.nameMax),
  team: z.enum(["red", "blue"]).optional(),
  matchConfig: z
    .object({
      mode: z.enum([MATCH_MODES.ctf, MATCH_MODES.dodgeball]).optional(),
      botCount: z.number().int().optional(),
      durationSec: z.number().int().optional(),
      ctfCapturesToWin: z.number().int().optional(),
      dodgeballScoreTarget: z.number().int().optional(),
      disabledSec: z.number().int().optional(),
    })
    .partial()
    .optional(),
  requestStart: z.boolean().optional(),
});

const commandSchema = z.object({
  roomId: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  payload: z.any().optional(),
  sentAtMs: z.number().optional(),
});

const authSchema = z.object({
  socket_id: z.string().min(1),
  channel_name: z.string().min(1),
});

function nowMs() {
  return Date.now();
}

function roomChannel(roomId) {
  return `private-game-${roomId}`;
}

function normalizeRoomId(raw) {
  const value = String(raw || "module5-romeballon3").trim();
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 64) || "module5-romeballon3";
}

function issuePlayerId() {
  return `player-${crypto.randomBytes(4).toString("hex")}`;
}

function roomPlayerKey(roomId, playerId) {
  return `${roomId}::${playerId}`;
}

function ensureRoom(roomId) {
  const normalized = normalizeRoomId(roomId);
  let room = rooms.get(normalized);
  if (room) return room;

  room = {
    roomId: normalized,
    state: createServerState(),
    lastActiveAt: nowMs(),
  };
  rooms.set(normalized, room);
  return room;
}

function touchRoom(room) {
  room.lastActiveAt = nowMs();
}

function parseBearer(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

function verifySessionToken(token) {
  if (!token) return { ok: false, reason: "Token manquant." };
  try {
    const payload = jwt.verify(token, SESSION_SECRET || "dev-insecure-secret");
    if (!payload || typeof payload !== "object") {
      return { ok: false, reason: "Token invalide." };
    }
    const playerId = String(payload.playerId || "");
    const roomId = normalizeRoomId(payload.roomId || "");
    if (!playerId || !roomId) return { ok: false, reason: "Claims de session invalides." };

    const session = sessionsByToken.get(token);
    if (!session) return { ok: false, reason: "Session inconnue." };

    session.lastSeenAt = nowMs();
    return { ok: true, session: { ...session, playerId, roomId } };
  } catch {
    return { ok: false, reason: "Session expirée ou invalide." };
  }
}

function makeSession(playerId, roomId) {
  const token = jwt.sign({ playerId, roomId }, SESSION_SECRET || "dev-insecure-secret", {
    expiresIn: SESSION_TTL,
  });
  const session = {
    token,
    playerId,
    roomId,
    createdAt: nowMs(),
    lastSeenAt: nowMs(),
  };
  sessionsByToken.set(token, session);
  playerTokenByRoomPlayer.set(roomPlayerKey(roomId, playerId), token);
  return session;
}

function removeSession(token) {
  const session = sessionsByToken.get(token);
  if (!session) return;
  sessionsByToken.delete(token);
  playerTokenByRoomPlayer.delete(roomPlayerKey(session.roomId, session.playerId));
}

async function trigger(roomId, eventName, payload) {
  if (!latteServer) return;
  try {
    await latteServer.trigger(roomChannel(roomId), eventName, payload);
  } catch (error) {
    console.error("[relay] publish failed", eventName, roomId, error?.message || error);
  }
}

async function flushAndBroadcast(room) {
  const roomId = room.roomId;
  const events = consumeEvents(room.state);
  for (const event of events) {
    await trigger(roomId, "game:event", event);
  }

  await trigger(roomId, "game:room_state", buildRoomState(room.state));
  await trigger(roomId, "game:snapshot", buildSnapshot(room.state));
}

async function handleJoin(body) {
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, code: 400, error: "Payload join invalide." };
  }

  const roomId = normalizeRoomId(parsed.data.roomId);
  const room = ensureRoom(roomId);
  touchRoom(room);

  const playerId = issuePlayerId();
  const playerName = sanitizePlayerName(parsed.data.name || "");
  const team = normalizeTeam(parsed.data.team || "red");

  if (playerName.length < MATCH_LIMITS.nameMin) {
    return {
      ok: false,
      code: 400,
      error: `Nom requis (${MATCH_LIMITS.nameMin}-${MATCH_LIMITS.nameMax} caractères).`,
    };
  }

  const result = registerPlayer(room.state, {
    playerId,
    playerName,
    team,
  });
  if (!result.ok) {
    return { ok: false, code: 400, error: result.error || "Join refusé." };
  }

  const isHost = playerId === room.state.hostPlayerId;

  if (parsed.data.matchConfig && isHost) {
    const safeConfig = sanitizeMatchConfig(parsed.data.matchConfig);
    const configured = configureRoom(room.state, safeConfig, playerId);
    if (!configured.ok) return { ok: false, code: 400, error: configured.error || "Config refusée." };
  }

  if (parsed.data.requestStart && isHost) {
    const safeConfig = parsed.data.matchConfig ? sanitizeMatchConfig(parsed.data.matchConfig) : null;
    const started = startMatch(room.state, safeConfig);
    if (!started.ok) return { ok: false, code: 400, error: started.error || "Match impossible à démarrer." };
  }

  // Auto-start the match immediately after a join when the room is not already playing.
  if (room.state.mode !== "playing") {
    const safeConfig = parsed.data.matchConfig ? sanitizeMatchConfig(parsed.data.matchConfig) : null;
    const started = startMatch(room.state, safeConfig);
    if (!started.ok) return { ok: false, code: 400, error: started.error || "Match impossible à démarrer." };
  }

  const session = makeSession(playerId, roomId);

  const welcome = {
    playerId,
    tickRate: TICK_RATE,
    protocolVersion: PROTOCOL_VERSION,
    matchConfig: { ...room.state.matchConfig },
    limits: {
      nameMin: MATCH_LIMITS.nameMin,
      nameMax: MATCH_LIMITS.nameMax,
      botMin: MATCH_LIMITS.botMin,
      botMax: MATCH_LIMITS.botMax,
      durationMin: MATCH_LIMITS.durationMin,
      durationMax: MATCH_LIMITS.durationMax,
    },
    assignedSession: {
      playerName: result.player.name,
      team: result.player.team,
    },
  };

  await trigger(roomId, "game:welcome", {
    targetPlayerId: playerId,
    payload: welcome,
  });
  await flushAndBroadcast(room);

  return {
    ok: true,
    code: 200,
    body: {
      ok: true,
      roomId,
      playerId,
      sessionToken: session.token,
      protocolVersion: PROTOCOL_VERSION,
      tickRate: TICK_RATE,
      welcome,
      roomState: buildRoomState(room.state),
      snapshot: buildSnapshot(room.state),
    },
  };
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    rooms: rooms.size,
    sessions: sessionsByToken.size,
    lattestreamConfigured: !!latteServer,
  });
});

app.post("/v1/session/join", async (req, res) => {
  const result = await handleJoin(req.body || {});
  if (!result.ok) {
    res.status(result.code).json({ ok: false, error: result.error || "Join refusé." });
    return;
  }
  res.status(result.code).json(result.body);
});

app.post("/v1/session/leave", async (req, res) => {
  const token = parseBearer(req);
  const verified = verifySessionToken(token);
  if (!verified.ok) {
    res.status(401).json({ ok: false, error: verified.reason });
    return;
  }

  const { session } = verified;
  const room = rooms.get(session.roomId);
  if (room) {
    removePlayer(room.state, session.playerId);
    touchRoom(room);
    await flushAndBroadcast(room);
  }
  removeSession(token);
  res.status(200).json({ ok: true });
});

app.post("/v1/lattestream/auth", async (req, res) => {
  if (!latteServer) {
    res.status(500).json({ ok: false, error: "LS_SECRET_KEY non configuré." });
    return;
  }

  const token = parseBearer(req);
  const verified = verifySessionToken(token);
  if (!verified.ok) {
    res.status(401).json({ ok: false, error: verified.reason });
    return;
  }

  const parsed = authSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Payload auth invalide." });
    return;
  }

  const { session } = verified;
  const expectedChannel = roomChannel(session.roomId);
  if (parsed.data.channel_name !== expectedChannel) {
    res.status(403).json({ ok: false, error: "Channel non autorisé pour cette session." });
    return;
  }

  try {
    const authResponse = await latteServer.authorizeChannel(parsed.data.socket_id, parsed.data.channel_name);
    res.status(200).json(authResponse);
  } catch (error) {
    res.status(403).json({ ok: false, error: error?.message || "Authorization refusée." });
  }
});

app.post("/v1/command", async (req, res) => {
  const token = parseBearer(req);
  const verified = verifySessionToken(token);
  if (!verified.ok) {
    res.status(401).json({ ok: false, error: verified.reason });
    return;
  }

  const parsed = commandSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Payload command invalide." });
    return;
  }

  const { session } = verified;
  const roomId = normalizeRoomId(parsed.data.roomId);
  if (roomId !== session.roomId) {
    res.status(403).json({ ok: false, error: "Room invalide pour cette session." });
    return;
  }

  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ ok: false, error: "Room introuvable." });
    return;
  }
  touchRoom(room);

  const type = parsed.data.type;
  const payload = parsed.data.payload || {};

  if (type === MESSAGE_TYPES.cInput) {
    applyPlayerInput(room.state, session.playerId, payload);
  } else if (type === MESSAGE_TYPES.cRoomReady) {
    const result = setPlayerReady(room.state, session.playerId, !!payload.ready);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error || "Impossible de mettre prêt." });
      return;
    }
    await trigger(roomId, "game:room_state", buildRoomState(room.state));
  } else if (type === MESSAGE_TYPES.cPing) {
    const sentAtMs = Number(payload?.sentAtMs || 0);
    const rttMs = sentAtMs > 0 ? nowMs() - sentAtMs : 0;
    markPlayerPing(room.state, session.playerId, rttMs);
    await trigger(roomId, "game:pong", {
      targetPlayerId: session.playerId,
      payload: {
        sentAtMs,
        serverNowMs: nowMs(),
        rttMs,
      },
    });
  } else {
    res.status(400).json({ ok: false, error: `Type de commande non supporté: ${type}` });
    return;
  }

  res.status(202).json({ ok: true });
});

const loop = setInterval(async () => {
  const startMs = nowMs();
  const staleTokens = [];

  for (const [token, session] of sessionsByToken.entries()) {
    if (startMs - Number(session.lastSeenAt || 0) > SESSION_IDLE_TIMEOUT_MS) staleTokens.push(token);
  }

  for (const token of staleTokens) {
    const session = sessionsByToken.get(token);
    if (!session) continue;
    const room = rooms.get(session.roomId);
    if (room) {
      removePlayer(room.state, session.playerId);
      touchRoom(room);
      await flushAndBroadcast(room);
    }
    removeSession(token);
  }

  for (const room of rooms.values()) {
    tickServerState(room.state, 1 / TICK_RATE);
    await flushAndBroadcast(room);
  }
}, TICK_MS);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[relay] HTTP prêt sur http://0.0.0.0:${PORT}`);
});

async function shutdown() {
  clearInterval(loop);
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
