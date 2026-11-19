// github-core-clone-01 — entrypoint (node /bot/main.ts).
//
// Lifecycle (the kit's wire contract): bind an ephemeral port (never
// 8080), POST {"port": N} to $MAKEFUN_ENV_URL/register within 20 s of
// boot, answer GET /healthz, then long-poll GET $MAKEFUN_ENV_URL/done
// until it answers {"done": true}, and exit 0. The forge never exits or
// crashes before done: a request failure is retried, never fatal.

import { createForgeServer, Forge } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

if (ENV_URL === undefined || ENV_URL === '') {
  console.error('github-core-clone-forge: MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const forge = new Forge(TOKEN);
const server = createForgeServer(forge);

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Bind the server on 0.0.0.0 with an ephemeral port; answer the port. */
function listen(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge listener has no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Register the port with the env, retrying inside the boot budget. */
async function register(port: number): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/register`;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 200 || response.status === 409) return;
      console.error(`github-core-clone-forge: register attempt ${attempt} answered HTTP ${response.status}`);
    } catch (err) {
      console.error(`github-core-clone-forge: register attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)})`);
    }
    await sleep(500);
  }
  console.error('github-core-clone-forge: register never answered; still polling /done');
}

/** Poll GET /done until the env answers {"done": true}. */
async function waitForDone(): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 200) {
        const body = (await response.json()) as unknown;
        if (typeof body === 'object' && body !== null && (body as Record<string, unknown>).done === true) return;
      }
    } catch {
      // The env answers /done at once when it is up; a failed poll is
      // transient (a restart, a hiccup), never a reason to exit.
    }
    await sleep(250);
  }
}

function shutdown(): void {
  try {
    server.close();
  } catch {
    // Already closed.
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const port = await listen();
await register(port);
await waitForDone();
shutdown();
