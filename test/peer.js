import {EventEmitter} from 'node:events';
import WebSocket from 'ws';

export async function peer(url, first) {
  const ws = new WebSocket(url);
  const changed = new EventEmitter();
  const packets = [];
  let current;
  let token;
  let req = 0;
  ws.on('error', error => changed.emit('failure', error));
  ws.on('close', () => changed.emit('failure', new Error('socket closed')));
  ws.on('message', raw => {
    const packet = JSON.parse(raw);
    packets.push(packet);
    if (packet.type === 'admit') token = packet.token ?? token;
    if (packet.type === 'snapshot') current = packet.data;
    if (packet.type === 'patch') {
      const {tableDelta, ...patch} = packet.data;
      current = {...current, ...patch};
      if (tableDelta) current.table = {...current.table, ...tableDelta};
    }
    changed.emit('packet', packet);
  });
  function until(predicate, timeout = 5000) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        changed.off('packet', update);
        changed.off('failure', fail);
      };
      const fail = error => { clear(); reject(error); };
      const update = () => {
        if (predicate()) { clear(); resolve(); }
      };
      const timer = setTimeout(() => fail(new Error('timed out waiting for peer message')), timeout);
      changed.on('packet', update);
      changed.on('failure', fail);
    });
  }
  function send(message) {
    ws.send(JSON.stringify({...message, req: ++req}));
    return req;
  }
  async function command(message) {
    const id = send(message);
    await until(() => packets.some(packet => packet.req === id && ['ok', 'error'].includes(packet.type)));
    return packets.find(packet => packet.req === id);
  }
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  if (first) {
    send(first);
    await until(() => current || packets.some(p => ['error', 'expired'].includes(p.type)));
  }
  return {ws, packets, until, send, command, get snapshot() { return current; }, get token() { return token; },
    close: () => ws.terminate()};
}
