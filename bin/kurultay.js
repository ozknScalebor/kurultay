#!/usr/bin/env node
import { main } from '../dist/src/cli.js';

main().catch(async (err) => {
  const text = `${new Date().toISOString()} kurultay ${process.argv.slice(2).join(' ')}\n${err?.stack ?? err}\n`;
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
  process.exit(1);
});
