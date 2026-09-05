import { createApp } from './app.js';
import { createDebug } from './debug.js';

const container = document.getElementById('app');
if (!container) throw new Error('#app missing');

const app = await createApp(container);
const debug = createDebug(app, document.body);
let last = performance.now();
const tick = (now: number): void => {
  app.frame((now - last) / 1000);
  debug.update();
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
