import { createApp } from './app.js';

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

const app = await createApp(container);
let last = performance.now();
const tick = (now: number): void => {
  app.frame((now - last) / 1000);
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
