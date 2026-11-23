import {randomInt} from 'node:crypto';
import {artwork, CARD_COUNT, SERIES} from '../public/catalog.js';

export const DEFAULT_SETTINGS = {
  seats: 5, rounds: 3, funds: 60, nominateSeconds: 25, bidSeconds: 25,
  format: 'mixed', spectators: true
};

export class RuleError extends Error {}

export function check(condition, message) {
  if (!condition) throw new RuleError(message);
}

export function settingsFrom(input) {
  const options = {
    seats: [3, 4, 5, 6], rounds: [2, 3, 4], funds: [45, 60, 80],
    nominateSeconds: [15, 25, 40, 60], bidSeconds: [15, 25, 40, 60],
    format: ['mixed', 'open', 'sealed'], spectators: [true, false]
  };
  check(input && typeof input === 'object', '请选择房间设置。');
  return Object.fromEntries(Object.entries(options).map(([key, values]) => {
    check(values.includes(input[key]), '房间设置超出可选范围。');
    return [key, input[key]];
  }));
}

function shuffle(values) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function draw(game, player) {
  if (game.deck.length) player.hand.push(game.deck.pop());
}

function beginTurn(game, rules, now) {
  game.turn = {
    phase: 'nominate', lot: game.lots.length + 1, round: game.round,
    seller: game.order[game.cursor], until: now + rules.nominateSeconds * 1000
  };
}

export function startGame(ids, rules, now = Date.now()) {
  check(ids.length >= 3 && ids.length <= rules.seats && new Set(ids).size === ids.length, '开局需要 3 人以上，且参赛人数须符合房间设置。');
  const game = {
    order: shuffle([...ids]), cursor: 0, round: 1, deck: shuffle(Array.from({length: CARD_COUNT}, (_, i) => i)),
    values: SERIES.map(() => 12), demand: SERIES.map(() => 0),
    players: Object.fromEntries(ids.map(id => [id, {cash: rules.funds, hand: [], collection: []}])),
    lots: [], markets: [], ranking: null, turn: null
  };
  for (let i = 0; i < 3; i++) for (const id of game.order) draw(game, game.players[id]);
  beginTurn(game, rules, now);
  return game;
}

function formatFor(rules, lot) {
  return rules.format === 'mixed' ? (lot % 2 ? 'open' : 'sealed') : rules.format;
}

export function formatForTurn(game, rules) {
  return game.turn.phase === 'finished' ? null : formatFor(rules, game.turn.lot);
}

function nominate(game, card, rules, now) {
  const former = game.turn;
  const player = game.players[former.seller];
  const index = player.hand.indexOf(card);
  check(index >= 0, '这件作品已不在你的委托列表中。');
  player.hand.splice(index, 1);
  draw(game, player);
  const format = formatFor(rules, former.lot);
  const until = now + rules.bidSeconds * 1000;
  game.turn = {
    ...former, clock: 0, phase: format, card, until, hardLimit: until + 20000,
    high: null, offers: {}
  };
}

function bidders(game) {
  const {order, cursor} = game;
  return [...order.slice(cursor + 1), ...order.slice(0, cursor)];
}

function appraisal(game, id) {
  const player = game.players[id];
  const counts = SERIES.map(() => 0);
  let artValue = 0;
  for (const card of player.collection) {
    const {series, premium} = artwork(card);
    counts[series]++;
    artValue += game.values[series] + premium;
  }
  const bonus = Math.min(...counts) * 12;
  return {id, cash: player.cash, artValue, bonus, total: player.cash + artValue + bonus};
}

function settle(game, rules, now) {
  const {phase, card, seller, round, high, offers} = game.turn;
  let buyer = high?.id ?? null;
  let price = high?.amount ?? 0;
  if (phase === 'sealed') {
    const ordered = bidders(game)
      .filter(id => offers[id] > 0)
      .map(id => ({id, amount: offers[id]}))
      .sort((a, b) => b.amount - a.amount);
    buyer = ordered[0]?.id ?? null;
    price = buyer ? (ordered[1]?.amount ?? artwork(card).reserve) : 0;
  }
  const commission = Math.floor(price / 4);
  if (buyer) {
    game.players[buyer].cash -= price;
    game.players[buyer].collection.push(card);
    game.players[seller].cash += commission;
    const {series} = artwork(card);
    game.values[series] = Math.min(32, game.values[series] + 3);
    game.demand[series]++;
  }
  game.lots.push({round, card, seller, buyer, price, commission, format: phase});
  game.cursor++;
  if (game.cursor === game.order.length) {
    game.cursor = 0;
    game.values = game.values.map((value, index) => game.demand[index] ? value : Math.max(8, value - 2));
    game.markets.push([...game.values]);
    if (round === rules.rounds) {
      game.ranking = game.order.map(id => appraisal(game, id)).sort((a, b) => b.total - a.total);
      game.turn = {phase: 'finished', round};
      return;
    }
    game.round++;
    game.demand = SERIES.map(() => 0);
    // Move the opening seat clockwise at the start of each exhibition.
    game.order.push(game.order.shift());
  }
  beginTurn(game, rules, now);
}

export function advanceGame(game, rules, now = Date.now()) {
  const until = gameDeadline(game);
  if (!until || now < until) return false;
  if (game.turn.phase === 'nominate') {
    nominate(game, game.players[game.turn.seller].hand[0], rules, now);
  } else {
    settle(game, rules, now);
  }
  return true;
}

export function gameDeadline(game) {
  return game?.pausedAt == null ? game?.turn.until : undefined;
}

function isCurrentTurn(turn, action) {
  return turn.lot === action.lot && turn.phase === action.phase && (turn.clock ?? 0) === (action.clock ?? 0);
}

export function setGamePaused(game, action, now = Date.now()) {
  const turn = game?.turn;
  check(turn?.until && isCurrentTurn(turn, action), '拍卖阶段已切换，请查看当前牌桌。');
  if (action.type === 'pause') {
    check(game.pausedAt == null && now < turn.until, '当前阶段已暂停或已经结束。');
    game.pausedAt = now;
  } else {
    check(game.pausedAt != null, '当前阶段已经在进行。');
    const elapsed = Math.max(0, now - game.pausedAt);
    turn.until += elapsed;
    if (turn.hardLimit) turn.hardLimit += elapsed;
    delete game.pausedAt;
  }
  turn.clock = (turn.clock ?? 0) + 1;
}

export function actInGame(game, rules, id, action, now = Date.now()) {
  check(game?.players[id], '只有参赛者可以操作。');
  const turn = game.turn;
  check(game.pausedAt == null, '房主已暂停，请等待继续。');
  check(turn.until && now < turn.until && isCurrentTurn(turn, action), '拍卖阶段已切换，请确认后重新操作。');
  if (action.type === 'nominate') {
    check(turn.phase === 'nominate' && id === turn.seller, '现在由当值策展人选择拍品。');
    nominate(game, action.card, rules, now);
    return;
  }
  check(['open', 'sealed'].includes(turn.phase) && id !== turn.seller, '本件拍品暂时无法出价。');
  if (action.type === 'pass') {
    check(turn.phase === 'sealed', '公开竞价无需提交弃权。');
    turn.offers[id] = 0;
  } else {
    check(action.type === 'bid', '未知的竞价操作。');
    const minimum = turn.high ? turn.high.amount + 1 : artwork(turn.card).reserve;
    check(Number.isSafeInteger(action.amount) && action.amount >= minimum, `出价至少为 ${minimum} 点。`);
    check(action.amount <= game.players[id].cash, '你的现金不足。');
    if (turn.phase === 'open') {
      check(turn.high?.id !== id, '你已经是最高出价者。');
      turn.high = {id, amount: action.amount};
      turn.until = Math.min(turn.hardLimit, Math.max(turn.until, now + 5000));
    } else {
      turn.offers[id] = action.amount;
    }
  }
  if (turn.phase === 'sealed' && bidders(game).every(bidder => Object.hasOwn(turn.offers, bidder))) {
    settle(game, rules, now);
  }
}

export function gameView(game, rules, id) {
  if (!game) return {table: null, market: null, sales: null, scores: null, me: null};
  const {phase, lot, round, seller, until, card, high, offers} = game.turn;
  const player = game.players[id];
  return {
    table: {phase, lot, round, seller, until, card, high, format: formatForTurn(game, rules), order: game.order,
      clock: game.turn.clock ?? 0, pausedMs: game.pausedAt == null ? null : until - game.pausedAt,
      ...(phase === 'sealed' ? {responses: Object.keys(offers).length} : {})},
    market: {values: game.values, demand: game.demand, history: game.markets},
    sales: game.lots,
    scores: game.ranking,
    me: player ? {cash: player.cash, hand: player.hand,
      ...(phase === 'sealed' ? {offer: offers[id]} : {})} : null
  };
}
