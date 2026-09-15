/** The two teams' display names. Source of truth: the committed comparison evidence --
 *  docs/ui-audio-reference.md's infantry reference frames (RAWG, PlayT2), whose two-row
 *  flag tables read Storm and Inferno in that row order; classic Tribes 2 CTF runs these
 *  two communities as its standard teams. Katabatic's own mission file is not in either
 *  game-data dump, so the rows' order against our team ids 1 and 2 is the evidence, not a
 *  script constant. Unknown team ids keep the generic label. */
const TEAM_NAMES: Record<number, string> = { 1: 'Storm', 2: 'Inferno' };

export function teamName(team: number): string {
  return TEAM_NAMES[team] ?? `Team ${String(team)}`;
}
