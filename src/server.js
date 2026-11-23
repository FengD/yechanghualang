import {createServer} from 'node:http';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {brotliCompressSync, gzipSync} from 'node:zlib';
import {WebSocket, WebSocketServer} from 'ws';
import {RuleError, actInGame, advanceGame, check, gameDeadline, gameView, setGamePaused, settingsFrom, startGame} from './game.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CAPACITY = 10;
const SPECTATOR_GRACE = 120_000;
const secret = () => randomBytes(24).toString('base64url');
const newId = () => randomBytes(8).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token);

function matches(given, expected) {
  return typeof given === 'string' && given.length <= 256 &&
    timingSafeEqual(Buffer.from(digest(given)), Buffer.from(digest(expected)));
}

function cleanLabel(input, max, message) {
  const value = typeof input === 'string' ? input.trim().normalize() : '';
  check(value && [...value].length <= max && !/[\p{Cc}\p{Cf}]/u.test(value), message);
  return value;
}

const MIME = {html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', webp: 'image/webp', txt: 'text/plain; charset=utf-8'};

function loadAssets() {
  const assets = new Map();
  const web = resolve(ROOT, 'public');
  for (const file of [...readdirSync(web), ...readdirSync(resolve(web, 'art')).map(file => 'art/' + file)]) {
    const ext = file.split('.').at(-1);
    if (!MIME[ext]) continue;
    const data = readFileSync(resolve(web, file));
    const compressed = ext !== 'webp' && data.length > 256
      ? {br: brotliCompressSync(data), gzip: gzipSync(data)} : {};
    const cache = ext === 'webp' ? 'public, max-age=31536000, immutable' : 'no-cache';
    const etags = Object.fromEntries(Object.entries({identity: data, ...compressed})
      .map(([name, bytes]) => [name, '"' + digest(bytes).slice(0, 24) + '"']));
    assets.set('/' + file, {data, type: MIME[ext], cache, compressed, etags});
  }
  assets.set('/', assets.get('/index.html'));
  return assets;
}

function chooseEncoding(accept, available) {
  const encodings = new Map((accept ?? '').split(',').map(entry => {
    const [name, ...params] = entry.trim().split(';');
    const weight = params.find(param => param.trim().startsWith('q='));
    return [name, weight ? Number(weight.trim().slice(2)) : 1];
  }));
  return ['br', 'gzip'].filter(name => available[name] && (encodings.get(name) ?? encodings.get('*') ?? 0) > 0)
    .sort((a, b) => (encodings.get(b) ?? encodings.get('*')) - (encodings.get(a) ?? encodings.get('*')))[0];
}

export async function startServer({
  port = Number(process.env.PORT ?? 8080), host = '0.0.0.0',
  directory = process.env.DATA_DIR ?? resolve(ROOT, 'data'),
  createKey = process.env.ROOM_CREATE_KEY || '',
  publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : '',
  logger = console
} = {}) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const stateFile = resolve(directory, 'room.json');
  const assets = loadAssets();
  let room = null;
  try {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (saved.version !== 1) throw new Error('无法读取此版本的房间数据。');
    room = saved.room;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  function save(next) {
    const swap = stateFile + '.tmp';
    writeFileSync(swap, JSON.stringify({version: 1, room: next}), {mode: 0o600, flush: true});
    renameSync(swap, stateFile);
    room = next;
  }

  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  };
  const server = createServer((req, res) => {
    const pathname = req.url?.split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {...headers, Allow: 'GET, HEAD'}).end();
      return;
    }
    if (pathname === '/healthz' || pathname === '/status') {
      const body = pathname === '/status' ? {exists: Boolean(room), createKey: Boolean(createKey)} : {ok: true};
      res.writeHead(200, {...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) {
      res.writeHead(404, headers).end();
      return;
    }
    const encoding = chooseEncoding(req.headers['accept-encoding'], asset.compressed);
    const data = asset.compressed[encoding] ?? asset.data;
    const etag = asset.etags[encoding ?? 'identity'];
    const responseHeaders = {...headers, 'Content-Type': asset.type, 'Cache-Control': asset.cache,
      'ETag': etag, Vary: 'Accept-Encoding', ...(encoding ? {'Content-Encoding': encoding} : {})};
    if ((req.headers['if-none-match'] ?? '').split(/\s*,\s*/).some(tag => tag === etag || tag === '*')) {
      res.writeHead(304, responseHeaders).end();
      return;
    }
    res.writeHead(200, {...responseHeaders, 'Content-Length': data.length});
    res.end(req.method === 'HEAD' ? undefined : data);
  });

  const sockets = new WebSocketServer({
    noServer: true, maxPayload: 2048,
    perMessageDeflate: {threshold: 500, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: {level: 3}}
  });
  const online = new Map();
  const seen = new Map((room?.people ?? []).map(person => [person.id, Date.now()]));
  let broadcastTimer;
  let phaseTimer;

  function send(socket, data) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 64 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(typeof data === 'string' ? data : JSON.stringify(data));
  }

  function personFor(socket) {
    return room?.people.find(person => person.id === socket.person);
  }

  function synchronize(socket, initial = false) {
    const person = personFor(socket);
    if (!person) return;
    const keys = {
      room: {title: room.title, host: room.host, rules: room.rules, epoch: room.epoch},
      people: room.people.map(({id, name, role}) => ({id, name, role, online: online.has(id)})),
      self: {id: person.id, invite: room.host === person.id ? room.invite : null},
      ...gameView(room.game, room.rules, person.id)
    };
    const changed = {};
    for (const [key, value] of Object.entries(keys)) {
      const json = JSON.stringify(value);
      if (initial || socket.projection[key] !== json) {
        const previous = socket.projectedTable;
        if (key === 'table' && !initial && value && previous && socket.epoch === room.epoch &&
            value.lot === previous.lot && value.phase === previous.phase) {
          changed.tableDelta = Object.fromEntries(Object.entries(value)
            .filter(([field, next]) => JSON.stringify(previous[field]) !== JSON.stringify(next)));
        } else {
          changed[key] = value;
        }
      }
      socket.projection[key] = json;
    }
    socket.projectedTable = keys.table;
    socket.epoch = room.epoch;
    if (initial || Object.keys(changed).length) {
      send(socket, {type: initial ? 'snapshot' : 'patch', seq: ++socket.seq, now: Date.now(), data: changed});
    }
  }

  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      for (const socket of online.values()) synchronize(socket);
    }, 32);
  }

  function phaseSchedule(delay) {
    clearTimeout(phaseTimer);
    const until = gameDeadline(room?.game);
    if (!until) return;
    phaseTimer = setTimeout(() => {
      try {
        processDeadline();
      } catch (error) {
        logger.error(error);
        phaseSchedule(2000);
      }
    }, delay ?? Math.max(5, until - Date.now()));
  }

  function commit(next) {
    save(next);
    phaseSchedule();
    broadcast();
  }

  function processDeadline() {
    const now = Date.now();
    const until = gameDeadline(room?.game);
    if (!until) return;
    if (until > now) {
      phaseSchedule();
      return;
    }
    const next = structuredClone(room);
    if (advanceGame(next.game, next.rules, now)) commit(next);
  }

  function tokenPerson(token) {
    if (!validToken(token)) return null;
    const sha = digest(token);
    return room?.people.find(person => person.token === sha);
  }

  function attach(socket, person, token) {
    processDeadline();
    const old = online.get(person.id);
    online.set(person.id, socket);
    if (old && old !== socket) {
      send(old, {type: 'replaced'});
      old.close(4001, 'replaced');
    }
    socket.person = person.id;
    seen.set(person.id, Date.now());
    clearTimeout(socket.joinTimeout);
    send(socket, {type: 'admit', ...(token ? {token} : {})});
    synchronize(socket, true);
    broadcast();
  }

  function pruneSpectators(next) {
    const now = Date.now();
    next.people = next.people.filter(person =>
      person.role !== 'watch' || next.host === person.id || online.has(person.id) ||
      now - (seen.get(person.id) ?? now) < SPECTATOR_GRACE);
  }

  function newPerson(name, role, token = secret()) {
    return {token, person: {name, role, id: newId(), token: digest(token)}};
  }

  function seatsAvailable(next) {
    return next.people.filter(person => person.role === 'play').length < next.rules.seats;
  }

  function join(socket, message) {
    check(!socket.person, '你已经加入房间。');
    if (message.type === 'resume') {
      const person = tokenPerson(message.token);
      if (!person) {
        send(socket, {type: 'expired'});
        socket.close(4004, 'expired');
        return;
      }
      attach(socket, person);
      return;
    }

    if (message.claim !== undefined) {
      check(validToken(message.claim), '入场凭据格式有误。');
      const existing = tokenPerson(message.claim);
      if (existing) {
        attach(socket, existing, message.claim);
        return;
      }
    }
    const name = cleanLabel(message.name, 16, '请输入 1 至 16 个字符的昵称。');
    if (message.type === 'create') {
      check(!room, '此服务器已有一个房间。');
      check(!createKey || matches(message.key, createKey), '建房密钥有误。');
      const title = cleanLabel(message.title, 26, '请输入 1 至 26 个字符的房间名。');
      const rules = settingsFrom(message.rules);
      const {person, token} = newPerson(name, 'play', message.claim);
      commit({title, rules, invite: secret(), host: person.id, people: [person], game: null, epoch: null});
      attach(socket, person, token);
      return;
    }

    check(room && matches(message.invite, room.invite), '邀请无效，请向房主索取邀请链接。');
    const next = structuredClone(room);
    pruneSpectators(next);
    check(next.people.length < CAPACITY, '房间已达到 10 人上限。');
    const role = message.role;
    check(role === 'play' || role === 'watch', '请选择参赛或观战。');
    if (role === 'play') {
      check(!next.game, '本局已开始。你可以观战，或等房主返回大厅。');
      check(seatsAvailable(next), '参赛席位已满。');
    } else {
      check(next.rules.spectators, '房主已关闭观战。');
    }
    check(!next.people.some(person => person.name === name), '这个昵称已被使用。');
    const {person, token} = newPerson(name, role, message.claim);
    next.people.push(person);
    commit(next);
    for (const id of seen.keys()) {
      if (!next.people.some(member => member.id === id)) seen.delete(id);
    }
    attach(socket, person, token);
  }

  function eject(person, type) {
    const socket = online.get(person.id);
    if (socket) {
      online.delete(person.id);
      send(socket, {type});
      socket.close(4004, type);
    }
    seen.delete(person.id);
  }

  function action(socket, message) {
    const person = personFor(socket);
    check(person && online.get(person.id) === socket, '请先加入房间。');
    processDeadline();
    if (message.type === 'sync') {
      synchronize(socket, true);
      return;
    }
    const next = structuredClone(room);
    const isHost = next.host === person.id;
    let removed;
    const {type} = message;
    switch (type) {
      case 'nominate':
      case 'pass':
      case 'bid':
        check(message.epoch && message.epoch === next.epoch, '该操作属于另一局游戏。');
        actInGame(next.game, next.rules, person.id, message);
        break;
      case 'pause':
      case 'continue':
        check(isHost, '只有房主能暂停或继续比赛。');
        check(message.epoch && message.epoch === next.epoch, '该操作属于另一局游戏。');
        setGamePaused(next.game, message);
        break;
      case 'settings': {
        check(isHost && !next.game, '只有房主能在大厅修改设置。');
        const rules = settingsFrom(message.rules);
        check(next.people.filter(p => p.role === 'play').length <= rules.seats, '当前参赛人数超过新的席位上限。');
        check(rules.spectators || !next.people.some(p => p.role === 'watch'), '请先移除观众再关闭观战。');
        next.rules = rules;
        break;
      }
      case 'start': {
        check(isHost && !next.game, '只有房主能从大厅开局。');
        const players = next.people.filter(p => p.role === 'play').map(p => p.id);
        check(players.every(id => online.has(id)), '请等待参赛者重连，或者移除掉线席位。');
        next.game = startGame(players, next.rules);
        next.epoch = newId();
        break;
      }
      case 'reset':
        check(isHost && next.game && message.epoch === next.epoch, '只有房主能结束当前这一局。');
        next.game = null;
        next.epoch = null;
        break;
      case 'role': {
        check(!next.game, '请在大厅切换席位。');
        const member = next.people.find(p => p.id === person.id);
        if (member.role === 'play') {
          check(next.rules.spectators, '房主已关闭观战。');
          member.role = 'watch';
        } else {
          check(seatsAvailable(next), '参赛席位已满。');
          member.role = 'play';
        }
        break;
      }
      case 'kick':
      case 'leave': {
        check(type === 'leave' || (isHost && message.person !== person.id), '只有房主能移除其他席位。');
        removed = next.people.find(p => p.id === (type === 'leave' ? person.id : message.person));
        check(removed, '该席位已离开。');
        check(!next.game || removed.role === 'watch', '请先返回大厅，再移除或离开参赛席位。');
        next.people = next.people.filter(p => p.id !== removed.id);
        if (removed.id === next.host) {
          const incoming = next.people.find(p => p.role === 'play' && online.has(p.id)) ??
            next.people.find(p => online.has(p.id)) ?? next.people[0];
          next.host = incoming?.id;
        }
        break;
      }
      default:
        check(false, '未知的房间操作。');
    }
    commit(next.people.length ? next : null);
    if (removed) eject(removed, type === 'leave' ? 'left' : 'kicked');
  }

  server.on('upgrade', (req, socket, head) => {
    try {
      const origin = req.headers.origin;
      const browserOrigin = origin && new URL(origin);
      const allowed = !browserOrigin || (publicOrigin ? browserOrigin.origin === publicOrigin :
        ['http:', 'https:'].includes(browserOrigin.protocol) && browserOrigin.host === req.headers.host);
      if (req.url !== '/live' || !allowed || sockets.clients.size >= 64) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
    } catch {
      socket.destroy();
    }
  });

  sockets.on('connection', socket => {
    Object.assign(socket, {alive: true, seq: 0, projection: {}, credit: 16, lastMessage: Date.now()});
    socket.joinTimeout = setTimeout(() => socket.close(4003, 'login timeout'), 12_000);
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => socket.terminate());
    socket.on('message', (raw, binary) => {
      const now = Date.now();
      socket.credit = Math.min(16, socket.credit + (now - socket.lastMessage) * 0.006);
      socket.lastMessage = now;
      if (socket.credit < 1 || binary) {
        socket.close(1008, 'message limit');
        return;
      }
      socket.credit--;
      let request;
      try {
        request = JSON.parse(raw);
        check(request && Number.isSafeInteger(request.req) && typeof request.type === 'string', '消息格式有误。');
        if (['resume', 'create', 'join'].includes(request.type)) {
          join(socket, request);
        } else {
          action(socket, request);
          send(socket, {type: 'ok', req: request.req});
        }
      } catch (error) {
        const expected = error instanceof RuleError || error instanceof SyntaxError;
        if (!expected) logger.error(error);
        send(socket, {type: 'error', req: request?.req, message: expected && error instanceof RuleError
          ? error.message : '服务未能处理这条消息，请稍后重试。'});
      }
    });
    socket.on('close', () => {
      clearTimeout(socket.joinTimeout);
      if (online.get(socket.person) !== socket) return;
      online.delete(socket.person);
      seen.set(socket.person, Date.now());
      broadcast();
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive) {
        socket.terminate();
      } else {
        socket.alive = false;
        socket.ping();
      }
    }
  }, 20_000);
  heartbeat.unref();
  phaseSchedule();

  const close = async () => {
    clearInterval(heartbeat);
    clearTimeout(phaseTimer);
    clearTimeout(broadcastTimer);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise((complete, fail) => server.close(error => error ? fail(error) : complete()));
    clearTimeout(broadcastTimer);
  };
  await new Promise((complete, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      complete();
    });
  });
  return {port: server.address().port, close};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const running = await startServer();
  console.log(`夜场画廊已监听端口 ${running.port}`);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => running.close().catch(error => {
      console.error(error);
      process.exitCode = 1;
    }));
  }
}
