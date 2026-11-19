// The entry's life, as the harness defines it: bind an ephemeral port,
// register it with the env, then wait until the env says the trial is
// over. The forge itself lives in app.ts; this file is only the lifecycle.
//
//   - MAKEFUN_ENV_URL names the env's origin. With no env there is
//     nothing to register with, so the process exits 1 at once.
//   - The server listens on port 0: the kernel picks a free port (the
//     env owns its own ports; never bind one of them).
//   - POST {port} to $MAKEFUN_ENV_URL/register. 200 means recorded; 409
//     means an earlier register already won and this process simply
//     waits like any other; 400/405 are contract errors and fatal.
//     Anything else (including a network error while the env starts)
//     is retried with a short exponential backoff.
//   - GET $MAKEFUN_ENV_URL/done until the body reads {done: true}.
//     Failed polls are retried the same way; the process never exits
//     before the env says done.
//   - Then close the server and exit 0.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after `failures` failed attempts: doubling from 250ms, capped at 2s. */
function backoff(failures: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(failures, 8));
}

async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // A network error or an unexpected status: the env may still be
      // starting, so fall through and retry.
    }
    await pause(backoff(failures));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: not done, so poll again.
    }
    await pause(backoff(failures));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('[entry] the server did not bind an ephemeral TCP port\n');
  process.exit(1);
}
process.stdout.write(`[entry] listening on port ${address.port}\n`);

await register(address.port);
process.stdout.write('[entry] registered; waiting for the env to say done\n');

await waitUntilDone();
server.close();
process.stdout.write('[entry] done\n');
process.exit(0);
