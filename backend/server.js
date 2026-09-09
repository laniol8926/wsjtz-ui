// Real WebSocket server bridging a browser/React frontend to WSJT-Z's UDP
// protocol. Read side (Heartbeat/Status/Decode/QSOLogged) is proven
// reliable. Write side (Reply/HaltTx/FreeText) is sent best-effort: WSJT-Z's
// own exact-text match against its Band Activity window still silently
// fails for a `Reply` for reasons not fully root-caused (see the
// project_wsjtz_udp_ui memory) -- callers should treat a "sent" ack as
// "the datagram left this process," not "WSJT-Z acted on it."
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const wsjtx = require('./vendor/wsjt-x-parser');

const UDP_PORT = 2237;
const WS_PORT = 8791;

// -- UDP: receive WSJT-Z's broadcasts --
// reusePort is required (Node 22+): WSJT-Z shares this port via
// SO_REUSEPORT with its own jt9 decoder subprocess and, on this machine,
// CQRLOG. Without it, bind() fails outright with EADDRINUSE (confirmed
// 2026-09-08).
const udpIn = dgram.createSocket({ type: 'udp4', reuseAddr: true, reusePort: true });

// -- UDP: send commands back to WSJT-Z --
// Sent over IPv6 loopback, NOT the IPv4 address WSJT-Z's own UDPServer
// setting names. WSJT-Z's IPv4 socket on this port is shared via
// SO_REUSEPORT (see above), and Linux's per-flow hash can route an outbound
// send from us to jt9's or CQRLOG's copy of that socket instead of WSJT-Z's
// own -- confirmed via strace 2026-09-08 (a Reply landed on CQRLOG, not
// WSJT-Z). WSJT-Z separately holds an *exclusive* IPv6 wildcard socket on
// the same port number, not shared with anything, so IPv6 loopback reliably
// reaches WSJT-Z's own process instead (also confirmed via strace).
const udpOut = dgram.createSocket('udp6');

const wss = new WebSocketServer({ port: WS_PORT });

// Last-known snapshot so a newly-connecting frontend isn't blank.
let lastStatus = null;
const recentDecodes = []; // ring buffer, newest last
const MAX_RECENT_DECODES = 200;

function toJSONSafe(obj) {
  // binary-parser returns uint64 fields (Status.frequency,
  // QSOLogged.tx_frequency) as BigInt, which JSON.stringify can't handle
  // natively. Radio frequencies in Hz are always far under
  // Number.MAX_SAFE_INTEGER, so a plain Number is safe here.
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
}

function broadcast(msg) {
  const payload = toJSONSafe(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

udpIn.on('message', (buf) => {
  let msg;
  try {
    msg = wsjtx.decode(buf);
  } catch (e) {
    console.error('[udp] decode failed:', e.message);
    return;
  }

  if (msg.type === 'status') {
    lastStatus = msg;
  } else if (msg.type === 'decode') {
    recentDecodes.push(msg);
    if (recentDecodes.length > MAX_RECENT_DECODES) recentDecodes.shift();
  }

  broadcast({ source: 'wsjtz', ...msg });
});

udpIn.on('error', (err) => {
  console.error('[udp] socket error:', err);
});

udpIn.bind({ port: UDP_PORT, address: '0.0.0.0' }, () => {
  console.log(`[udp] listening for WSJT-Z broadcasts on 0.0.0.0:${UDP_PORT}`);
});

udpOut.on('error', (err) => {
  console.error('[udp-out] socket error:', err);
});

// WSJT-Z sometimes bakes a "worked before" annotation directly into a
// Decode message's `message` field before broadcasting it -- its own
// clean_string() strips this for internal matching (appendWorkedB4() is a
// real, intentional feature backing the "New stations only" display
// filter), but the raw outbound broadcast doesn't. e.g. observed live:
// "CQ KB6SSN CM98                        a1". Real FT8 text never contains
// a run of 2+ spaces, so splitting on that is a safe heuristic. Confirmed
// necessary 2026-09-08.
function coreMessage(rawMessage) {
  return String(rawMessage || '').split(/ {2,}/)[0];
}

function sendToWsjtz(msg) {
  let encoded;
  try {
    encoded = wsjtx.encode(msg);
  } catch (e) {
    console.error('[udp-out] encode failed:', e.message);
    return false;
  }
  if (typeof encoded === 'string') {
    console.error('[udp-out] encode returned an error string:', encoded);
    return false;
  }
  udpOut.send(encoded, UDP_PORT, '::1', (err) => {
    if (err) console.error('[udp-out] send failed:', err);
  });
  return true;
}

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  // Snapshot so this client isn't blank until the next broadcast arrives.
  if (lastStatus) ws.send(toJSONSafe({ source: 'wsjtz', ...lastStatus }));
  for (const d of recentDecodes) ws.send(toJSONSafe({ source: 'wsjtz', ...d }));

  ws.on('message', (data) => {
    let cmd;
    try {
      cmd = JSON.parse(data);
      console.log('[ws] received command:', JSON.stringify(cmd));
    } catch (e) {
      ws.send(toJSONSafe({ source: 'server', error: 'invalid JSON' }));
      return;
    }

    switch (cmd.cmd) {
      case 'reply': {
        // Best-effort -- see the module doc comment at the top of this file.
        const d = cmd.decode || {};
        const ok = sendToWsjtz({
          type: 'reply',
          id: 'WSJT-X',
          time: d.time,
          snr: d.snr,
          delta_time: d.delta_time,
          delta_frequency: d.delta_frequency,
          mode: d.mode,
          message: coreMessage(d.message),
          low_confidence: d.low_confidence || 0,
          modifiers: cmd.modifiers || 0,
        });
        ws.send(toJSONSafe({ source: 'server', ack: 'reply', sent: ok }));
        break;
      }
      case 'haltTx': {
        const ok = sendToWsjtz({ type: 'halt_tx', id: 'WSJT-X', auto_tx_only: !!cmd.autoTxOnly });
        ws.send(toJSONSafe({ source: 'server', ack: 'haltTx', sent: ok }));
        break;
      }
      case 'freeText': {
        const ok = sendToWsjtz({ type: 'free_text', id: 'WSJT-X', text: cmd.text || '', send: !!cmd.send });
        ws.send(toJSONSafe({ source: 'server', ack: 'freeText', sent: ok }));
        break;
      }
      default:
        ws.send(toJSONSafe({ source: 'server', error: `unknown cmd: ${cmd.cmd}` }));
    }
  });

  ws.on('close', () => console.log('[ws] client disconnected'));
});

console.log(`[ws] server listening on ws://127.0.0.1:${WS_PORT}`);
