import assert from 'node:assert/strict';
import {createServer, createConnection} from 'node:net';
import {DEFAULT_SETTINGS} from '../src/game.js';
import {artwork} from '../public/catalog.js';
import {withContainer} from './docker.js';
import {peer} from './peer.js';

// One shared downlink with fair turns for each TCP connection. The upstream is unrestricted.
async function downlink(target, bitsPerSecond) {
  const connections = new Set();
  const live = new Set();
  let delivered = 0;
  let last = performance.now();
  let credits = 0;
  const server = createServer(client => {
    const upstream = createConnection(target, '127.0.0.1');
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const lane = {client, upstream, queue: [], bytes: 0, ended: false};
    live.add(lane);
    client.pipe(upstream);
    const dispose = () => {
      live.delete(lane);
      connections.delete(lane);
      upstream.destroy();
      client.destroy();
    };
    client.on('close', dispose);
    client.on('error', dispose);
    upstream.on('error', dispose);
    upstream.on('end', () => {
      lane.ended = true;
      if (lane.bytes === 0) client.end();
    });
    upstream.on('data', data => {
      lane.queue.push(data);
      lane.bytes += data.length;
      connections.add(lane);
      if (lane.bytes > 128 * 1024) upstream.pause();
    });
  });
  const tick = setInterval(() => {
    const now = performance.now();
    credits = Math.min(2500, credits + (now - last) * bitsPerSecond / 8000);
    last = now;
    for (const lane of [...connections]) {
      if (credits < 1) break;
      const data = lane.queue[0];
      const size = Math.min(data.length, Math.floor(credits), 650);
      lane.client.write(data.subarray(0, size));
      lane.bytes -= size;
      delivered += size;
      credits -= size;
      if (size === data.length) lane.queue.shift();
      else lane.queue[0] = data.subarray(size);
      connections.delete(lane);
      if (lane.queue.length) connections.add(lane);
      else if (lane.ended) lane.client.end();
      if (lane.bytes < 64 * 1024) lane.upstream.resume();
    }
  }, 5);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    get delivered() { return delivered; },
    close: async () => {
      clearInterval(tick);
      for (const lane of live) {
        lane.client.destroy();
        lane.upstream.destroy();
      }
      await new Promise(resolve => server.close(resolve));
    }
  };
}

await withContainer(async ({port}) => {
  const link = await downlink(port, 1_000_000);
  const base = 'http://127.0.0.1:' + link.port;
  const ws = 'ws://127.0.0.1:' + link.port + '/live';
  const clients = [];
  const start = performance.now();
  const thumbs = Array.from({length: 8}, (_, n) => '/art/v1-' + n + '-s.webp');
  const assets = ['/', '/style.css', '/client.js', '/catalog.js', '/status', ...thumbs];
  const get = async path => {
    const response = await fetch(base + path, {headers: {'Accept-Encoding': 'br'}, signal: AbortSignal.timeout(20000)});
    assert.equal(response.status, 200);
    return response.arrayBuffer();
  };
  const enter = async message => {
    const client = await peer(ws, message);
    clients.push(client);
    return client;
  };
  try {
    await Promise.all(Array.from({length: 10}, async () => {
      // Browsers load the document before discovering its dependent assets.
      await get(assets[0]);
      await Promise.all(assets.slice(1).map(get));
    }));
    const cold = {ms: Math.round(performance.now() - start), bytes: link.delivered};
    assert.ok(cold.ms < 8000, 'cold load for the table took longer than 8 seconds');
    const rules = {...DEFAULT_SETTINGS, seats: 6, rounds: 2, nominateSeconds: 15, bidSeconds: 15};
    const host = await enter({type: 'create', title: '带宽验证', name: '房主', rules});
    const invite = host.snapshot.self.invite;
    const guests = await Promise.all(Array.from({length: 9}, (_, i) =>
      enter({type: 'join', name: '席位' + i, role: i < 5 ? 'play' : 'watch', invite})));
    assert.equal((await host.command({type: 'start'})).type, 'ok');
    await Promise.all(clients.map(p => p.until(() => p.snapshot.table?.phase === 'nominate' && p.snapshot.people.length === 10)));
    const players = [host, ...guests.slice(0, 5)];
    const curator = players.find(p => p.snapshot.self.id === host.snapshot.table.seller);
    const bidders = players.filter(p => p !== curator);
    const {lot, phase} = curator.snapshot.table;
    const epoch = curator.snapshot.room.epoch;
    const card = curator.snapshot.me.hand[0];
    const piece = artwork(card);
    assert.equal((await curator.command({type: 'nominate', epoch, lot, phase, card})).type, 'ok');
    await Promise.all(clients.map(p => p.until(() => p.snapshot.table?.phase === 'open')));
    const baseline = link.delivered;
    const latencies = [];
    for (let i = 0; i < 18; i++) {
      const amount = piece.reserve + i;
      const before = performance.now();
      assert.equal((await bidders[i % bidders.length].command({type: 'bid', lot, epoch, phase: 'open', amount})).type, 'ok');
      await Promise.all(clients.map(p => p.until(() => p.snapshot.table?.high?.amount === amount)));
      latencies.push(performance.now() - before);
    }
    const updates = link.delivered - baseline;

    const largeStart = performance.now();
    const loading = Promise.all(clients.map(() => get('/art/v1-' + piece.work + '-l.webp')));
    const amount = piece.reserve + 18;
    const before = performance.now();
    assert.equal((await bidders[18 % bidders.length].command({type: 'bid', lot, epoch, phase: 'open', amount})).type, 'ok');
    await Promise.all(clients.map(p => p.until(() => p.snapshot.table?.high?.amount === amount)));
    const artContention = Math.round(performance.now() - before);
    await loading;
    const artTime = Math.round(performance.now() - largeStart);
    await Promise.all(clients.map(p => p.until(() => p.snapshot.sales?.length === 1, 20000)));
    const p95 = Math.round([...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * .95) - 1]);
    assert.ok(p95 < 500 && artContention < 750, 'auction states were delayed on the shared downlink');
    assert.ok(updates < 64000, 'too much state was sent for 18 bids');
    console.log(JSON.stringify({clients: clients.length, downstreamBitsPerSecond: 1_000_000,
      coldLoadAllAssetsForTen: cold, eighteenBidsBytes: updates, stateDeliveryP95Ms: p95,
      bidDuringTenLargeArtDownloadsMs: artContention, tenLargeArtDownloadsMs: artTime}, null, 2));
  } finally {
    for (const client of clients) client.close();
    await link.close();
  }
});
