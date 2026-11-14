// Entry lifecycle: bind a port, announce it to the trial env, idle until the
// env says the trial is over, then shut down cleanly.
//
// The env drives everything. It hands us its origin in MAKEFUN_ENV_URL and
// waits for our register call before it starts probing us:
//
//   1. No MAKEFUN_ENV_URL means there is no trial to join, so exit at once.
//   2. Start the forge on port 0 and let the kernel pick a free one. Port
//      8080 belongs to the env, never bind it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records the
//      address the request came from plus N and treats that as our base URL.
//      A 409 just means some other process registered first; keep waiting.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      While the suite runs it answers {"done": false} immediately, so poll
//      in a short loop with backoff rather than holding a request open.
//   5. Close the server and exit 0. The env then writes the export the
//      scorer grades.
//
// main.ts only wires the lifecycle together; the forge itself is built by
// app.ts, and no model is ever called from here.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register/done request may take this long before it is abandoned. */
const REQUEST_TIMEOUT = 30_000;
/** First pause between retries, doubling up to the cap below. */
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failed` failed attempts: exponential, capped. */
function backoffMs(failed: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failed, 8));
}

/**
 * Announce our port to the env until it accepts. 200 is the normal answer;
 * 409 means a first register already won elsewhere, which is not ours to
 * fix. 400/405 are contract errors and end the run; anything else is
 * retried, since the env may still be starting up.
 */
async function registerWithEnv(port: number): Promise<void> {
  for (let failed = 0; ; failed += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffMs(failed));
  }
}

/** Keep polling GET /done; return only once it answers {"done": true}. */
async function waitUntilDone(): Promise<void> {
  for (let failed = 0; ; failed += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done.
    }
    await pause(backoffMs(failed));
  }
}

/** Start the forge, register it, then wait for the env to finish the trial. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await registerWithEnv(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
