#!/usr/bin/env node
import { main } from '../dist/src/cli.js';

main().catch((err) => {
  process.stderr.write(`\nBeklenmeyen hata: ${err?.stack ?? err}\n`);
  process.exit(1);
});
