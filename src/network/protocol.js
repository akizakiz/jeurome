export const PROTOCOL_VERSION = 2;

export const NETWORK_DEFAULT_URL = "ws://localhost:8787";
export const NETWORK_TICK_RATE = 20;
export const MAX_INPUT_DT_MS = 100;

export const MESSAGE_TYPES = {
  cHello: "c_hello",
  cRoomReady: "c_room_ready",
  sWelcome: "s_welcome",
  sRoomState: "s_room_state",
  cInput: "c_input",
  sSnapshot: "s_snapshot",
  sEvent: "s_event",
  cPing: "c_ping",
  sPong: "s_pong",
};

export const MATCH_LIMITS = {
  nameMin: 2,
  nameMax: 20,
  botMin: 0,
  botMax: 35,
  durationMin: 120,
  durationMax: 480,
  defaultBotCount: 0,
  defaultDurationSec: 240,
};

export const MATCH_MODES = {
  ctf: "ctf",
  dodgeball: "dodgeball",
};

export function normalizeMatchMode(mode) {
  return mode === MATCH_MODES.dodgeball ? MATCH_MODES.dodgeball : MATCH_MODES.ctf;
}

export function clampInt(raw, min, max, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeTeam(team) {
  return team === "blue" ? "blue" : "red";
}

export function sanitizePlayerName(raw) {
  const allowed = String(raw ?? "").replace(/[^\p{L}\p{N} _-]/gu, "");
  const collapsed = allowed.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MATCH_LIMITS.nameMax);
}

export function sanitizeMatchConfig(raw) {
  const mode = normalizeMatchMode(raw?.mode);
  const botCount = clampInt(
    raw?.botCount,
    MATCH_LIMITS.botMin,
    MATCH_LIMITS.botMax,
    MATCH_LIMITS.defaultBotCount,
  );
  const durationSec = clampInt(
    raw?.durationSec,
    MATCH_LIMITS.durationMin,
    MATCH_LIMITS.durationMax,
    MATCH_LIMITS.defaultDurationSec,
  );
  const ctfCapturesToWin = clampInt(raw?.ctfCapturesToWin, 1, 7, 3);
  const dodgeballScoreTarget = clampInt(raw?.dodgeballScoreTarget, 5, 200, 50);
  const disabledSec = clampInt(raw?.disabledSec, 5, 20, 10);

  return {
    mode,
    botCount,
    durationSec,
    ctfCapturesToWin,
    dodgeballScoreTarget,
    disabledSec,
  };
}
