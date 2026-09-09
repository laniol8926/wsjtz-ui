// Bridges the UI to ~/wsjtz-ui/backend/server.js over WebSocket, instead of
// Tauri's invoke/listen (FT8AF's original transport -- see the FT8AF
// project's src/ipc.ts for the Tauri-based version this replaces).
//
// This app is a companion/monitor for WSJT-Z, not a full replacement control
// surface: WSJT-Z's UDP protocol only exposes a subset of what FT8AF's own
// engine controlled directly (no rig/audio/band/waterfall config -- those
// are WSJT-Z's own settings, not exposed to a companion app). Scope is
// intentionally the decode/QSO view only.

export interface UiMessage {
  utc_ms: number;
  call_to: string;
  call_from: string;
  grid: string;
  snr: number;
  freq_hz: number;
  time_sec: number;
  text: string;
  is_cq: boolean;
  to_me: boolean;
  /** Exact fields needed to build a `Reply` back to WSJT-Z for this decode.
   *  Carried verbatim from the wire so replying doesn't require
   *  re-deriving them (and can't drift from what WSJT-Z actually sent). */
  raw: {
    time: number;
    snr: number;
    delta_time: number;
    delta_frequency: number;
    mode: string;
    message: string;
    low_confidence: number;
  };
}

export interface WsjtzStatus {
  /** True once WSJT-Z's own Status broadcast has been seen at least once. */
  have_status: boolean;
  dial_hz: number;
  mode: string;
  dx_call: string;
  dx_grid: string;
  de_call: string;
  de_grid: string;
  report: number | null;
  tx_enabled: boolean;
  transmitting: boolean;
  decoding: boolean;
  tx_watchdog: boolean;
  tx_message: string;
  configuration_name: string;
}

const EMPTY_STATUS: WsjtzStatus = {
  have_status: false,
  dial_hz: 0,
  mode: "",
  dx_call: "",
  dx_grid: "",
  de_call: "",
  de_grid: "",
  report: null,
  tx_enabled: false,
  transmitting: false,
  decoding: false,
  tx_watchdog: false,
  tx_message: "",
  configuration_name: "",
};

function utcMsFromWsjtzTime(msSinceMidnight: number): number {
  const now = new Date();
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return midnightUtc + msSinceMidnight;
}

// Classify a decode's message_decode (produced server-side by the vendored
// wsjt-x-parser's decode_exchange()) into the to/from/grid/is_cq shape the
// UI wants. message_decode can be absent for a decode the parser couldn't
// classify (e.g. a free-text or unusual message) -- treat as unaddressed.
function classify(messageDecode: any): { call_to: string; call_from: string; grid: string; is_cq: boolean } {
  if (!messageDecode) return { call_to: "", call_from: "", grid: "", is_cq: false };
  const isCq = messageDecode.type === "cq";
  return {
    call_to: isCq ? "" : messageDecode.dx_call || "",
    call_from: messageDecode.de_call || "",
    grid: messageDecode.de_grid || "",
    is_cq: isCq,
  };
}

function toUiMessage(msg: any, myCall: string): UiMessage {
  const { call_to, call_from, grid, is_cq } = classify(msg.message_decode);
  return {
    utc_ms: utcMsFromWsjtzTime(msg.time),
    call_to,
    call_from,
    grid,
    snr: msg.snr,
    freq_hz: msg.delta_frequency,
    time_sec: msg.delta_time,
    text: msg.message,
    is_cq,
    to_me: !!myCall && call_to === myCall,
    raw: {
      time: msg.time,
      snr: msg.snr,
      delta_time: msg.delta_time,
      delta_frequency: msg.delta_frequency,
      mode: msg.mode,
      message: msg.message,
      low_confidence: msg.low_confidence,
    },
  };
}

function toStatus(msg: any): WsjtzStatus {
  return {
    have_status: true,
    dial_hz: msg.frequency,
    mode: msg.mode,
    dx_call: msg.dx_call,
    dx_grid: msg.dx_grid,
    de_call: msg.de_call,
    de_grid: msg.de_grid,
    report: msg.report,
    tx_enabled: !!msg.tx_enabled,
    transmitting: !!msg.transmitting,
    decoding: !!msg.decoding,
    tx_watchdog: !!msg.tx_watchdog,
    tx_message: msg.tx_message || "",
    configuration_name: msg.configuration_name || "",
  };
}

type MessageListener = (m: UiMessage) => void;
type StatusListener = (s: WsjtzStatus) => void;
type ConnectionListener = (connected: boolean) => void;

const WS_URL = "ws://127.0.0.1:8791";
const RECONNECT_DELAY_MS = 2000;

class WsjtzClient {
  private ws: WebSocket | null = null;
  private myCall = "";
  private connected = false;
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();
  private connectionListeners = new Set<ConnectionListener>();

  constructor() {
    this.connect();
  }

  private setConnected(v: boolean) {
    this.connected = v;
    this.connectionListeners.forEach((cb) => cb(v));
  }

  private connect() {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => this.setConnected(true);
    ws.onmessage = (ev) => this.handleRaw(ev.data);
    ws.onclose = () => {
      this.setConnected(false);
      // The backend server or WSJT-Z might restart independently of this
      // page -- keep retrying rather than leaving the UI dead.
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    };
    ws.onerror = () => {
      // onclose fires right after; nothing extra to do here.
    };
  }

  private handleRaw(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.source !== "wsjtz") return; // ignore our own command acks/errors here

    if (msg.type === "status") {
      if (msg.de_call) this.myCall = msg.de_call;
      const status = toStatus(msg);
      this.statusListeners.forEach((cb) => cb(status));
    } else if (msg.type === "decode") {
      const ui = toUiMessage(msg, this.myCall);
      this.messageListeners.forEach((cb) => cb(ui));
    }
  }

  onMessage(cb: MessageListener): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onConnection(cb: ConnectionListener): () => void {
    this.connectionListeners.add(cb);
    // `wsjtz` is a module-level singleton that starts connecting the moment
    // this module loads, before any React component's useEffect has a
    // chance to subscribe -- so the one-shot `onopen` transition can fire
    // (and be lost) before a listener exists. Deliver the current state
    // immediately on subscribe so a late subscriber isn't stuck showing
    // "disconnected" forever despite data actually flowing.
    cb(this.connected);
    return () => this.connectionListeners.delete(cb);
  }

  private send(cmd: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  /** Best-effort: WSJT-Z's own exact-text match against its Band Activity
   *  window doesn't always succeed for reasons not fully root-caused (see
   *  the project_wsjtz_udp_ui memory) -- this may silently do nothing. */
  answer(m: UiMessage) {
    this.send({ cmd: "reply", decode: m.raw });
  }

  stopTx(autoTxOnly = false) {
    this.send({ cmd: "haltTx", autoTxOnly });
  }

  freeText(text: string, alsoSend: boolean) {
    this.send({ cmd: "freeText", text, send: alsoSend });
  }
}

export const wsjtz = new WsjtzClient();
export { EMPTY_STATUS };
