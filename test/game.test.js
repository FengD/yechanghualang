import assert from 'node:assert/strict';
import test from 'node:test';
import {artwork} from '../public/catalog.js';
import {actInGame, advanceGame, DEFAULT_SETTINGS, gameDeadline, gameView, setGamePaused, settingsFrom, startGame} from '../src/game.js';

const people = ['a', 'b', 'c'];
const rules = {...DEFAULT_SETTINGS, seats: 3, rounds: 2};
const begin = 1000000;

function act(g, config, id, type, values = {}, now = g.turn.until - 10000) {
  const {lot, phase} = g.turn;
  actInGame(g, config, id, {type, lot, phase, ...values}, now);
}

test('validates settings and deals unique cards', () => {
  assert.deepEqual(settingsFrom(rules), rules);
  assert.throws(() => settingsFrom({...rules, seats: 10}), /可选范围/);
  assert.throws(() => startGame(['a', 'a', 'b'], rules), /开局/);
  const game = startGame(people, rules, begin);
  assert.equal(game.turn.until, begin + 25000);
  assert.equal(new Set([...game.deck, ...people.flatMap(id => game.players[id].hand)]).size, 48);
  assert.equal(gameView(game, rules, 'watcher').me, null);
});

test('open auctions enforce eligibility, funds, increment and the anti-sniping cap', () => {
  const game = startGame(people, rules, begin);
  const [seller, first, second] = game.order;
  const card = game.players[seller].hand[0];
  const {series, reserve} = artwork(card);
  assert.throws(() => act(game, rules, first, 'nominate', {card}), /当值/);
  act(game, rules, seller, 'nominate', {card}, begin + 1000);
  assert.equal(game.players[seller].hand.length, 3);
  assert.ok(!game.players[seller].hand.includes(card));
  assert.throws(() => act(game, rules, seller, 'bid', {amount: reserve}), /无法出价/);
  assert.throws(() => act(game, rules, first, 'bid', {amount: 61}), /不足/);
  assert.throws(() => act(game, rules, first, 'bid', {amount: reserve - 1}), /至少/);
  act(game, rules, first, 'bid', {amount: reserve}, game.turn.until - 1);
  assert.equal(game.turn.until, begin + 30999);
  assert.throws(() => act(game, rules, first, 'bid', {amount: reserve + 1}), /最高出价/);
  assert.throws(() => act(game, rules, second, 'bid', {amount: reserve}), /至少/);
  for (let i = 1; i <= 5; i++) act(game, rules, i % 2 ? second : first, 'bid', {amount: reserve + i}, game.turn.until - 1);
  assert.equal(game.turn.until, begin + 46000);
  assert.equal(advanceGame(game, rules, game.turn.until - 1), false);
  assert.equal(advanceGame(game, rules, game.turn.until), true);
  assert.equal(game.players[second].cash, 60 - reserve - 5);
  assert.deepEqual(game.players[second].collection, [card]);
  assert.equal(game.players[seller].cash, 60 + Math.floor((reserve + 5) / 4));
  assert.equal(game.values[series], 15);
});

test('sealed offers and passes are private, mutable and resolved by second price', () => {
  const config = {...rules, format: 'sealed'};
  const game = startGame(people, config, begin);
  const [seller, first, second] = game.order;
  const card = game.players[seller].hand[0];
  const reserve = artwork(card).reserve;
  act(game, config, seller, 'nominate', {card});
  act(game, config, first, 'pass');
  assert.equal(gameView(game, config, first).me.offer, 0);
  act(game, config, first, 'bid', {amount: reserve + 10});
  assert.equal(gameView(game, config, first).me.offer, reserve + 10);
  const publicView = gameView(game, config, 'observer');
  assert.equal(publicView.table.responses, 1);
  assert.ok(!JSON.stringify(publicView).includes('offer'));
  assert.ok(!Object.hasOwn(publicView.table, 'hardLimit'));
  act(game, config, second, 'bid', {amount: reserve + 4});
  assert.equal(game.lots[0].buyer, first);
  assert.equal(game.lots[0].price, reserve + 4);
  assert.equal(game.turn.seller, first);
});

test('sealed ties follow curator order, and a lone bidder pays reserve', () => {
  const config = {...rules, format: 'sealed'};
  const game = startGame(people, config, begin);
  const order = [...game.order];
  advanceGame(game, config, game.turn.until);
  act(game, config, order[2], 'bid', {amount: 30});
  act(game, config, order[1], 'bid', {amount: 30});
  assert.equal(game.lots[0].buyer, order[1]);
  assert.equal(game.lots[0].price, 30);
  advanceGame(game, config, game.turn.until);
  const reserve = artwork(game.turn.card).reserve;
  act(game, config, order[0], 'bid', {amount: 30});
  advanceGame(game, config, game.turn.until);
  assert.equal(game.lots[1].buyer, order[0]);
  assert.equal(game.lots[1].price, reserve);
});

test('pausing preserves the remaining time and open-auction extension cap across repeated pauses', () => {
  const game = startGame(people, rules, begin);
  const [seller, first, second] = game.order;
  const card = game.players[seller].hand[0];
  const reserve = artwork(card).reserve;
  const at = (type, now) => {
    const {lot, phase, clock} = game.turn;
    setGamePaused(game, {type, lot, phase, clock}, now);
  };
  at('pause', begin + 5000);
  assert.equal(gameDeadline(game), undefined);
  assert.equal(gameView(game, rules, first).table.pausedMs, 20000);
  assert.equal(advanceGame(game, rules, begin + 50000), false);
  assert.throws(() => act(game, rules, seller, 'nominate', {card, clock: 1}), /暂停/);
  at('continue', begin + 50000);
  assert.equal(gameDeadline(game), begin + 70000);
  assert.throws(() => act(game, rules, seller, 'nominate', {card}), /阶段已切换/);
  act(game, rules, seller, 'nominate', {card, clock: 2}, begin + 51000);
  act(game, rules, first, 'bid', {amount: reserve}, game.turn.until - 100);
  const until = game.turn.until;
  const hardLimit = game.turn.hardLimit;
  at('pause', until - 900);
  at('continue', until + 9100);
  at('pause', until + 9500);
  at('continue', until + 14500);
  assert.equal(game.turn.until, until + 15000);
  assert.equal(game.turn.hardLimit, hardLimit + 15000);
  assert.deepEqual(game.turn.high, {id: first, amount: reserve});
  act(game, rules, second, 'bid', {clock: 4, amount: reserve + 1}, game.turn.until - 1);
  assert.ok(game.turn.until <= game.turn.hardLimit);
});

test('all 24 auctions resolve with timeouts, rotating first seat and recording final value', () => {
  const config = {...rules, rounds: 4, seats: 6};
  const game = startGame(['a', 'b', 'c', 'd', 'e', 'f'], config, begin);
  const order = [...game.order];
  for (let i = 0; i < 24; i++) {
    const round = Math.floor(i / 6);
    assert.equal(game.turn.seller, order[(i % 6 + round) % 6]);
    assert.equal(game.turn.lot, i + 1);
    assert.equal(advanceGame(game, config, game.turn.until), true);
    assert.equal(game.turn.phase, i % 2 ? 'sealed' : 'open');
    assert.equal(advanceGame(game, config, game.turn.until), true);
  }
  assert.equal(game.turn.phase, 'finished');
  assert.equal(game.deck.length, 6);
  assert.deepEqual(game.markets.map(r => r[0]), [10, 8, 8, 8]);
  assert.ok(game.lots.every(lot => !lot.buyer));
  assert.ok(game.ranking.every(score => score.total === 60));
});

test('appraisal includes rarity, diversified collections, market ceiling and final cooling', () => {
  const config = {...rules, format: 'sealed'};
  const game = startGame(people, config, begin);
  for (let i = 0; i < 5; i++) {
    advanceGame(game, config, game.turn.until);
    advanceGame(game, config, game.turn.until);
  }
  const buyer = game.order[0];
  game.players[buyer].collection = [0, 13, 26, 39];
  game.values = [31, 22, 16, 12];
  game.demand = [2, 1, 1, 0];
  game.players[game.turn.seller].hand[0] = 3;
  advanceGame(game, config, game.turn.until);
  act(game, config, buyer, 'bid', {amount: 25});
  advanceGame(game, config, game.turn.until);
  const score = game.ranking.find(entry => entry.id === buyer);
  assert.deepEqual(game.values, [32, 22, 16, 10]);
  assert.equal(score.artValue, 32 + 24 + 20 + 16 + 38);
  assert.equal(score.bonus, 12);
  assert.equal(score.total, 60 - 10 + score.artValue + 12);
});
