import {artwork, SERIES} from './catalog.js';

const element = id => document.getElementById(id);
const formDefaults = {seats: 5, rounds: 3, funds: 60, nominateSeconds: 25, bidSeconds: 25, format: 'mixed', spectators: true};
const formats = {mixed: '交替拍卖', open: '公开竞价', sealed: '密封报价'};
const phases = {nominate: '选拍品', open: '公开竞价', sealed: '密封报价', finished: '结算完成'};
const tokenKey = 'night-gallery-session-v1';
const guideKey = 'night-gallery-guide-v1';
const artPath = (work, size = 's') => `/art/v1-${work}-${size}.webp`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]);

let state;
let socket;
let token;
let welcome;
let sequence = 0;
let request = 0;
let retry = 700;
let offset = 0;
let retryTimer;
let connectionTimer;
let noticeTimer;
let pendingEntry = false;
let newConnection = false;
let awaitingSync = false;
let leavingPage = false;
let admissionError = '';
let lastStageLot;
let claim;
let guideDone = false;
let guideIndex = 0;
let guideSteps = [];

try {
  token = localStorage.getItem(tokenKey);
  guideDone = localStorage.getItem(guideKey) === 'done';
} catch { /* private storage can be disabled */ }

function remember(next) {
  try {
    if (next) localStorage.setItem(tokenKey, next);
    else if (token && localStorage.getItem(tokenKey) === token) localStorage.removeItem(tokenKey);
  } catch { /* the open tab can still reconnect */ }
  token = next;
}

function badge(label, online = false) {
  const connection = element('connection');
  connection.textContent = label;
  connection.classList.toggle('online', online);
}

function notify(message) {
  clearTimeout(noticeTimer);
  const notice = element('notice');
  notice.textContent = message;
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4900);
}

function update(id, html) {
  const section = element(id);
  if (section.rendered === html) return;
  const details = [...section.querySelectorAll('details[open][data-detail]')].map(node => node.dataset.detail);
  section.innerHTML = html;
  section.rendered = html;
  for (const node of section.querySelectorAll('details[data-detail]')) node.open = details.includes(node.dataset.detail);
}

function select(name, label, values, selected) {
  return `<label class="field"><span>${label}</span><select name="${name}">${values.map(([value, caption]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${caption}</option>`).join('')}</select></label>`;
}

function settingsFields(rules) {
  return `<div class="form-grid">
    ${select('seats', '参赛席位', [3, 4, 5, 6].map(n => [n, n + ' 人']), rules.seats)}
    ${select('rounds', '展期数量', [2, 3, 4].map(n => [n, n + ' 期']), rules.rounds)}
    ${select('funds', '初始现金', [45, 60, 80].map(n => [n, n + ' 点']), rules.funds)}
    ${select('format', '拍卖方式', Object.entries(formats), rules.format)}
    ${select('nominateSeconds', '策展限时', [15, 25, 40, 60].map(n => [n, n + ' 秒']), rules.nominateSeconds)}
    ${select('bidSeconds', '竞价限时', [15, 25, 40, 60].map(n => [n, n + ' 秒']), rules.bidSeconds)}
  </div>
  <label class="field"><input type="checkbox" name="spectators"${rules.spectators ? ' checked' : ''}><span>允许观战</span></label>`;
}

function currentInvite() {
  return new URLSearchParams(location.hash.slice(1)).get('invite') ?? '';
}

function readSettings(data) {
  return {
    seats: Number(data.get('seats')), rounds: Number(data.get('rounds')), funds: Number(data.get('funds')),
    nominateSeconds: Number(data.get('nominateSeconds')), bidSeconds: Number(data.get('bidSeconds')),
    format: data.get('format'), spectators: data.has('spectators')
  };
}

function updateEntryError() {
  const error = element('entry-error');
  if (!error) return;
  error.hidden = !admissionError;
  error.textContent = admissionError;
  for (const id of ['entry-form', 'recover-form']) {
    const submit = element(id)?.querySelector('button[type=submit]');
    if (submit) submit.disabled = pendingEntry;
  }
}

function showWelcome() {
  element('entry').hidden = false;
  element('inside').hidden = true;
  const name = `<label class="field"><span>你的昵称</span><input name="name" maxlength="32" autocomplete="nickname" placeholder="输入昵称" required></label>`;
  const error = `<p id="entry-error" class="form-error" role="alert" hidden></p>`;
  if (!welcome) {
    update('welcome', `<h2>无法连接拍卖厅</h2><p class="muted">请检查网络，然后重试。</p><button class="button" data-action="refresh" type="button">重试</button>`);
  } else if (welcome.exists) {
    const invite = currentInvite();
    update('welcome', `<h2>加入拍卖厅</h2><p class="muted">通过房主分享的邀请入场。</p>
      <form id="entry-form" data-kind="join" class="form">
        ${name}
        ${invite ? '' : '<label class="field"><span>邀请链接或邀请码</span><input name="invite" maxlength="256" placeholder="粘贴房主的邀请" required></label>'}
        ${select('role', '入场方式', [['play', '参赛'], ['watch', '观战']], 'play')}
        <button class="button" type="submit">进入拍卖厅</button>
      </form>
      <details data-detail="recover"><summary>使用席位恢复码</summary>
        <form id="recover-form" class="form">
          <label class="field"><span>席位恢复码</span><input type="password" name="recovery" maxlength="32" required></label>
          <button class="button secondary" type="submit">恢复席位</button>
        </form>
      </details>${error}`);
  } else {
    update('welcome', `<h2>创建拍卖厅</h2><p class="muted">设置本桌参数，再发送邀请。</p>
      <form id="entry-form" data-kind="create" class="form">
        ${name}
        <label class="field"><span>房间名称</span><input name="title" maxlength="52" value="夜场画廊" required></label>
        ${welcome.createKey ? '<label class="field"><span>建房密钥</span><input name="key" type="password" maxlength="256" required></label>' : ''}
        ${settingsFields(formDefaults)}
        ${error}<button class="button" type="submit">创建房间</button>
      </form>`);
  }
  updateEntryError();
}

async function loadWelcome() {
  badge('连接中');
  try {
    const response = await fetch('/status', {cache: 'no-store'});
    if (!response.ok) throw new Error('status');
    welcome = await response.json();
    if (!socket && !state) badge('服务器可用', true);
  } catch {
    welcome = null;
    if (!socket && !state) badge('连接中断');
  }
  if (!state) showWelcome();
}

function send(message) {
  if (!newConnection || socket?.readyState !== WebSocket.OPEN) {
    notify('当前未连接，请等待重连。');
    return;
  }
  socket.send(JSON.stringify({...message, req: ++request}));
}

function turnAction(type, extra = {}) {
  const {epoch} = state.room;
  const {lot, phase, clock} = state.table;
  send({type, epoch, lot, phase, clock, ...extra});
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  if (!token || leavingPage || document.hidden || !navigator.onLine) return;
  retryTimer = setTimeout(() => connect({type: 'resume', token}), retry);
  retry = Math.min(10000, retry * 1.8);
}

function waiting(label) {
  newConnection = false;
  badge(label);
  if (state) {
    renderStage();
    renderHand();
  } else if (token) {
    update('welcome', `<h2>正在恢复席位</h2><p class="muted">连接后将自动回到当前拍卖。</p>
      <button class="button secondary" data-action="reconnect" type="button">重新连接</button>`);
  }
}

function forget(message, replaced) {
  clearTimeout(retryTimer);
  if (replaced) token = null;
  else remember(null);
  claim = undefined;
  state = null;
  sequence = 0;
  newConnection = false;
  pendingEntry = false;
  admissionError = message;
  awaitingSync = false;
  element('show-guide').hidden = true;
  element('inside').hidden = true;
  element('entry').hidden = false;
  for (const id of ['art-dialog', 'reset-dialog', 'recovery-dialog', 'guide-dialog']) if (element(id).open) element(id).close();
  loadWelcome();
}

function disconnected(ws, code) {
  if (socket !== ws) return;
  clearTimeout(connectionTimer);
  socket = undefined;
  awaitingSync = false;
  if (code === 4001) {
    forget('这个席位已在另一个页面连接。', true);
    return;
  }
  if (code === 4004) {
    forget('之前的席位已失效，请重新加入。');
    return;
  }
  waiting(token && navigator.onLine ? '重连中' : '未连接');
  if (pendingEntry && !token) {
    pendingEntry = false;
    admissionError = '暂时无法连接拍卖厅，请重试。';
    updateEntryError();
  }
  scheduleReconnect();
}

function connectionTimeout(ws, ms) {
  clearTimeout(connectionTimer);
  connectionTimer = setTimeout(() => {
    if (socket !== ws) return;
    disconnected(ws);
    ws.close();
  }, ms);
}

function connect(first) {
  clearTimeout(retryTimer);
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  const url = new URL('/live', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  socket = ws;
  awaitingSync = false;
  sequence = 0;
  waiting(state ? '重连中' : '连接中');
  connectionTimeout(ws, 8000);
  ws.addEventListener('open', () => {
    if (socket === ws) ws.send(JSON.stringify({...first, req: ++request}));
  });
  ws.addEventListener('message', event => {
    if (socket !== ws) return;
    const packet = JSON.parse(event.data);
    switch (packet.type) {
      case 'admit':
        if (packet.token || first.type === 'resume') remember(packet.token ?? first.token);
        claim = undefined;
        pendingEntry = false;
        admissionError = '';
        return;
      case 'snapshot':
      case 'patch':
        if (packet.seq !== sequence + 1 || (packet.type === 'patch' && !state)) {
          disconnected(ws);
          ws.close();
          return;
        }
        sequence = packet.seq;
        if (packet.type === 'snapshot' || !awaitingSync) {
          clearTimeout(connectionTimer);
          retry = 700;
          awaitingSync = false;
          newConnection = true;
          badge('已连接', true);
        }
        offset = packet.now - Date.now();
        if (packet.type === 'snapshot') {
          state = packet.data;
        } else {
          const {tableDelta, ...patch} = packet.data;
          state = {...state, ...patch};
          if (tableDelta) state.table = {...state.table, ...tableDelta};
        }
        render();
        return;
      case 'error':
        if (pendingEntry) {
          admissionError = packet.message;
          pendingEntry = false;
          updateEntryError();
          ws.close();
          if (packet.message === '此服务器已有一个房间。') loadWelcome();
        } else {
          notify(packet.message);
        }
        return;
      case 'left':
      case 'kicked':
      case 'expired':
      case 'replaced': {
        const reasons = {
          left: '已离开房间。', kicked: '房主已移除你的席位。',
          expired: '之前的席位已失效，请重新加入。', replaced: '这个席位已在另一个页面连接。'
        };
        clearTimeout(connectionTimer);
        socket = undefined;
        ws.close();
        forget(reasons[packet.type], packet.type === 'replaced');
        return;
      }
      case 'ok':
        return;
    }
  });
  ws.addEventListener('close', event => disconnected(ws, event.code));
}

function resumeForeground() {
  if (!token || leavingPage || document.hidden || !navigator.onLine) return;
  if (!socket || socket.readyState >= WebSocket.CLOSING) {
    connect({type: 'resume', token});
  } else if (newConnection) {
    awaitingSync = true;
    waiting('同步中');
    socket.send(JSON.stringify({type: 'sync', req: ++request}));
    connectionTimeout(socket, 4000);
  }
}

function personName(id) {
  return escape(state.people.find(person => person.id === id)?.name ?? '—');
}

function panelHead(title, note = '') {
  return `<div class="section-head"><h2>${title}</h2><span class="quiet">${note}</span></div>`;
}

function artButton(card) {
  const info = artwork(card);
  return `<button class="art-preview" type="button" data-art="${card}" aria-label="放大《${info.title}》">
    <img src="${artPath(info.work)}" alt="${info.title}" width="160" height="160" decoding="async">
  </button>`;
}

function artLink(card) {
  const info = artwork(card);
  return `<button class="inline-art" type="button" data-art="${card}">${info.title}·${info.edition}/6</button>`;
}

function showArt(card) {
  const info = artwork(card);
  element('art-series').textContent = SERIES[info.series].name;
  element('art-title').textContent = info.title;
  const current = state.market?.values[info.series];
  update('art-content', `<img src="${artPath(info.work, 'l')}" width="480" height="480" alt="${info.title}" decoding="async">
    <p class="muted">版次 ${info.edition}/6 · 溢价 +${info.premium}${current === undefined ? '' : ' · 当前估值 ' + (current + info.premium)}</p>`);
  element('art-dialog').showModal();
}

function lobby() {
  const {rules, host} = state.room;
  const players = state.people.filter(p => p.role === 'play');
  const isHost = state.self.id === host;
  const ready = players.length >= 3 && players.every(p => p.online);
  return `<div class="lobby-copy">
    <h2 class="lobby-title">拍卖尚未开始</h2>
    <p class="muted">${ready ? (isHost ? '参赛者已到齐，可以开始本局。' : '已可开局，等待房主开始。')
      : '至少需要 3 名参赛者，开局时所有参赛席位都需在线。'}</p>
  </div>
  <div class="control-buttons">${isHost ? `<button class="button" data-action="start" type="button"${ready && newConnection ? '' : ' disabled'}>开始游戏</button>` : ''}
    <button class="button secondary" data-action="rules" type="button">阅读规则</button></div>
  <div class="rule-chips">
    <span class="chip">${rules.rounds} 个展期</span><span class="chip">初始 ${rules.funds} 点</span>
    <span class="chip">${formats[rules.format]}</span><span class="chip">策展 ${rules.nominateSeconds} 秒</span>
    <span class="chip">竞价 ${rules.bidSeconds} 秒</span>
  </div>`;
}

function ranking() {
  let rank = 0;
  return `${panelHead('资产排名', '同分并列')}
  <div class="table-overflow"><table>
    <thead><tr><th>名次</th><th>画廊</th><th class="number">现金</th><th class="number">藏品</th><th class="number">奖励</th><th class="number">总计</th></tr></thead>
    <tbody>${state.scores.map((score, i) => {
      if (score.total !== state.scores[i - 1]?.total) rank = i + 1;
      return `<tr><td>${rank}</td><td>${personName(score.id)}</td><td class="number">${score.cash}</td>
        <td class="number">${score.artValue}</td><td class="number">${score.bonus}</td><td class="number"><strong>${score.total}</strong></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function stageContent() {
  const {table, self, market, room} = state;
  if (!table) return lobby();
  if (table.phase === 'finished') return ranking();
  const seller = table.seller === self.id;
  const latest = state.sales.at(-1);
  const previous = latest && table.phase === 'nominate'
    ? `<p class="quiet previous-sale">上件拍品 ${artLink(latest.card)}${latest.buyer
      ? `由 ${personName(latest.buyer)} 以 ${latest.price} 点拍得` : '流拍'}</p>` : '';
  const paused = table.pausedMs != null;
  const hostPause = self.id === room.host ? `<button class="button secondary" type="button" data-action="${paused ? 'continue' : 'pause'}"
    ${newConnection ? '' : 'disabled'}>${paused ? '继续游戏' : '暂停游戏'}</button>` : '';
  const head = `<div class="section-head phase-head">
    <h2>拍品 ${String(table.lot).padStart(2, '0')} · ${phases[table.phase]}</h2>
    <div class="phase-tools"><span class="timer" id="timer" aria-label="${paused ? '暂停时剩余时间' : '剩余时间'}"></span>
      ${hostPause}</div>
  </div>${paused ? '<p class="pause-note" role="status">房主已暂停游戏。倒计时冻结，继续后可操作。</p>' : ''}`;
  if (table.phase === 'nominate') return `${head}
    <div class="nominate"><span class="overline">下一场 · ${formats[table.format]}</span>
      <h3>${seller ? '轮到你选择拍品' : personName(table.seller) + ' 正在策展'}</h3>
      <p class="muted">${seller ? '从下方委托中选一件作品。超时将选择列表里的第一件。' : '策展人选定作品后，拍卖将自动开始。'}</p>
    </div>${previous}`;
  const info = artwork(table.card);
  const open = table.phase === 'open';
  const sealedCaption = open ? (table.high ? '领先 · ' + personName(table.high.id) : '等待首次出价')
    : `已响应 ${table.responses} / ${table.order.length - 1}`;
  return `${head}
    <div class="hero-art">
      ${artButton(table.card)}
      <div class="art-info series-${info.series}">
        <span class="overline series-name">${SERIES[info.series].name} 系列 · 版次 ${info.edition}/6</span>
        <h3>${info.title}</h3><p class="quiet">策展人 ${personName(table.seller)}</p>
        <dl><div><dt>${open && table.high ? '当前最高' : '起拍价'}</dt><dd>${table.high?.amount ?? info.reserve}</dd></div>
        <div><dt>当前估值</dt><dd>${market.values[info.series] + info.premium}</dd></div></dl>
        <p class="quiet">${sealedCaption}</p>
      </div>
    </div>`;
}

function renderBid(sameLot) {
  const {table, self, me} = state;
  if (!['open', 'sealed'].includes(table?.phase)) {
    update('bid-controls', '');
    update('bid-status', '');
    return;
  }
  const open = table.phase === 'open';
  const seller = table.seller === self.id;
  const leading = table.high?.id === self.id;
  const minimum = table.high ? table.high.amount + 1 : artwork(table.card).reserve;
  const eligible = me && !seller && !leading && me.cash >= minimum;
  const hasForm = me && !seller;
  const live = newConnection && table.pausedMs == null;
  update('bid-controls', hasForm ? `<form id="bid-form" class="bid-form">
    <label id="bid-field" class="field"><span>出价（点）</span>
      <input id="bid-amount" name="amount" type="number" inputmode="numeric" step="1" required>
    </label><button class="button" id="submit-bid" type="submit">${open ? '出价' : '提交密封报价'}</button>
    ${open ? '' : '<button class="button secondary" id="pass-bid" data-action="pass" type="button">弃权</button>'}
  </form>` : '');
  if (hasForm) {
    const amount = element('bid-amount');
    const untouched = amount.value === amount.defaultValue;
    const suggested = String(open ? minimum : me.offer || minimum);
    amount.min = minimum;
    amount.max = me.cash;
    amount.defaultValue = suggested;
    if (!sameLot || untouched) amount.value = suggested;
    element('bid-field').hidden = !eligible;
    amount.disabled = !eligible;
    element('submit-bid').hidden = !eligible;
    element('submit-bid').disabled = !eligible || !live;
    if (!open) element('pass-bid').disabled = !live;
    element('bid-form').hidden = !eligible && open;
  }
  let status = '';
  if (!me) status = '你正在观战。';
  else if (seller) status = '你是本场策展人，成交后可获得佣金。';
  else if (leading) status = '你的出价暂时领先。';
  else if (!eligible) status = open ? '当前现金不足以继续出价。' : '你的现金低于起拍价，可以提交弃权。';
  else if (!open && Object.hasOwn(me, 'offer')) status = me.offer ? `你的密封报价：${me.offer} 点。` : '你已弃权。';
  update('bid-status', `${status ? `<p class="quiet auction-note">${status}</p>` : ''}
    ${!open && hasForm ? '<p class="quiet auction-note">你可以在计时结束或买家全员响应前修改报价。其他人只看到响应人数。</p>' : ''}`);
}

function renderStage() {
  const context = state.table ? state.room.epoch + '/' + state.table.lot + '/' + state.table.phase : '';
  update('stage-content', stageContent());
  renderBid(context === lastStageLot);
  lastStageLot = context;
  countdown();
}

function renderHand() {
  const section = element('hand');
  section.hidden = !state.me || state.table?.phase === 'finished';
  if (section.hidden) return;
  const {me, table, self, market} = state;
  const selectNow = table.phase === 'nominate' && table.seller === self.id;
  const canNominate = newConnection && table.pausedMs == null;
  update('hand', `${panelHead('我的委托', '仅自己可见')}
    <div class="hand-grid">${me.hand.map(card => {
      const info = artwork(card);
      return `<div class="hand-card series-${info.series}">
        ${artButton(card)}
        <div><strong>${info.title}</strong><small class="series-name">${SERIES[info.series].name} · ${info.edition}/6</small>
          <small class="muted">估值 ${market.values[info.series] + info.premium} · 起拍 ${info.reserve}</small></div>
        ${selectNow ? `<button class="button secondary" type="button" data-nominate="${card}"${canNominate ? '' : ' disabled'}>送拍</button>` : ''}
      </div>`;
    }).join('')}</div>`);
}

function renderMarket() {
  const {market, table} = state;
  element('market').hidden = !market;
  if (!market) return;
  const finished = table.phase === 'finished';
  update('market', `${panelHead('市场行情', finished ? '最终估值基准' : '本期成交')}
    <div class="series-list">${SERIES.map((series, i) => `
      <div class="series series-${i}"><span class="series-dot" aria-hidden="true"></span><strong>${series.name}</strong>
        <small class="muted">${market.demand[i]} 件</small><span class="market-value">${market.values[i]}</span></div>`).join('')}</div>
    ${market.history.length ? `<details data-detail="history"><summary>展期末行情</summary><div class="table-overflow">
      <table><thead><tr><th>展期</th>${SERIES.map(s => `<th class="number">${s.name}</th>`).join('')}</tr></thead>
        <tbody>${market.history.map((row, i) => `<tr><td>第 ${i + 1} 期</td>${row.map(n => `<td class="number">${n}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div></details>` : ''}`);
}

function renderSeats() {
  const {people, room, self, table, sales} = state;
  const host = room.host === self.id;
  const players = people.filter(p => p.role === 'play');
  const watchers = people.filter(p => p.role === 'watch');
  const order = table?.order;
  if (order) players.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const row = p => {
    const marks = [p.id === room.host && '房主', p.id === self.id && '你', p.id === table?.seller && '策展中', p.role === 'watch' && '观战'].filter(Boolean);
    const removable = host && p.id !== self.id && (!table || p.role === 'watch');
    const collection = sales?.filter(lot => lot.buyer === p.id) ?? [];
    return `<li>
      <div class="seat"><span class="presence${p.online ? ' online' : ''}" role="img" aria-label="${p.online ? '在线' : '离线'}"></span>
        <span class="seat-name">${escape(p.name)}${marks.length ? `<small>${marks.join(' · ')}</small>` : ''}</span>
        ${removable ? `<button class="text-button" data-kick="${p.id}" aria-label="移除 ${escape(p.name)}" type="button">移除</button>` : ''}</div>
      ${collection.length ? `<details data-detail="collection-${p.id}"><summary>藏品 ${collection.length} 件</summary>
        <div class="collection">${collection.map(lot => artLink(lot.card)).join('')}</div></details>` : ''}
    </li>`;
  };
  update('seats', `${panelHead('席位', `${people.length}/10 人`)}
    <p class="quiet">参赛 ${players.length}/${room.rules.seats} · 观战 ${watchers.length}</p>
    <ul class="seat-list">${[...players, ...watchers].map(row).join('')}</ul>`);
}

function renderSales() {
  const list = state.sales;
  element('sales').hidden = !list?.length;
  if (!list?.length) return;
  update('sales', `${panelHead('成交记录', `${list.length} 件拍品`)}
    <div class="table-overflow"><table><thead><tr><th>拍品</th><th>策展人</th><th>买家</th><th class="number">成交</th><th class="number">佣金</th></tr></thead>
      <tbody>${[...list].reverse().map(lot => `<tr><td>${artLink(lot.card)}<small class="muted"> · 第${lot.round}期</small></td>
        <td>${personName(lot.seller)}</td><td>${lot.buyer ? personName(lot.buyer) : '流拍'}</td>
        <td class="number">${lot.buyer ? lot.price : '—'}</td><td class="number">${lot.buyer ? lot.commission : '—'}</td></tr>`).join('')}</tbody>
    </table></div>`);
}

function inviteUrl() {
  const url = new URL('/', location.href);
  url.hash = 'invite=' + state.self.invite;
  return url.href;
}

function renderControl() {
  const {self, room, table, people} = state;
  const member = people.find(p => p.id === self.id);
  const host = room.host === self.id;
  const canLeave = !table || member.role === 'watch';
  const canSwap = !table && (member.role === 'play' ? room.rules.spectators
    : people.filter(p => p.role === 'play').length < room.rules.seats);
  element('control').hidden = false;
  update('control', `<h2>房间管理</h2>
    ${host ? `<label class="field"><span>邀请链接</span><input id="invite-link" readonly value="${escape(inviteUrl())}"></label>
      <div class="control-buttons"><button class="button secondary" type="button" data-action="copy">复制邀请</button></div>
      ${table ? '' : `<details data-detail="settings"><summary>修改房间设置</summary>
        <form id="settings-form" class="form">${settingsFields(room.rules)}<button class="button secondary" type="submit">保存设置</button></form></details>`}` : ''}
    <div class="control-buttons">
      ${canSwap ? `<button class="text-button" data-action="role" type="button">${member.role === 'play' ? '切换为观战' : '加入参赛席'}</button>` : ''}
      ${canLeave ? '<button class="text-button" data-action="leave" type="button">离开房间</button>' : ''}
      <button class="text-button" data-action="recovery" type="button">席位恢复码</button>
      ${host && table ? `<button class="text-button" data-action="reset" type="button">${table.phase === 'finished' ? '返回大厅' : '结束本局'}</button>` : ''}
    </div>`);
}

function guideOffer() {
  const observer = state.people.find(person => person.id === state.self.id).role === 'watch';
  const card = element('guide-invite');
  card.hidden = guideDone || (Boolean(state.table) && !observer);
  if (!card.hidden) {
    card.querySelector('p').textContent = observer ? '第一次观战？跟着指引看懂竞价、行情和结算。'
      : '第一次来？跟着指引学会送拍、出价和查看结算。';
  }
}

function openGuide() {
  const host = state.self.id === state.room.host;
  const observer = state.people.find(person => person.id === state.self.id).role === 'watch';
  const first = host ? '复制「房间管理」里的邀请链接。至少 3 位参赛者在线后，点「开始游戏」。'
    : '确认自己在参赛席。等房主点「开始游戏」，开局后可在顶部看到你的现金。';
  guideSteps = [
    observer
      ? ['查看拍卖桌', '观战时，拍品、公开竞价、市场和成交记录会实时更新。点画作可打开大图。']
      : ['在大厅准备', first],
    ['选一件作品送拍', observer
      ? '拍卖桌显示当值策展人。策展人从自己的委托中点「送拍」，选出的作品才会公开。'
      : '看到「轮到你选择拍品」时，在「我的委托」比较起拍价和估值，选一件点「送拍」。'],
    ['参与公开竞价', observer
      ? '拍卖桌显示最高价和领先玩家。倒计时结束时，领先的人按自己的报价买入。'
      : '轮到别人策展时，输入金额并点「出价」。看当前最高价和剩余时间，未领先时可继续加价。'],
    ['识别密封报价', observer
      ? '密封拍卖只显示响应人数。结算后在成交记录查看买家和成交价。'
      : '填金额后点「提交密封报价」，也可点「弃权」。最高报价者通常支付第二高价，可在成交记录确认。'],
    ['查看行情与结算', '在「市场行情」看各系列的估值，在「成交记录」看买家、成交价与佣金。最后一场结束后，拍卖桌会列出所有参赛者的资产排名。']
  ];
  guideIndex = 0;
  renderGuideStep();
  element('guide-dialog').showModal();
}

function renderGuideStep() {
  const [title, copy] = guideSteps[guideIndex];
  element('guide-progress').textContent = `第 ${guideIndex + 1} 步 / 共 ${guideSteps.length} 步`;
  element('guide-title').textContent = title;
  element('guide-copy').textContent = copy;
  element('guide-back').disabled = guideIndex === 0;
  element('guide-next').textContent = guideIndex === guideSteps.length - 1 ? '完成指引' : '下一步';
}

function dismissGuide() {
  guideDone = true;
  try { localStorage.setItem(guideKey, 'done'); } catch { /* preference applies in this tab */ }
  const dialog = element('guide-dialog');
  if (dialog.open) dialog.close();
  guideOffer();
}

function render() {
  element('entry').hidden = true;
  element('inside').hidden = false;
  element('show-guide').hidden = false;
  const {room, me, table, people, self} = state;
  const member = people.find(p => p.id === self.id);
  const label = table ? `第 ${table.round} / ${room.rules.rounds} 展期 · ${table.pausedMs != null ? '已暂停' : phases[table.phase]}` : '大厅';
  update('room-head', `<div><span class="overline">${label}</span><h1>${escape(room.title)}</h1></div>
    <div class="wallet"><span class="quiet">${me ? '我的现金' : (member.role === 'watch' ? '观战席' : '参赛席')}</span>
      ${me ? `<div class="money"><strong>${me.cash}</strong> 点</div>` : ''}</div>`);
  guideOffer();
  renderStage();
  renderHand();
  renderMarket();
  renderSeats();
  renderSales();
  renderControl();
}

function countdown() {
  const timer = element('timer');
  if (!timer || !state?.table?.until) return;
  const paused = state.table.pausedMs != null;
  const milliseconds = paused ? state.table.pausedMs : state.table.until - Date.now() - offset;
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const label = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  if (timer.textContent !== label) timer.textContent = label;
  timer.classList.toggle('urgent', !paused && seconds <= 5);
  timer.classList.toggle('paused', paused);
}

function inviteFrom(value) {
  const code = value.trim();
  if (/^[A-Za-z0-9_-]{32}$/.test(code)) return code;
  try {
    return new URLSearchParams(new URL(code).hash.slice(1)).get('invite') ?? '';
  } catch {
    return '';
  }
}

document.addEventListener('submit', event => {
  const form = event.target;
  if (!['entry-form', 'recover-form', 'settings-form', 'bid-form'].includes(form.id)) return;
  event.preventDefault();
  const data = new FormData(form);
  if (form.id === 'recover-form') {
    if (pendingEntry) return;
    pendingEntry = true;
    admissionError = '';
    updateEntryError();
    connect({type: 'resume', token: data.get('recovery').trim()});
  } else if (form.id === 'entry-form') {
    if (pendingEntry) return;
    const type = form.dataset.kind;
    const name = data.get('name');
    const message = type === 'create'
      ? {type, name, title: data.get('title'), key: data.get('key'), rules: readSettings(data)}
      : {type, name, role: data.get('role'), invite: currentInvite() || inviteFrom(data.get('invite') ?? '')};
    pendingEntry = true;
    admissionError = '';
    updateEntryError();
    claim ??= btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_');
    connect({...message, claim});
  } else if (form.id === 'settings-form') {
    send({type: 'settings', rules: readSettings(data)});
  } else {
    turnAction('bid', {amount: Number(data.get('amount'))});
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const {action} = button.dataset;
  if (button.id === 'show-rules' || button.dataset.action === 'rules') {
    element('rules-dialog').showModal();
  } else if (button.id === 'show-guide' || action === 'guide') {
    openGuide();
  } else if (action === 'skip-guide' || action === 'close-guide') {
    dismissGuide();
  } else if (button.id === 'guide-back') {
    guideIndex--;
    renderGuideStep();
  } else if (button.id === 'guide-next') {
    if (guideIndex === guideSteps.length - 1) dismissGuide();
    else {
      guideIndex++;
      renderGuideStep();
    }
  } else if (button.dataset.action === 'refresh') {
    loadWelcome();
  } else if (action === 'reconnect' && token) {
    connect({type: 'resume', token});
  } else if (button.id === 'confirm-reset') {
    element('reset-dialog').close();
    send({type: 'reset', epoch: state.room.epoch});
  } else if (button.dataset.action === 'recovery') {
    element('recovery-code').value = token;
    element('recovery-dialog').showModal();
  } else if (button.hasAttribute('data-art')) {
    showArt(Number(button.dataset.art));
  } else if (button.hasAttribute('data-nominate')) {
    turnAction('nominate', {card: Number(button.dataset.nominate)});
  } else if (button.hasAttribute('data-kick')) {
    send({type: 'kick', person: button.dataset.kick});
  } else if (button.dataset.action === 'copy') {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      notify('邀请链接已复制。');
    } catch {
      element('invite-link').select();
      notify('已选中邀请链接，可以手动复制。');
    }
  } else if (button.dataset.action === 'pass') {
    turnAction('pass');
  } else if (action === 'pause' || action === 'continue') {
    turnAction(action);
  } else if (button.dataset.action === 'reset') {
    if (state.table.phase === 'finished') send({type: 'reset', epoch: state.room.epoch});
    else element('reset-dialog').showModal();
  } else if (['role', 'start', 'leave'].includes(button.dataset.action)) {
    send({type: button.dataset.action});
  }
});

window.addEventListener('hashchange', () => {
  if (!state && welcome) {
    update('welcome', '');
    showWelcome();
  }
});
document.addEventListener('visibilitychange', resumeForeground);
window.addEventListener('online', resumeForeground);
window.addEventListener('offline', () => {
  if (socket) {
    const old = socket;
    disconnected(old);
    old.close();
  }
});
window.addEventListener('pagehide', () => {
  leavingPage = true;
  clearTimeout(retryTimer);
  clearTimeout(connectionTimer);
  const old = socket;
  socket = undefined;
  newConnection = false;
  old?.close();
});
window.addEventListener('pageshow', event => {
  leavingPage = false;
  if (event.persisted) resumeForeground();
});
element('guide-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  dismissGuide();
});
element('recovery-dialog').addEventListener('close', () => { element('recovery-code').value = ''; });
setInterval(countdown, 250);
if (token) connect({type: 'resume', token});
else loadWelcome();
