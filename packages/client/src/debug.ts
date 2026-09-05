import GUI from 'lil-gui';
import type { App } from './app.js';
import { describePlayer } from './stats.js';

/**
 * F1 toggles the overlay. The stats element updates every frame even while hidden so
 * automated tests can read it through its data attributes.
 */
export function createDebug(app: App, container: HTMLElement): { update(): void } {
  const stats = document.createElement('div');
  stats.id = 'debug-stats';
  stats.hidden = true;
  container.appendChild(stats);
  const rows = new Map<string, HTMLElement>();
  for (const row of describePlayer(app.world, app.playerId, app.stats)) {
    const line = document.createElement('div');
    line.id = row.id;
    line.dataset['label'] = row.label;
    stats.appendChild(line);
    rows.set(row.id, line);
  }

  const gui = new GUI({ title: 'Clans debug' });
  gui.add(app, 'timeScale', 0.1, 4, 0.1);
  gui.add(app, 'paused');
  gui.add({ step: () => (app.stepOnce = true) }, 'step').name('step once');
  gui.add(app, 'freeCam').onChange((on: boolean) => {
    if (on) app.freeCamPosition.copy(app.camera.position);
  });
  gui.hide();

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F1') return;
    event.preventDefault();
    stats.hidden = !stats.hidden;
    if (stats.hidden) gui.hide();
    else gui.show();
  });

  return {
    update(): void {
      for (const row of describePlayer(app.world, app.playerId, app.stats)) {
        const line = rows.get(row.id);
        if (!line) continue;
        line.textContent = `${row.label}: ${row.text}`;
        line.dataset['value'] = String(row.value);
      }
      stats.dataset['ready'] = '1';
    },
  };
}
