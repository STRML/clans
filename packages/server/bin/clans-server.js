#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const result = spawnSync('npx', ['tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
