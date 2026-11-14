// Entry lifecycle: bind a port, announce it to the trial
// environment, idle until the environment says the trial is over,
// then shut down cleanly.
//
// The environment drives everything. It hands us its origin in
// MAKEFUN_ENV_URL and waits for our register call before it starts
// probing the forge:
//
//   1. No MAKEFUN_ENV_URL means there is no trial to join, so exit now.
//   2. Start the forge on port 0 and let the kernel pick a free port.
//      Port 8080 belongs to the environment — never bind it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The environment
//      records the address the request came from plus N and treats
//      that as our base URL. A 409 just means some other process
//      registered first; keep waiting.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      While the suite runs it answers {"done": false} at once, so
//      poll in a short loop with backoff instead of holding a
//      request open for a long time.
//   5. Close the server and exit 0. The environment then writes the
//      export that the scorer grades.
//
// main.ts only wires the lifecycle together. The forge itself is
// built by app.ts, and no model is ever called from anywhere here.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register/done request may take this long before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// First pause between retries, doubling up to the cap below.
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

// Sleep for `ms` milliseconds.
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Pause after `failed` failed attempts: exponential backoff, capped.
function retryDelayMs(failed: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(failed, 8));
}

// Announce our port to the environment until it accepts. A 200 is
// the normal answer; a 409 means a first register already won
// elsewhere, which is not ours to fix. 400/405 are contract errors
// and end the run; anything else is retried, since the environment
// may still be starting up.
async function announcePort(port: number): Promise<void> {
  for (let failed = 0; ; failed += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (caught) {
      if (caught instanceof Error && caught.message.startsWith('register answered HTTP ')) throw caught;
    }
    await sleepMs(retryDelayMs(failed));
  }
}

// Keep polling GET /done; return only once it answers {"done": true}.
async function pollForDone(): Promise<void> {
  for (let failed = 0; ; failed += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out:
      // either way, the trial is not done.
    }
    await sleepMs(retryDelayMs(failed));
  }
}

// Start the forge, register it with the environment, then wait for
// the environment to finish the trial.
async function runEntry(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announcePort(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await pollForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await runEntry();
  process.exit(0);
} catch (caught) {
  process.stderr.write(`[entry] ${caught instanceof Error ? caught.message : String(caught)}\n`);
  process.exit(1);
}
