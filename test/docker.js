import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as wait} from 'node:timers/promises';

const docker = (...args) => execFileSync('docker', args, {encoding: 'utf8'}).trim();

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

export async function withContainer(run, {createKey = ''} = {}) {
  const name = 'night-gallery-qa-' + randomBytes(5).toString('hex');
  const image = process.env.GALLERY_IMAGE ?? 'night-gallery:local';
  const volume = name + '-data';
  let started = false;
  docker('volume', 'create', volume);
  try {
    const port = await unusedPort();
    docker('run', '-d', '--name', name, '--init', '--read-only', '-p', '127.0.0.1:' + port + ':8080',
      '-v', volume + ':/data', '-e', 'ROOM_CREATE_KEY=' + createKey, image);
    started = true;
    const base = 'http://127.0.0.1:' + port;
    async function ready() {
      for (let i = 0; i < 100; i++) {
        const response = await fetch(base + '/healthz', {signal: AbortSignal.timeout(1000)}).catch(() => null);
        if (response?.ok) return;
        await wait(100);
      }
      throw new Error('container did not become ready');
    }
    await ready();
    await run({base, port, restart: async () => { docker('restart', name); await ready(); }});
  } catch (error) {
    if (started) process.stderr.write(docker('logs', name) + '\n');
    throw error;
  } finally {
    if (started) docker('rm', '-f', name);
    docker('volume', 'rm', volume);
  }
}
