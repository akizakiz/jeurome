import { MESSAGE_TYPES, NETWORK_DEFAULT_URL, PROTOCOL_VERSION } from "./protocol.js";

export class GameClientTransport {
  constructor({
    url = NETWORK_DEFAULT_URL,
    onStatus = () => {},
    onWelcome = () => {},
    onRoomState = () => {},
    onSnapshot = () => {},
    onEvent = () => {},
  } = {}) {
    this.url = url;
    this.onStatus = onStatus;
    this.onWelcome = onWelcome;
    this.onRoomState = onRoomState;
    this.onSnapshot = onSnapshot;
    this.onEvent = onEvent;

    this.socket = null;
    this.connected = false;
    this.pingTimer = null;
    this.lastSnapshotAtMs = 0;
    this.lastServerTick = 0;
    this.rttMs = null;
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this._emitStatus("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.connected = true;
      this._emitStatus("online");
      this._startPingLoop();
    });

    socket.addEventListener("close", () => {
      this.connected = false;
      this._stopPingLoop();
      this._emitStatus("offline");
    });

    socket.addEventListener("error", () => {
      this._emitStatus("offline");
    });

    socket.addEventListener("message", (event) => {
      const envelope = this._safeParse(event.data);
      if (!envelope || typeof envelope.type !== "string") return;
      const { type, payload } = envelope;

      if (type === MESSAGE_TYPES.sWelcome) {
        this.onWelcome(payload || {});
      } else if (type === MESSAGE_TYPES.sRoomState) {
        this.onRoomState(payload || {});
      } else if (type === MESSAGE_TYPES.sSnapshot) {
        this.lastSnapshotAtMs = Date.now();
        this.lastServerTick = Number(payload?.serverTick || 0);
        this.onSnapshot(payload || {});
      } else if (type === MESSAGE_TYPES.sEvent) {
        this.onEvent(payload || {});
      } else if (type === MESSAGE_TYPES.sPong) {
        this.rttMs = Number(payload?.rttMs || 0);
      }
    });
  }

  disconnect() {
    this._stopPingLoop();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore close errors
      }
    }
    this.socket = null;
    this.connected = false;
    this._emitStatus("offline");
  }

  sendHello({ name, team, matchConfig, requestStart = true }) {
    this.send(MESSAGE_TYPES.cHello, {
      clientVersion: PROTOCOL_VERSION,
      name,
      team,
      matchConfig,
      requestStart,
    });
  }

  sendInput({ seq, dtMs, input }) {
    this.send(MESSAGE_TYPES.cInput, { seq, dtMs, input });
  }

  sendRoomReady(ready) {
    this.send(MESSAGE_TYPES.cRoomReady, { ready: !!ready });
  }

  send(type, payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type, payload }));
    return true;
  }

  getSnapshotAgeMs(nowMs = Date.now()) {
    if (!this.lastSnapshotAtMs) return null;
    return Math.max(0, nowMs - this.lastSnapshotAtMs);
  }

  _safeParse(raw) {
    try {
      return JSON.parse(String(raw || ""));
    } catch {
      return null;
    }
  }

  _emitStatus(status) {
    this.onStatus(status);
  }

  _startPingLoop() {
    this._stopPingLoop();
    this.pingTimer = window.setInterval(() => {
      this.send(MESSAGE_TYPES.cPing, { sentAtMs: Date.now() });
    }, 2000);
  }

  _stopPingLoop() {
    if (!this.pingTimer) return;
    window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
