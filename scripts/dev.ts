import { spawn } from 'node:child_process';

const children = [
  spawn('pnpm', ['run', 'dev:server'], { stdio: 'inherit' }),
  spawn('pnpm', ['run', 'dev:client'], { stdio: 'inherit' }),
];

function shutdown(): void {
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) shutdown();
  });
}
