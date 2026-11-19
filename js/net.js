// PeerJS로 방장 브라우저 ↔ 참가자 브라우저 직접 연결 (서버 없음)
/* global Peer */

const PREFIX = 'abyss-run-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode() {
  let s = '';
  for (let k = 0; k < 5; k++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

// 방장: 코드로 Peer를 열고 들어오는 연결을 받음
export function host(code, { onJoin, onData, onLeave }) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(PREFIX + code, { debug: 1 });
    const conns = new Map();
    peer.on('open', () => resolve({
      peer, code,
      send(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
      broadcast(msg) { for (const c of conns.values()) if (c.open) c.send(msg); },
      kick(id) { const c = conns.get(id); if (c) c.close(); },
      close() { peer.destroy(); },
    }));
    peer.on('connection', conn => {
      conn.on('open', () => { conns.set(conn.peer, conn); onJoin(conn.peer); });
      conn.on('data', d => onData(conn.peer, d));
      conn.on('close', () => { if (conns.delete(conn.peer)) onLeave(conn.peer); });
      conn.on('error', () => { if (conns.delete(conn.peer)) onLeave(conn.peer); });
    });
    peer.on('error', e => reject(e));
  });
}

// 참가자: 방장 Peer에 연결
export function join(code, { onData, onClose }) {
  return new Promise((resolve, reject) => {
    const peer = new Peer({ debug: 1 });
    let done = false;
    const fail = e => { if (!done) { done = true; reject(e); peer.destroy(); } };
    setTimeout(() => fail(new Error('timeout')), 12000);
    peer.on('open', id => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => {
        done = true;
        resolve({ peer, id, send(msg) { if (conn.open) conn.send(msg); }, close() { peer.destroy(); } });
      });
      conn.on('data', onData);
      conn.on('close', () => { if (done) onClose(); });
      conn.on('error', fail);
    });
    peer.on('error', e => {
      if (!done) fail(e.type === 'peer-unavailable' ? new Error('방을 찾을 수 없어요') : e);
      else onClose();
    });
  });
}
