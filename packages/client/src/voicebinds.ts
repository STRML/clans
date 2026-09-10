import type { AudioEngine } from './audio.js';

/**
 * Flat line labels, index = protocol VoiceBind line id. This order is load-bearing:
 * audio.ts's VOICE_SOUND indexes the SAME ids into the committed manifest
 * (0 tgt.destroyed, 1 flg.take, 2 gbl.thanks, 3 def.flag, 4 rep.me, 5 wrn.enemy,
 * 6 gbl.yes, 7 gbl.no, 8 gbl.nice), so a label here and the sample a receiving client
 * plays must agree by construction. Do not sort or regroup this array.
 */
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

/**
 * The quick-chat tree (#55), grouped the way the original voice pack's own file names group
 * it. Committed evidence: the nine recordings under `voice.vl2/audio/voice/Bot1/` in
 * packages/assets/src/audio-sources.ts carry category prefixes in their names --
 * `tgt.` (targeting), `flg.` (flag), `gbl.` (general), `def.` (defend), `rep.` (repair),
 * `wrn.` (warning) -- and docs/ui-audio-reference.md ("Voice") says menu entries "name
 * their categories rather than claiming exact transcripts". So the tree reproduces the
 * source's two-level V-menu SHAPE over the only lines that exist in the committed manifest;
 * no line, recording or transcript is invented. `id` is the flat protocol VoiceBind line id
 * (0-8), unchanged on the wire.
 */
export interface VoiceLine {
  id: number;
  label: string;
}
export interface VoiceCategory {
  key: string;
  label: string;
  lines: VoiceLine[];
}

const line = (id: number): VoiceLine => ({ id, label: VOICE_LINES[id]! });

export const VOICE_CATEGORIES: readonly VoiceCategory[] = [
  { key: 'tgt', label: 'Targeting', lines: [line(0)] },
  { key: 'flg', label: 'Flag', lines: [line(1)] },
  { key: 'def', label: 'Defend', lines: [line(3)] },
  { key: 'rep', label: 'Repair', lines: [line(4)] },
  { key: 'wrn', label: 'Warning', lines: [line(5)] },
  { key: 'gbl', label: 'General', lines: [line(2), line(6), line(7), line(8)] },
];

export function speakVoiceLine(lineId: number, audio: Pick<AudioEngine, 'voice'>): void {
  if (!Number.isInteger(lineId) || VOICE_LINES[lineId] === undefined) return;
  audio.voice(lineId);
}

/**
 * Pure two-level navigation step, shared by the DOM menu and the unit tests (node test
 * environment, no DOM). `open` is the currently shown category (null = category list).
 * Returns the category the menu should show next and the line id when a LINE was picked.
 */
export function resolveVoicePick(
  open: VoiceCategory | null,
  digit: number,
): { next: VoiceCategory | null; lineId: number | null } {
  if (digit < 1) return { next: open, lineId: null };
  if (open === null) {
    const category = VOICE_CATEGORIES[digit - 1] ?? null;
    return { next: category, lineId: null };
  }
  const picked = open.lines[digit - 1];
  return { next: open, lineId: picked ? picked.id : null };
}

export interface VoiceMenu {
  show(): void;
  hide(): void;
  readonly visible: boolean;
  /** One digit press, consumed by app.ts's shared digit read. Returns the protocol line id
   *  when the digit picked a LINE (caller then sends/plays it and closes the menu), or null
   *  when the digit only drilled into a category (menu stays open on the submenu). */
  pick(digit: number): number | null;
}
/** Builds the quick-chat menu DOM once, hidden by default -- app.ts toggles `show`/`hide` off
 *  `input.voiceMenuPressedThisFrame()`, the same edge-triggered shape the commander-map
 *  toggle already uses for `commandCirclePressedThisFrame`. Two levels, like the source's
 *  V-menu: digits 1-6 pick a category, then a digit picks the line inside it. All navigation
 *  goes through resolveVoicePick so the DOM stays a thin renderer of pure state. */
export function createVoiceMenu(container: HTMLElement): VoiceMenu {
  const menu = document.createElement('div');
  menu.id = 'voice-menu';
  menu.hidden = true;
  container.appendChild(menu);
  let openCategory: VoiceCategory | null = null;

  function render(): void {
    menu.replaceChildren();
    const rows = openCategory === null ? VOICE_CATEGORIES : openCategory.lines;
    rows.forEach((row, i) => {
      const element = document.createElement('div');
      element.textContent = `${String(i + 1)}: ${row.label}`;
      menu.appendChild(element);
    });
  }

  return {
    get visible() {
      return !menu.hidden;
    },
    show(): void {
      openCategory = null; // every open starts back at the category level
      render();
      menu.hidden = false;
    },
    hide(): void {
      openCategory = null;
      menu.hidden = true;
    },
    pick(digit: number): number | null {
      const { next, lineId } = resolveVoicePick(openCategory, digit);
      if (next !== openCategory) {
        openCategory = next;
        render();
      }
      return lineId;
    },
  };
}
