import { GameWsClient } from "../net/wsClient.js";
import { NETWORK_DEFAULT_URL } from "../network/protocol.js";

export const NetworkState = {
  connected: false,
  roomState: null,
  lastServerTick: null,
  lastSnapshot: null,
  lastError: null,
  telemetry: null,
};

let telemetryTimer = null;

export function createNetworkState({
  searchParams = new URLSearchParams(window.location.search),
  hostname = window.location.hostname,
  defaultUrl = NETWORK_DEFAULT_URL,
} = {}) {
  const params =
    searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(String(searchParams || ""));
  const queryUrl = params.get("room") || params.get("ws");
  const autoUrl = String(import.meta.env.VITE_LS_ROOM_ID || defaultUrl || "module5-romeballon");
  const forceOffline = params.get("offline") === "1";
  const debug = params.get("debug") === "1";

  return {
    useOnlineMode: !forceOffline,
    debug,
    status: "offline", // offline | connecting | online
    serverUrl: queryUrl || autoUrl || defaultUrl,
    transport: null,
    playerId: null,
    inputSeq: 0,
    serverTick: 0,
    snapshotAgeMs: null,
    rttMs: null,
    lastNetworkError: "",
    startedViaNetwork: false,
    joinedRoom: false,
    isReady: false,
    liveNetworkState: NetworkState,
  };
}

export function initNetwork({
  url,
  debug = false,
  reconnect = true,
  onStatus = () => {},
  onWelcome = () => {},
  onRoomState = () => {},
  onSnapshot = () => {},
  onEvent = () => {},
} = {}) {
  NetworkState.connected = false;
  NetworkState.roomState = null;
  NetworkState.lastServerTick = null;
  NetworkState.lastSnapshot = null;
  NetworkState.lastError = null;
  NetworkState.telemetry = null;

  if (telemetryTimer) {
    window.clearInterval(telemetryTimer);
    telemetryTimer = null;
  }

  const wsClient = new GameWsClient({
    url,
    debug,
    reconnect,
    onStatus,
    onWelcome,
    onRoomState,
    onSnapshot,
    onEvent,
  });

  wsClient.on("open", () => {
    NetworkState.connected = true;
  });

  wsClient.on("close", (reason) => {
    NetworkState.connected = false;
    NetworkState.lastError = reason?.reason || reason?.code || "closed";
  });

  wsClient.on("error", (error) => {
    NetworkState.connected = false;
    NetworkState.lastError = error || "error";
  });

  wsClient.on("room_state", (payload) => {
    NetworkState.roomState = payload;
  });

  wsClient.on("snapshot", (payload) => {
    NetworkState.lastServerTick = payload?.serverTick ?? null;
    NetworkState.lastSnapshot = payload;
  });

  if (wsClient.debug) {
    telemetryTimer = window.setInterval(() => {
      NetworkState.telemetry = wsClient.getTelemetry();
    }, 5000);
  }

  wsClient.connect();
  return { wsClient, NetworkState };
}

export function setNetworkStatus(networkState, status) {
  networkState.status = status;
}

export function setSnapshotMetrics(networkState, transport, serverTick = networkState.serverTick) {
  networkState.serverTick = Number(serverTick || 0);
  networkState.snapshotAgeMs = transport?.getSnapshotAgeMs?.() ?? null;
  networkState.rttMs = transport?.rttMs ?? null;
}

export function setRoomFlags(networkState, { joinedRoom, isReady } = {}) {
  if (typeof joinedRoom === "boolean") networkState.joinedRoom = joinedRoom;
  if (typeof isReady === "boolean") networkState.isReady = isReady;
}
