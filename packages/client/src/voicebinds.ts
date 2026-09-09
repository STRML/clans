import type { AudioEngine } from './audio.js';

// Menu categories mapped to the original Bot1 voice pack, in protocol line-id order.
export const VOICE_LINES: readonly string[] = [
  'Target destroyed',
  'Taking the flag',
  'Thanks',
  'Defend our flag',
  'Repair me',
  'Incoming enemy',
  'Yes',
  'No',
  'Nice shot',
];

export function speakVoiceLine(lineId: number, audio: Pick<AudioEngine, 'voice'>): void {
  if (!Number.isInteger(lineId) || VOICE_LINES[lineId] === undefined) return;
  audio.voice(lineId);
}

export interface VoiceMenu {
  show(): void;
  hide(): void;
  readonly visible: boolean;
}

/** Builds the quick-chat menu DOM once, hidden by default -- app.ts toggles `show`/`hide` off
 *  `input.voiceMenuPressedThisFrame()`, the same edge-triggered shape the commander-map
 *  toggle already uses for `commandCirclePressedThisFrame`. */
export function createVoiceMenu(container: HTMLElement): VoiceMenu {
  const menu = document.createElement('div');
  menu.id = 'voice-menu';
  menu.hidden = true;
  VOICE_LINES.forEach((line, i) => {
    const row = document.createElement('div');
    row.textContent = `${String(i + 1)}: ${line}`;
    menu.appendChild(row);
  });
  container.appendChild(menu);
  return {
    get visible() {
      return !menu.hidden;
    },
    show(): void {
      menu.hidden = false;
    },
    hide(): void {
      menu.hidden = true;
    },
  };
}
