#!/usr/bin/env node
import { main } from '../dist/src/cli.js';

// --pause or KURULTAY_PAUSE=1: wait for Enter before the process ends. On computers where
// Node always runs in a window of its own (security software, "run as administrator"), that
// window closes as soon as Kurultay ends and its answer – or its error – is gone with it.
const argv = process.argv.slice(2);
const pause = argv.includes('--pause') || /^(1|true|yes|on)$/i.test(process.env.KURULTAY_PAUSE ?? '');
const args = argv.filter((a) => a !== '--pause');

async function waitForEnter(code) {
  if (!pause || !process.stdin.isTTY) return;
  process.stdout.write(`\nKurultay ended (exit code ${code}). Press Enter to close this window.\n`);
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
  process.stdin.pause();
}

async function logError(err) {
  const text = `${new Date().toISOString()} kurultay ${args.join(' ')}\n${err?.stack ?? err}\n`;
  process.stderr.write(`\nUnexpected error: ${err?.stack ?? err}\n`);
  // also into ~/.kurultay/last-error.log: a window that closes takes the message with it
  try {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const dir = process.env.KURULTAY_HOME || join(homedir(), '.kurultay');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'last-error.log'), text);
    process.stderr.write(`(also written to ${join(dir, 'last-error.log')})\n`);
  } catch {
    /* best effort */
  }
}

main(args).then(
  () => waitForEnter(process.exitCode ?? 0),
  async (err) => {
    await logError(err);
    await waitForEnter(1);
    process.exit(1);
  },
);
