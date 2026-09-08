// T2-style quick-chat lines. No T2 script gives exact wording -- these are an original pick
// matching the classic voice-bind categories (kill confirm, flag status, need repair,
// incoming, affirmative/negative, taunt) the spec names, stated plainly as ours rather than
// dressed up as sourced (see the plan's "Spec gaps").
export const VOICE_LINES: readonly string[] = [
  'Enemy down',
  'I have the flag',
  'Flag carrier down',
  'Defending the flag',
  'Need repair',
  'Incoming',
  'Affirmative',
  'Negative',
  'Nice shot',
];

/** Real browsers implement SpeechSynthesisUtterance; the client package's own unit tests run
 *  under Node (vite.config.ts: `test.environment: 'node'`), which has no such global.
 *  `typeof` is the one JS operator that never throws on an undeclared identifier, so this
 *  stays safe to evaluate there -- the fallback is only ever a plain `{ text }` holder a
 *  stubbed `speak` can read `.text` off of; every real browser takes the true branch. */
function createUtterance(text: string): SpeechSynthesisUtterance {
  if (typeof SpeechSynthesisUtterance === 'undefined') {
    return { text } as SpeechSynthesisUtterance;
  }
  return new SpeechSynthesisUtterance(text);
}

const NULL_SPEECH_SYNTHESIS: Pick<SpeechSynthesis, 'speak'> = { speak: () => undefined };

/** Same `typeof`-guard reasoning as `createUtterance` above: app.ts's event-drain path calls
 *  this with no explicit `speechSynthesis` argument, so the default has to evaluate safely
 *  under the client package's own Node-environment unit tests too, not just in a real
 *  browser -- `window` itself doesn't exist there. */
export function speakVoiceLine(
  lineId: number,
  speechSynthesis: Pick<SpeechSynthesis, 'speak'> = typeof window === 'undefined'
    ? NULL_SPEECH_SYNTHESIS
    : window.speechSynthesis,
): void {
  const text = VOICE_LINES[lineId];
  if (text === undefined) return;
  speechSynthesis.speak(createUtterance(text));
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
