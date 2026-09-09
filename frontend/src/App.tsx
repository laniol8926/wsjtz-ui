import { Fragment, useEffect, useState } from "react";
import { wsjtz, EMPTY_STATUS, type UiMessage, type WsjtzStatus } from "./ipc";

type Filter = "all" | "cq" | "tome";
const MAX_MESSAGES = 800;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<WsjtzStatus>(EMPTY_STATUS);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
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

  const visible = messages.filter((m) =>
    filter === "all" ? true : filter === "cq" ? m.is_cq : m.to_me
  );

  return (
    <>
      <TopBar connected={connected} status={status} utcNow={utcNow} />
      <div className="content decode">
        <DecodeScreen
          messages={visible}
          filter={filter}
          setFilter={setFilter}
          onAnswer={(m) => wsjtz.answer(m)}
        />
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

function DecodeScreen({
  messages,
  filter,
  setFilter,
  onAnswer,
}: {
  messages: UiMessage[];
  filter: Filter;
  setFilter: (f: Filter) => void;
  onAnswer: (m: UiMessage) => void;
}) {
  return (
    <>
      <div className="chips">
        {(["all", "cq", "tome"] as Filter[]).map((f) => (
          <div key={f} className={"chip" + (filter === f ? " active" : "")} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "cq" ? "CQ" : "To me"}
          </div>
        ))}
      </div>
      <div className="decode-list">
        <table>
          <thead>
            <tr>
              <th>UTC</th>
              <th>dB</th>
              <th>DT</th>
              <th>Hz</th>
              <th>Message</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m, i) => {
              const newBlock = i > 0 && messages[i - 1].utc_ms !== m.utc_ms;
              return (
                <Fragment key={i}>
                  {newBlock && (
                    <tr className="time-sep">
                      <td colSpan={6}>{new Date(m.utc_ms).toISOString().substring(11, 19)} UTC</td>
                    </tr>
                  )}
                  <tr
                    className={
                      (m.is_cq ? "cq " : "") +
                      (m.to_me ? "tome " : "") +
                      (m.is_cq || m.to_me ? "clickable" : "")
                    }
                    onClick={() => (m.is_cq || m.to_me) && onAnswer(m)}
                    title={
                      m.is_cq || m.to_me
                        ? "Click to answer (best-effort -- WSJT-Z doesn't always act on this, see project notes)"
                        : ""
                    }
                  >
                    <td>{new Date(m.utc_ms).toISOString().substring(11, 19)}</td>
                    <td>{m.snr}</td>
                    <td>{m.time_sec.toFixed(1)}</td>
                    <td>{Math.round(m.freq_hz)}</td>
                    <td>{m.text}</td>
                    <td>{m.is_cq || m.to_me ? "↩ answer" : ""}</td>
                  </tr>
                </Fragment>
              );
            })}
            {messages.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No decodes yet — make sure WSJT-Z is running and decoding, and that
                  ~/wsjtz-ui/backend/server.js is running.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
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
