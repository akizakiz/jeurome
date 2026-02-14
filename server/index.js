import crypto from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { WebSocketServer } from "ws";

import { MATCH_LIMITS, MESSAGE_TYPES, NETWORK_TICK_RATE, PROTOCOL_VERSION } from "../src/network/protocol.js";
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
const TICK_MS = Math.round(1000 / NETWORK_TICK_RATE);

const state = createServerState();
const socketsByPlayerId = new Map();
const playerIdBySocket = new WeakMap();

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const wss = new WebSocketServer({ server });

server.listen(PORT, "0.0.0.0", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`[server] WebSocket autoritaire prêt sur ws://0.0.0.0:${boundPort}`);
});

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function send(socket, type, payload) {
  if (!socket || socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({ type, payload }));
}

function broadcast(type, payload) {
  for (const socket of wss.clients) {
    send(socket, type, payload);
  }
}

function issuePlayerId() {
  return `player-${crypto.randomBytes(4).toString("hex")}`;
}

function flushEvents() {
  const events = consumeEvents(state);
  for (const event of events) {
    broadcast(MESSAGE_TYPES.sEvent, event);
  }
}

function sendSnapshot(socket = null) {
  const payload = buildSnapshot(state);
  if (socket) send(socket, MESSAGE_TYPES.sSnapshot, payload);
  else broadcast(MESSAGE_TYPES.sSnapshot, payload);
}

function sendRoomState(socket = null) {
  const payload = buildRoomState(state);
  if (socket) send(socket, MESSAGE_TYPES.sRoomState, payload);
  else broadcast(MESSAGE_TYPES.sRoomState, payload);
}

function rejectHello(socket, reason) {
  send(socket, MESSAGE_TYPES.sEvent, {
    event: "error",
    atSec: Number(state.nowSec.toFixed(3)),
    payload: { reason },
  });
}

function handleHello(socket, payload) {
  const version = Number(payload?.clientVersion || 0);
  if (version !== PROTOCOL_VERSION) {
    rejectHello(socket, `Version incompatible. Client=${version}, serveur=${PROTOCOL_VERSION}.`);
    return;
  }

  let playerId = playerIdBySocket.get(socket);
  if (!playerId) {
    playerId = issuePlayerId();
    playerIdBySocket.set(socket, playerId);
  }

  const result = registerPlayer(state, {
    playerId,
    playerName: payload?.name || "",
    team: payload?.team || "red",
  });
  if (!result.ok) {
    rejectHello(socket, result.error || "Join refusé.");
    return;
  }

  socketsByPlayerId.set(playerId, socket);
  const player = result.player;

  const isHost = playerId === state.hostPlayerId;

  if (payload?.matchConfig && isHost) {
    const configureResult = configureRoom(state, payload.matchConfig, playerId);
    if (!configureResult.ok) {
      rejectHello(socket, configureResult.error || "Room config refusée.");
      return;
    }
  }

  send(socket, MESSAGE_TYPES.sWelcome, {
    playerId,
    tickRate: NETWORK_TICK_RATE,
    protocolVersion: PROTOCOL_VERSION,
    matchConfig: { ...state.matchConfig },
    limits: {
      nameMin: MATCH_LIMITS.nameMin,
      nameMax: MATCH_LIMITS.nameMax,
      botMin: MATCH_LIMITS.botMin,
      botMax: MATCH_LIMITS.botMax,
      durationMin: MATCH_LIMITS.durationMin,
      durationMax: MATCH_LIMITS.durationMax,
    },
    assignedSession: {
      playerName: player.name,
      team: player.team,
    },
  });

  if (payload?.requestStart && isHost) {
    const startResult = startMatch(state, payload?.matchConfig || null);
    if (!startResult.ok) rejectHello(socket, startResult.error || "Match impossible à démarrer.");
  }

  flushEvents();
  sendRoomState();
  sendSnapshot();
}

function handleInput(socket, payload) {
  const playerId = playerIdBySocket.get(socket);
  if (!playerId) return;
  applyPlayerInput(state, playerId, payload);
}

function handleRoomReady(socket, payload) {
  const playerId = playerIdBySocket.get(socket);
  if (!playerId) return;
  const result = setPlayerReady(state, playerId, !!payload?.ready);
  if (!result.ok) {
    rejectHello(socket, result.error || "Impossible de mettre le statut prêt.");
    return;
  }
  sendRoomState();
}

function handlePing(socket, payload) {
  const playerId = playerIdBySocket.get(socket);
  const sentAtMs = Number(payload?.sentAtMs || 0);
  const nowMs = Date.now();
  const rttMs = sentAtMs > 0 ? nowMs - sentAtMs : 0;
  if (playerId) markPlayerPing(state, playerId, rttMs);
  send(socket, MESSAGE_TYPES.sPong, {
    sentAtMs,
    serverNowMs: nowMs,
    rttMs,
  });
}

function handleSocketMessage(socket, raw) {
  const envelope = safeJsonParse(String(raw || ""));
  if (!envelope || typeof envelope.type !== "string") return;
  const { type, payload } = envelope;

  if (type === MESSAGE_TYPES.cHello) handleHello(socket, payload);
  else if (type === MESSAGE_TYPES.cRoomReady) handleRoomReady(socket, payload);
  else if (type === MESSAGE_TYPES.cInput) handleInput(socket, payload);
  else if (type === MESSAGE_TYPES.cPing) handlePing(socket, payload);
}

function handleSocketClose(socket) {
  const playerId = playerIdBySocket.get(socket);
  if (!playerId) return;
  playerIdBySocket.delete(socket);
  socketsByPlayerId.delete(playerId);
  removePlayer(state, playerId);
  flushEvents();
  sendRoomState();
  sendSnapshot();
}

wss.on("connection", (socket) => {
  socket.on("message", (raw) => handleSocketMessage(socket, raw));
  socket.on("close", () => handleSocketClose(socket));
  socket.on("error", () => handleSocketClose(socket));
});

const loop = setInterval(() => {
  tickServerState(state, 1 / NETWORK_TICK_RATE);
  flushEvents();
  sendRoomState();
  sendSnapshot();
}, TICK_MS);

function shutdown() {
  clearInterval(loop);
  for (const socket of wss.clients) {
    try {
      socket.close();
    } catch {
      // ignore close errors
    }
  }
  wss.close(() => {
    try {
      server.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
