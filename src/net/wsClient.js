import LatteStream from "@lattestream/client";
import { MESSAGE_TYPES, PROTOCOL_VERSION } from "../network/protocol.js";

const DEFAULT_PUBLIC_KEY =
  "lspk_Z2w6NDVjZDE3ZWItODdlZS00NjI0LTk0MWMtZDljNzMyODI1YjRkOjk2MWFmZTdkLWI2NTgtNGJlMC1hMGEyLWEzOTMyM2FiNTNmOQ";
const DEFAULT_WS_ENDPOINT = "eu1.lattestream.com";
const DEFAULT_ROOM_ID = "module5-romeballon3";
const PING_INTERVAL_MS = 2000;
const SNAPSHOT_LOG_THROTTLE_MS = 1000;
const ROOM_STATE_LOG_THROTTLE_MS = 2000;

function nowMs() {
  return Date.now();
}

function normalizeEndpoint(raw) {
  if (!raw) return DEFAULT_WS_ENDPOINT;
  const normalizeHost = (value) => {
    const host = String(value || "").toLowerCase();
    if (host === "ws.lattestream.com") return DEFAULT_WS_ENDPOINT;
    return host;
  };
  try {
    const url = new URL(String(raw));
    return normalizeHost(url.host || DEFAULT_WS_ENDPOINT);
  } catch {
    const cleaned = String(raw).replace(/^wss?:\/\//i, "").replace(/\/$/, "");
    return normalizeHost(cleaned || DEFAULT_WS_ENDPOINT);
  }
}

function normalizeRoomId(raw) {
  const value = String(raw || "").trim();
  if (!value) return DEFAULT_ROOM_ID;
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 64) || DEFAULT_ROOM_ID;
}

function normalizeBackendUrl(raw) {
  const fallback = "http://localhost:8787";
  const value = String(raw || "").trim() || fallback;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) && !/^https?:\/\//i.test(value)) {
    return `https://${value}`;
  }
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return fallback;
  }
}

function parseObject(data) {
  if (!data || typeof data !== "object") return null;
  return data;
}

export class GameWsClient {
  constructor({ url = DEFAULT_ROOM_ID, debug = false, reconnect = true, ...legacyCallbacks } = {}) {
    this.roomId = normalizeRoomId(url);
    this.debug = !!debug;
    this.reconnect = reconnect !== false;

    this.connected = false;
    this.manualDisconnect = false;
    this.lastServerTick = 0;
    this.lastRoomState = null;
    this.lastError = null;
    this.lastCloseReason = null;
    this.reconnectAttempt = 0;
    this.lastSnapshotAtMs = 0;

    this.handlers = new Map();
    this.telemetry = {
      typesSeen: new Set(),
      counts: Object.create(null),
      samples: Object.create(null),
      sentCounts: Object.create(null),
    };

    this.onStatus = legacyCallbacks.onStatus || (() => {});
    this.onWelcome = legacyCallbacks.onWelcome || (() => {});
    this.onRoomState = legacyCallbacks.onRoomState || (() => {});
    this.onSnapshot = legacyCallbacks.onSnapshot || (() => {});
    this.onEvent = legacyCallbacks.onEvent || (() => {});

    this.client = null;
    this.channel = null;
    this.channelName = `private-game-${this.roomId}`;

    this.sessionToken = "";
    this.playerId = null;
    this.pingTimer = null;

    this.lastSnapshotLogAt = 0;
    this.lastRoomStateLogAt = 0;

    this.joinInFlight = null;

    this.backendBaseUrl = normalizeBackendUrl(import.meta.env.VITE_BACKEND_URL || "");
  }

  connect() {
    if (this.client) return;

    this.manualDisconnect = false;
    this._emitStatus("connecting");

    const publicKey = String(import.meta.env.VITE_LS_PUBLIC_KEY || DEFAULT_PUBLIC_KEY).trim();
    const wsEndpoint = normalizeEndpoint(import.meta.env.VITE_LS_WS_ENDPOINT || DEFAULT_WS_ENDPOINT);

    if (!publicKey.startsWith("lspk_") && !publicKey.startsWith("lspc_")) {
      this.lastError = "Clé LatteStream invalide (VITE_LS_PUBLIC_KEY).";
      this._emit("error", this.lastError);
      this._emitStatus("offline");
      return;
    }

    this.client = new LatteStream(publicKey, {
      wsEndpoint,
      authEndpoint: `${this.backendBaseUrl}/v1/lattestream/auth`,
      forceTLS: true,
      enableLogging: this.debug,
      maxReconnectionAttempts: this.reconnect ? 20 : 0,
    });

    this.client.bind("connection_state_change", ({ current }) => {
      if (current === "connected") {
        this.connected = true;
        this._emit("open");
        this._emitStatus("online");
        this._ensureChannelSubscribed();
      } else if (current === "connecting") {
        this._emitStatus("connecting");
      } else if (current === "disconnected" || current === "failed" || current === "unavailable") {
        const wasConnected = this.connected;
        this.connected = false;
        this.lastCloseReason = { code: 1000, reason: String(current), wasClean: current === "disconnected" };
        this._stopPingLoop();
        if (wasConnected) this._emit("close", this.lastCloseReason);
        this._emitStatus("offline");
      }
    });

    this.client.bind("error", (error) => {
      this.lastError = this._formatError(error);
      this._emit("error", this.lastError);
    });

    this.client.connect();
  }

  disconnect() {
    this.manualDisconnect = true;
    this._stopPingLoop();

    if (this.sessionToken) {
      fetch(`${this.backendBaseUrl}/v1/session/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.sessionToken}` },
        keepalive: true,
      }).catch(() => {});
    }

    if (this.client) {
      try {
        if (this.channel) this.client.unsubscribe(this.channelName);
      } catch {
        // ignore
      }

      try {
        this.client.disconnect();
      } catch {
        // ignore
      }
    }

    this.client = null;
    this.channel = null;
    this.connected = false;
    this._emitStatus("offline");
  }

  send(type, payload = {}) {
    if (type === MESSAGE_TYPES.cHello) {
      return this.sendHello({
        name: payload?.name,
        team: payload?.team,
        matchConfig: payload?.matchConfig,
        requestStart: payload?.requestStart,
      });
    }

    if (!this.sessionToken) return false;
    this.telemetry.sentCounts[type] = (this.telemetry.sentCounts[type] || 0) + 1;

    this._postCommand(type, payload).catch((error) => {
      this.lastError = this._formatError(error);
      this._emit("error", this.lastError);
    });
    return true;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    const set = this.handlers.get(event);
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(event);
    };
  }

  getStatus() {
    return {
      connected: this.connected,
      url: this.roomId,
      lastServerTick: this.lastServerTick,
      lastRoomState: this.lastRoomState,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      lastCloseReason: this.lastCloseReason,
    };
  }

  getTelemetry() {
    return {
      typesSeen: Array.from(this.telemetry.typesSeen),
      counts: { ...this.telemetry.counts },
      samples: { ...this.telemetry.samples },
      sentCounts: { ...this.telemetry.sentCounts },
      roomId: this.roomId,
      playerId: this.playerId,
      backendBaseUrl: this.backendBaseUrl,
    };
  }

  getSnapshotAgeMs(currentNowMs = nowMs()) {
    if (!this.lastSnapshotAtMs) return null;
    return Math.max(0, currentNowMs - this.lastSnapshotAtMs);
  }

  sendHello({ name, team, matchConfig, requestStart = true }) {
    this.connect();

    if (this.joinInFlight) return true;

    this.joinInFlight = this._join({ name, team, matchConfig, requestStart })
      .catch((error) => {
        this.lastError = this._formatError(error);
        this._emit("error", this.lastError);
        this._emitStatus("offline");
      })
      .finally(() => {
        this.joinInFlight = null;
      });

    return true;
  }

  sendInput({ seq, dtMs, input }) {
    return this.send(MESSAGE_TYPES.cInput, { seq, dtMs, input });
  }

  sendRoomReady(ready) {
    return this.send(MESSAGE_TYPES.cRoomReady, { ready: !!ready });
  }

  async _join({ name, team, matchConfig, requestStart }) {
    const payload = {
      roomId: this.roomId,
      name,
      team,
      matchConfig,
      requestStart: !!requestStart,
    };

    const response = await fetch(`${this.backendBaseUrl}/v1/session/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Join échoué (${response.status}).`);
    }

    const data = await response.json();
    if (!data?.ok || !data?.sessionToken) throw new Error(data?.error || "Join refusé.");

    this.sessionToken = String(data.sessionToken);
    this.playerId = String(data.playerId || "") || null;

    this._ensureChannelSubscribed();
    this._startPingLoop();

    if (data.welcome) this._handleWelcome({ targetPlayerId: this.playerId, payload: data.welcome });
    if (data.roomState) this._handleRoomState(data.roomState);
    if (data.snapshot) this._handleSnapshot(data.snapshot);
  }

  _ensureChannelSubscribed() {
    if (!this.client || !this.sessionToken) return;
    if (this.channel) return;

    this.channel = this.client.subscribe(this.channelName, {
      headers: { Authorization: `Bearer ${this.sessionToken}` },
    });

    this.channel.bind("lattestream:subscription_succeeded", () => {
      this._emitStatus("online");
    });

    this.channel.bind("game:welcome", (payload) => this._handleWelcome(payload));
    this.channel.bind("game:room_state", (payload) => this._handleRoomState(payload));
    this.channel.bind("game:snapshot", (payload) => this._handleSnapshot(payload));
    this.channel.bind("game:event", (payload) => this._handleServerEvent(payload));
    this.channel.bind("game:pong", (payload) => this._handlePong(payload));
  }

  async _postCommand(type, payload) {
    const response = await fetch(`${this.backendBaseUrl}/v1/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({
        roomId: this.roomId,
        type,
        payload,
        sentAtMs: nowMs(),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Commande échouée (${response.status}).`);
    }
  }

  _startPingLoop() {
    this._stopPingLoop();
    this.pingTimer = window.setInterval(() => {
      if (!this.sessionToken) return;
      this._postCommand(MESSAGE_TYPES.cPing, { sentAtMs: nowMs() }).catch(() => {});
    }, PING_INTERVAL_MS);
  }

  _stopPingLoop() {
    if (!this.pingTimer) return;
    window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  _emit(event, payload) {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (error) {
        this.lastError = this._formatError(error);
      }
    }
  }

  _emitStatus(status) {
    this.onStatus(status);
    this._emit("status", status);
  }

  _track(type, payload) {
    this.telemetry.typesSeen.add(type);
    this.telemetry.counts[type] = (this.telemetry.counts[type] || 0) + 1;
    this.telemetry.samples[type] = payload;
  }

  _handleWelcome(rawPayload) {
    const wrap = parseObject(rawPayload);
    if (!wrap) return;
    if (wrap.targetPlayerId && this.playerId && String(wrap.targetPlayerId) !== this.playerId) return;

    const payload = parseObject(wrap.payload) || wrap;
    if (!this.playerId && payload.playerId) this.playerId = String(payload.playerId);
    this._track(MESSAGE_TYPES.sWelcome, payload);

    this.onWelcome(payload);
    this._emit("message", { type: MESSAGE_TYPES.sWelcome, payload });
  }

  _handleRoomState(rawPayload) {
    const payload = parseObject(rawPayload);
    if (!payload) return;

    this.lastRoomState = payload;
    this._track(MESSAGE_TYPES.sRoomState, payload);
    this._debugRoomState(payload);

    this._emit("room_state", payload);
    this.onRoomState(payload);
  }

  _handleSnapshot(rawPayload) {
    const payload = parseObject(rawPayload);
    if (!payload) return;

    this.lastServerTick = Number(payload?.serverTick || 0);
    this.lastSnapshotAtMs = nowMs();
    this._track(MESSAGE_TYPES.sSnapshot, payload);
    this._debugSnapshot(this.lastServerTick);

    this._emit("snapshot", payload);
    this.onSnapshot(payload);
  }

  _handleServerEvent(rawPayload) {
    const payload = parseObject(rawPayload);
    if (!payload) return;

    this._track(MESSAGE_TYPES.sEvent, payload);
    this.onEvent(payload);
    this._emit("message", { type: MESSAGE_TYPES.sEvent, payload });
  }

  _handlePong(rawPayload) {
    const wrap = parseObject(rawPayload);
    if (!wrap) return;
    if (wrap.targetPlayerId && this.playerId && String(wrap.targetPlayerId) !== this.playerId) return;

    const payload = parseObject(wrap.payload) || {};
    this._track(MESSAGE_TYPES.sPong, payload);
    this._emit("message", { type: MESSAGE_TYPES.sPong, payload });
  }

  _formatError(error) {
    if (typeof error === "string") return error;
    if (error instanceof Error && error.message) return error.message;
    return String(error ?? "Unknown error");
  }

  _debugSnapshot(serverTick) {
    if (!this.debug) return;
    const now = nowMs();
    if (now - this.lastSnapshotLogAt < SNAPSHOT_LOG_THROTTLE_MS) return;
    this.lastSnapshotLogAt = now;
    console.log("[latte-relay] snapshot tick", serverTick);
  }

  _debugRoomState(payload) {
    if (!this.debug) return;
    const now = nowMs();
    if (now - this.lastRoomStateLogAt < ROOM_STATE_LOG_THROTTLE_MS) return;
    this.lastRoomStateLogAt = now;
    console.log(
      "[latte-relay] room_state",
      payload?.phase,
      payload?.totalPlayers,
      payload?.readyCount,
      payload?.hostPlayerId,
    );
  }
}
