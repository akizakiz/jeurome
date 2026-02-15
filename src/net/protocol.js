import { MATCH_MODES, MESSAGE_TYPES, PROTOCOL_VERSION } from "../network/protocol.js";

export function cmdJoinRoom({
  name = "",
  team = "red",
  matchConfig = null,
  requestStart = false,
} = {}) {
  const fallbackMatchConfig = {
    mode: MATCH_MODES.ctf,
    botCount: 0,
    durationSec: 240,
    ctfCapturesToWin: 3,
    dodgeballScoreTarget: 50,
    disabledSec: 10,
  };

  return {
    type: MESSAGE_TYPES.cHello,
    payload: {
      clientVersion: PROTOCOL_VERSION,
      name,
      team,
      matchConfig: matchConfig || fallbackMatchConfig,
      requestStart: !!requestStart,
    },
  };
}

export function cmdSetReady(isReady) {
  return {
    type: MESSAGE_TYPES.cRoomReady,
    payload: { ready: !!isReady },
  };
}

export function cmdInput(input) {
  return {
    type: MESSAGE_TYPES.cInput,
    payload: input,
  };
}
