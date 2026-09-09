import { Fragment, useEffect, useState } from "react";
import { wsjtz, EMPTY_STATUS, type UiMessage, type WsjtzStatus } from "./ipc";

const MAX_MESSAGES = 800;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<WsjtzStatus>(EMPTY_STATUS);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [utcNow, setUtcNow] = useState(new Date());

  useEffect(() => {
    const offConn = wsjtz.onConnection(setConnected);
    const offStatus = wsjtz.onStatus(setStatus);
    const offMsg = wsjtz.onMessage((m) => {
      setMessages((prev) => {
        // Safety net: drop an incoming message already present for the same
        // slot (same utc_ms + text), matching the original FT8AF UI's
        // duplicate guard.
        const seen = new Set(prev.map((p) => `${p.utc_ms}|${p.text}`));
        if (seen.has(`${m.utc_ms}|${m.text}`)) return prev;
        return [m, ...prev].slice(0, MAX_MESSAGES);
      });
    });
    return () => {
      offConn();
      offStatus();
      offMsg();
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setUtcNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <TopBar connected={connected} status={status} utcNow={utcNow} />
      <div className="content decode">
        <DecodeScreen messages={messages} status={status} />
      </div>
      <TxBar status={status} onStop={() => wsjtz.stopTx()} />
      <div className="status-line">
        {connected ? "" : "⚠ not connected to backend (ws://127.0.0.1:8791) — is server.js running?"}
      </div>
    </>
  );
}

function TopBar({
  connected,
  status,
  utcNow,
}: {
  connected: boolean;
  status: WsjtzStatus;
  utcNow: Date;
}) {
  const utc = utcNow.toISOString().substring(11, 19);
  return (
    <div className="topbar">
      <span className="brand">WSJT-Z UI</span>
      <span className="clock">{utc}</span>
      <div className="spacer" />
      <span className="muted" title="Dial frequency, as reported by WSJT-Z">
        {status.have_status ? `${(status.dial_hz / 1e6).toFixed(3)} MHz` : "—"}
      </span>
      <span className="muted">{status.mode || "—"}</span>
      <span className="muted" title="Rig, as configured in WSJT-Z">
        {status.configuration_name || "no rig info"}
      </span>
      <span className="muted" title="WSJT-Z's own decoder state">
        {status.have_status ? (status.decoding ? "decoding" : "not decoding") : "waiting for status…"}
      </span>
      <span
        className="muted"
        style={{ color: connected ? "var(--ok)" : "var(--tx)" }}
        title="Connection to the local wsjtz-ui backend server"
      >
        {connected ? "● backend connected" : "○ backend disconnected"}
      </span>
    </div>
  );
}

// Three simultaneous panels instead of one list behind a filter toggle --
// matching the Band Activity / CQ Panel / RX Frequency layout from the
// zbitxd project (see project_ai5ii_qmx_app memory) and WSJT-Z's own window
// (Band Activity + Rx Frequency side by side). A single "All" list behind a
// filter chip meant the chip's selection could silently persist and leave
// the whole screen looking empty/stale without it being obvious why.
function DecodeScreen({
  messages,
  status,
}: {
  messages: UiMessage[];
  status: WsjtzStatus;
}) {
  const cqMessages = messages.filter((m) => m.is_cq);
  const toMeMessages = messages.filter((m) => m.to_me);
  return (
    <div className="panels-row">
      <MessagePanel
        title="Band Activity"
        messages={messages}
        className="panel-band"
        emptyText="No decodes yet — make sure WSJT-Z is running and decoding, and that ~/wsjtz-ui/backend/server.js is running."
        liveTx={status.tx_message}
      />
      <MessagePanel
        title="CQ"
        messages={cqMessages}
        className="panel-col"
        emptyText="No CQs decoded yet."
      />
      <MessagePanel
        title="RX Frequency"
        messages={toMeMessages}
        className="panel-col"
        emptyText="Nothing directed at your callsign yet."
        liveTx={status.tx_message}
      />
    </div>
  );
}

function MessagePanel({
  title,
  messages,
  className,
  emptyText,
  liveTx,
}: {
  title: string;
  messages: UiMessage[];
  className: string;
  emptyText: string;
  /** Your own current outgoing message (WSJT-Z's Status.tx_message), shown
   *  pinned above the decoded list. WSJT-Z never broadcasts our own
   *  transmissions as a Decode message (Decode is receive-only), so without
   *  this the panel goes blank while calling CQ and waiting for a reply --
   *  matching a real zbitxd fix ("show our own outgoing CQ in RX Frequency
   *  itself while waiting", see project_ai5ii_qmx_app memory). Not a
   *  decode, so it has no real SNR/DT/Hz to show. */
  liveTx?: string;
}) {
  return (
    <div className={className}>
      <div className="panel-header">
        {title} <span className="muted">({messages.length})</span>
      </div>
      {liveTx && (
        <div className="panel-live-tx" title="Your current outgoing message -- not a received decode, WSJT-Z never broadcasts its own transmissions as one">
          → {liveTx}
        </div>
      )}
      <div className="decode-list">
        <table>
          <colgroup>
            <col style={{ width: "14%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "56%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>dB</th>
              <th>DT</th>
              <th>Hz</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m, i) => {
              // Every row in a block shares the same utc_ms (one FT8 cycle),
              // so the timestamp only needs to appear once per block -- a
              // per-row UTC column was redundant and crowded out Message
              // width (which cut off full callsigns/grids with an ellipsis).
              // i===0 always gets its own divider too, so the very first/
              // most-recent block is never shown without a visible timestamp.
              const newBlock = i === 0 || messages[i - 1].utc_ms !== m.utc_ms;
              return (
                <Fragment key={i}>
                  {newBlock && (
                    <tr className="time-sep">
                      <td colSpan={4}>{new Date(m.utc_ms).toISOString().substring(11, 19)} UTC</td>
                    </tr>
                  )}
                  <tr className={(m.is_cq ? "cq " : "") + (m.to_me ? "tome " : "")}>
                    <td>{m.snr}</td>
                    <td>{m.time_sec.toFixed(1)}</td>
                    <td>{Math.round(m.freq_hz)}</td>
                    <td>{m.text}</td>
                  </tr>
                </Fragment>
              );
            })}
            {messages.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Classifies WSJT-Z's currently-queued tx_message the same way decode rows
// are classified server-side (see the vendored parser's decode_exchange()) --
// this is the read-only equivalent of which Tx1..Tx6 button would be lit up
// in WSJT-Z's own window. There's no UDP field that says this directly, and
// no way to see the other five candidate messages (WSJT-Z computes all six
// from its own internal QSO state, only the active one is ever broadcast),
// so this is inferred from the message text itself, not a real protocol field.
function classifyTxStage(text: string): string {
  if (!text) return "";
  const parts = text.split(" ");
  if (parts[0] === "CQ") return "CQ";
  if (parts.length <= 2) return "";
  const w = parts[2];
  if (w === "73") return "73";
  if (w === "RR73" || w === "RRR") return "RR73";
  if (w.startsWith("+") || w.startsWith("-")) return "Report";
  if (w.startsWith("R")) return "R+Report";
  return "Grid";
}

function TxBar({ status, onStop }: { status: WsjtzStatus; onStop: () => void }) {
  const rxTxLabel = status.transmitting ? "transmitting" : status.decoding ? "listening" : "stopped";
  const txStage = classifyTxStage(status.tx_message);
  return (
    <div className="txbar">
      <span className={"badge " + (status.transmitting ? "tx" : "rx")}>
        {status.transmitting ? "TX" : "RX"}
      </span>
      <span className="muted">{rxTxLabel}</span>
      {status.dx_call && <span className="muted">→ {status.dx_call}</span>}
      {txStage && <span className="badge ok" title="Inferred from the message text -- WSJT-Z doesn't broadcast a stage number">{txStage}</span>}
      <span className="msg">{status.tx_message}</span>
      <div className="spacer" style={{ flex: 1 }} />
      <button className="danger" onClick={onStop} title="Sends WSJT-Z's HaltTx UDP command">
        Stop TX
      </button>
    </div>
  );
}
