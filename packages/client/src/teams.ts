/** The two teams' display names. Inferred from the committed comparison evidence --
 *  docs/ui-audio-reference.md's infantry reference frames (RAWG, PlayT2), whose two-row
 *  flag tables read Storm and Inferno in that row order, matching classic Tribes 2 CTF's
 *  two standard communities. This is an INFERENCE, stated as one: the frames are
 *  medium-confidence and the map in them is not confirmed to be Katabatic; Katabatic's own
 *  mission file is not in either game-data dump, so no script constant exists to cite and
 *  the rows' order against our team ids 1 and 2 is the whole evidence. If a mission file
 *  with real teamName fields ever surfaces, replace this mapping with it. Unknown team ids
 *  keep the generic label. */
const TEAM_NAMES: Record<number, string> = { 1: 'Storm', 2: 'Inferno' };

export function teamName(team: number): string {
  return TEAM_NAMES[team] ?? `Team ${String(team)}`;
}
