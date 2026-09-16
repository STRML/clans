import { ARMORS, ArmorId, armorFor, type PlayerSnapshotData, type World } from '@clans/sim';
import * as THREE from 'three';
import './nameplates.css';

/**
 * IFF nameplates over teammates -- the design-spec HUD bullet "IFF names and health over
 * teammates" (docs/ISSUES.md's spec-delta list). Stock T2 floats a small team triangle, the
 * player's name, and a health bar over every living teammate; the marker bitmaps are
 * `hud_playertriangle.png` / `hud_enemytriangle.png` (docs/ui-audio-reference.md's HUD
 * structure list). Neither bitmap is committed under assets/out/katabatic/gui (that tree
 * carries only weapon reticles, vehicle icons and compass bits), and the t2ds source mirror
 * is dedicated-server scripts only -- there is no playGui.cs/hud.cs client HUD script there
 * to copy the marker draw from (the stock draw is engine-side). So the marker, name and bar
 * are built in DOM/CSS out of hud.css's own palette (nameplates.css), the way scoreboard.ts
 * already renders its roster overlay.
 *
 * Split exactly like the scoreboard: this module owns a pure model (`nameplateStates` and
 * the two input adapters, all unit-tested) and a pooled DOM renderer (`createNameplates`);
 * app.ts mounts the view on document.body and calls update() once per frame with
 * the camera pose the frame just drew with.
 *
 * One user-requested exception to the teammates-only rule above: the enemy under the
 * crosshair ("you should be able to see opponent health when you hover over it"). The health
 * is already client-visible -- the snapshot carries every player's `health` (sim/snapshot.ts's
 * serializePlayer) and the adapters below reduce it to a fraction -- and no new wire data or
 * input is needed, because the crosshair sits at the exact centre of the viewport
 * (index.html pins #crosshair at top/left 50%), which is the ray
 * `Raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)` already shoots in
 * base-object-view.ts's raycastAimedStructure. So `hoverEnemyState` takes that same centre
 * ray -- in camera space, where it is the -Z axis -- and reports the one living enemy inside
 * HOVER_RANGE_M whose body segment it passes within HOVER_BODY_RADIUS_M of;
 * `nameplateStates` appends that enemy's plates and `createNameplates` holds the plate back
 * until the enemy has stayed under the crosshair for HOVER_SUSTAIN_MS. Enemies still get no
 * plate of their own -- the hovered one gets a bar-only plate (no marker, no name) that
 * vanishes the frame the crosshair leaves it.
 */

/** Beyond this eye-to-player distance a teammate gets no plate. 300 m is the sensor's own
 *  detectRadius (sim/baseObjects.ts's BASE_OBJECT_DATA, the spec table's 300 m figure and
 *  the same radius commander-map.ts draws as the friendly-sensing abstraction): inside it a
 *  teammate is "sensed" everywhere in this game already, and outside it the commander map is
 *  the presentation that tracks them, not the world HUD. It also keeps the plate pool bounded
 *  on a 24-a-side map (mission area 1504 x 1392 m) without an off-screen plate ever being
 *  missed at readable size. */
export const NAMEPLATE_RANGE_M = 300;

/** Plate anchor height over a player's feet position. The heaviest armor's bounding box is
 *  2.6 m tall (sim/armor.ts), so 2.9 m clears every armor's head the way T2's marker floats
 *  a little above the model rather than intersecting it. */
export const NAMEPLATE_ANCHOR_M = 2.9;

/** Eye-to-anchor range for the crosshair-hover enemy plate. Shorter than the teammate plate's
 *  NAMEPLATE_RANGE_M: this plate is read while aiming at a specific opponent, so it belongs to
 *  the fight in front of you rather than to the 300 m sensing radius the commander map paints.
 *  200 m covers every engagement an infantry projectile crosses in a few seconds and keeps the
 *  bar off a distant speck. */
export const HOVER_RANGE_M = 200;

/** The crosshair counts as "over" an enemy when the ray through it passes within this distance
 *  of the enemy's vertical body axis. 0.6 m is half the LIGHT armor's own 1.2 m bounding box
 *  (`ARMORS[ArmorId.Light].boundingBox`, sim/armor.ts): the tightest of the three armors, so a
 *  heavier armor's wider shoulders are never missed, and no per-player armor extent has to ride
 *  the wire or the adapters for it. */
export const HOVER_BODY_RADIUS_M = 0.6;

/** How much of the body the crosshair ray is tested against: the full height of the heaviest
 *  armor's bounding box (2.6 m, sim/armor.ts). Testing the tallest body means a hit on a Light
 *  armor's feet still counts -- the ray crosses the segment above them. */
export const HOVER_BODY_HEIGHT_M = 2.6;

/** How long one enemy must stay under the crosshair before their plate is drawn. One frame of
 *  overlap is not a hover: a mouse sweep crosses the whole 90-degree fov in a few hundred
 *  milliseconds, so without the sustain a fast turn would flash a bar on every enemy it passed.
 *  100 ms is several frames at any playable rate and still far below the time a deliberate aim
 *  takes to settle. */
export const HOVER_SUSTAIN_MS = 100;

/** One candidate plate, already reduced to what the projection needs. Positions are the
 *  sim's feet position (world.players.position rows and PlayerSnapshotData x/y/z are all
 *  feet); the anchor height is added here, not by callers. */
export interface NameplatePlayerInput {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  /** health / armor max, in [0, 1] after the model clamps; the adapters derive it from the
   *  same armor-keyed arithmetic the wire itself uses (see each adapter's comment). */
  healthFraction: number;
  alive: boolean;
}

/** The slice of a placed THREE.PerspectiveCamera the projection reads. Structural rather
 *  than the class itself so tests can build a camera-shaped value and so the model never
 *  touches renderer-owned state beyond these three fields. `matrixWorldInverse` must be
 *  current for the frame (app.ts syncs plates right after renderer.render, which refreshes
 *  it; tests call camera.updateMatrixWorld()). */
export interface NameplateCameraInput {
  position: THREE.Vector3;
  matrixWorldInverse: THREE.Matrix4;
  projectionMatrix: THREE.Matrix4;
}

export interface NameplateViewport {
  width: number;
  height: number;
}

/** One plate the renderer should be showing this frame: screen-space CSS-pixel anchor
 *  (viewport coordinates, y down), the roster display name, and the bar fraction. */
export interface NameplateState {
  playerId: number;
  team: number;
  screenX: number;
  screenY: number;
  name: string;
  healthFraction: number;
  /** True only on the crosshair-hovered enemy's plate (`hoverEnemyState`); every teammate
   *  plate leaves it false. The name is empty on those plates -- the hovered enemy gets the
   *  bar alone -- and the renderer is the only reader, keying the CSS that drops the marker. */
  hover: boolean;
}

/** A projected plate anchor: viewport CSS pixels plus the eye-to-anchor distance the range
 *  culls use. Filled by `projectAnchor`, which takes it as an out-parameter so a per-frame
 *  scan over a full 24-a-side roster allocates nothing per candidate. */
interface ProjectedAnchor {
  x: number;
  y: number;
  distance: number;
}

/** Projects one player's plate anchor (feet + NAMEPLATE_ANCHOR_M) into viewport pixels.
 *  Camera-space work follows THREE's own project() decomposition (world -> camera via
 *  matrixWorldInverse, camera -> NDC via projectionMatrix, which divides by w), with the
 *  behind-the-camera test done in camera space first -- the camera looks down -Z there, so
 *  z >= 0 is behind the eye and its perspective divide would mirror the point across the
 *  screen. Returns false when the anchor is behind the eye or projects outside the viewport,
 *  the two culls both the teammate plates and the hover plate share. `eye` must be a scratch
 *  vector the caller owns: a full-roster scan would otherwise allocate one per candidate.
 *
 *  The camera-space length is the eye-to-anchor distance (the camera matrices are rigid), so
 *  `out.distance` is in metres and both range culls can read it. */
function projectAnchor(
  player: NameplatePlayerInput,
  camera: NameplateCameraInput,
  viewport: NameplateViewport,
  eye: THREE.Vector3,
  out: ProjectedAnchor,
): boolean {
  eye.set(player.x, player.y + NAMEPLATE_ANCHOR_M, player.z);
  eye.applyMatrix4(camera.matrixWorldInverse);
  if (eye.z >= 0) return false;
  out.distance = eye.length();
  eye.applyMatrix4(camera.projectionMatrix);
  if (Math.abs(eye.x) > 1 || Math.abs(eye.y) > 1) return false;
  out.x = (eye.x * 0.5 + 0.5) * viewport.width;
  out.y = (0.5 - eye.y * 0.5) * viewport.height;
  return true;
}

/** Distance, in metres, from the crosshair ray to a player's vertical body segment, or null
 *  when the segment's closest point to that ray is at or behind the eye plane. The crosshair
 *  ray is the origin of camera space along -Z (Raycaster.setFromCamera with a (0, 0) NDC
 *  point), so the distance from a camera-space point to the ray is its own horizontal length,
 *  and the closest point on the segment is one clamped quadratic solve -- no raycaster and no
 *  mesh to hit, which is what lets this model stay free of renderer-owned state. */
function crosshairBodyDistance(
  player: NameplatePlayerInput,
  camera: NameplateCameraInput,
  feet: THREE.Vector3,
  head: THREE.Vector3,
): number | null {
  feet.set(player.x, player.y, player.z).applyMatrix4(camera.matrixWorldInverse);
  head
    .set(player.x, player.y + HOVER_BODY_HEIGHT_M, player.z)
    .applyMatrix4(camera.matrixWorldInverse);
  const dx = head.x - feet.x;
  const dy = head.y - feet.y;
  const run = dx * dx + dy * dy;
  const t = run === 0 ? 0 : Math.min(1, Math.max(0, -(feet.x * dx + feet.y * dy) / run));
  const x = feet.x + t * dx;
  const y = feet.y + t * dy;
  if (feet.z + t * (head.z - feet.z) >= 0) return null;
  return Math.hypot(x, y);
}

/** The enemy the crosshair is over right now, or null. At most one plate can be hovered, so
 *  the scan keeps the closest body to the ray and lets a later enemy win a tie by a hair --
 *  the same "nearest wins" rule the eye reads naturally.
 *
 *  Enemies only: a teammate directly under the crosshair is already wearing a plate, and the
 *  local player is the eye itself. The culls are ordered cheapest-first, and the anchor
 *  projection runs last so an enemy whose plate would be off-screen (the anchor is 2.9 m over
 *  their feet) is never hovered -- there would be nothing on screen to draw the bar on. */
export function hoverEnemyState(
  players: readonly NameplatePlayerInput[],
  localPlayerId: number,
  localTeam: number,
  camera: NameplateCameraInput,
  viewport: NameplateViewport,
): NameplateState | null {
  const feet = new THREE.Vector3();
  const head = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const anchor: ProjectedAnchor = { x: 0, y: 0, distance: 0 };
  let hovered: NameplateState | null = null;
  let closest = HOVER_BODY_RADIUS_M;
  for (const player of players) {
    if (player.id === localPlayerId || !player.alive || player.team === localTeam) continue;
    const offset = crosshairBodyDistance(player, camera, feet, head);
    // No `>= 0` guard needed: the distance to the ray is never negative, so the null case is
    // the only "miss" the body test itself reports.
    if (offset === null || offset > closest) continue;
    if (!projectAnchor(player, camera, viewport, eye, anchor)) continue;
    if (anchor.distance > HOVER_RANGE_M) continue;
    closest = offset;
    hovered = {
      playerId: player.id,
      team: player.team,
      screenX: anchor.x,
      screenY: anchor.y,
      // Bar alone: T2 floats name and health over the enemy it has targeted, and the name is
      // the one part of that this HUD cannot claim -- enemies are deliberately nameless here
      // (the roster is the only name source, and naming every enemy from it would undo the
      // spec's teammates-only rule). So the hovered plate shows the health bar by itself.
      name: '',
      healthFraction: THREE.MathUtils.clamp(player.healthFraction, 0, 1),
      hover: true,
    };
  }
  return hovered;
}

/** Single-player adapter: reads the prediction world's own player arrays. Only the local
 *  player exists offline today, so in practice this yields nothing -- it is the same shape
 *  the networked adapter returns, so the frame loop needs no net/solo split for plates. */
export function teammatesFromWorld(world: World, localPlayerId: number): NameplatePlayerInput[] {
  const players = world.players;
  const out: NameplatePlayerInput[] = [];
  for (let id = 0; id < players.count; id += 1) {
    if (id === localPlayerId || players.active[id] !== 1) continue;
    const base = id * 3;
    out.push({
      id,
      team: players.team[id] ?? 0,
      x: players.position[base] ?? 0,
      y: players.position[base + 1] ?? 0,
      z: players.position[base + 2] ?? 0,
      // The snapshot's own health arithmetic (sim/snapshot.ts's serializePlayer):
      // health = armor maxDamage - damage, so the fraction over that same max is exact.
      healthFraction: 1 - (players.damage[id] ?? 0) / armorFor(world, id).maxDamage,
      alive: players.alive[id] === 1,
    });
  }
  return out;
}

/** Networked adapter: NetClient's remotePlayers already excludes the local connection (its
 *  own filter in handleSnapshot), so every entry is a candidate plate. */
export function teammatesFromSnapshots(
  players: Iterable<PlayerSnapshotData>,
): NameplatePlayerInput[] {
  return Array.from(players, (data) => {
    // The wire's health is absolute against the sending armor's max (serializePlayer), and
    // the armor id rides the snapshot, so the fraction is reconstructed the same way
    // netclient.ts's deserializePlayer inverts it. An out-of-range armor id falls back to
    // light armor rather than dividing by undefined.
    const maxDamage = (ARMORS[data.armor as ArmorId] ?? ARMORS[ArmorId.Light]).maxDamage;
    return {
      id: data.id,
      team: data.team,
      x: data.x,
      y: data.y,
      z: data.z,
      healthFraction: data.health / maxDamage,
      alive: data.health > 0,
    };
  });
}

/** Projects the living teammates in front of the camera into plates, plus the one enemy the
 *  crosshair is over (the bar-only hover plate, `hoverEnemyState`). Culls, in order: the
 *  local player themself, enemies (the spec line is teammates only -- an enemy's plate comes
 *  from the crosshair alone), the dead, anything behind the eye plane, anything past
 *  NAMEPLATE_RANGE_M, and anything projecting outside the viewport. */
export function nameplateStates(
  players: readonly NameplatePlayerInput[],
  localPlayerId: number,
  localTeam: number,
  names: ReadonlyMap<number, string>,
  camera: NameplateCameraInput,
  viewport: NameplateViewport,
): NameplateState[] {
  const states: NameplateState[] = [];
  const eye = new THREE.Vector3();
  const anchor: ProjectedAnchor = { x: 0, y: 0, distance: 0 };
  for (const player of players) {
    if (player.id === localPlayerId || !player.alive) continue;
    if (player.team !== localTeam) continue;
    if (!projectAnchor(player, camera, viewport, eye, anchor)) continue;
    if (anchor.distance > NAMEPLATE_RANGE_M) continue;
    states.push({
      playerId: player.id,
      team: player.team,
      screenX: anchor.x,
      screenY: anchor.y,
      // The server's Roster message carries every display name (netclient.roster), so a
      // missing name is a one-frame race between a snapshot and a roster broadcast; the
      // plate shows `P<id>` for that frame rather than blanking.
      name: names.get(player.id) ?? `P${String(player.id)}`,
      // Clamp >= 0 so an overkill snapshot (negative health) never renders a negative bar;
      // the upper clamp is presentation insurance, the sim has no over-health.
      healthFraction: THREE.MathUtils.clamp(player.healthFraction, 0, 1),
      hover: false,
    });
  }
  const hovered = hoverEnemyState(players, localPlayerId, localTeam, camera, viewport);
  if (hovered) states.push(hovered);
  return states;
}

/** How long one enemy has been under the crosshair, as the view's own clock sees it.
 *  `playerId` is null while nothing is hovered; `sinceMs` is the time the current id first
 *  appeared under the crosshair -- a new id restarts it, so sweeping from one enemy to the
 *  next cannot inherit the previous enemy's dwell. */
export interface HoverDwell {
  playerId: number | null;
  sinceMs: number;
}

/** The dwell of a crosshair that is on nothing: also the view's initial state. */
export const HOVER_DWELL_IDLE: HoverDwell = { playerId: null, sinceMs: 0 };

/** Advances the sustain timer by one frame's worth of hover: the reducer that turns a
 *  per-frame hit test into the "sustained moment" the hover plate is for. Pure and clock-free
 *  -- the caller passes the frame time -- so the 100 ms rule is unit-testable without a
 *  running renderer. */
export function hoverDwell(
  previous: HoverDwell,
  hoveredId: number | null,
  nowMs: number,
): HoverDwell {
  if (hoveredId === null) {
    return previous.playerId === null ? previous : HOVER_DWELL_IDLE;
  }
  if (previous.playerId === hoveredId) return previous;
  return { playerId: hoveredId, sinceMs: nowMs };
}

/** Whether the dwell has lasted long enough to draw the hover plate. Reads the same frame
 *  time `hoverDwell` was advanced with, so a plate can be held back on its first frames and
 *  drawn from the frame the dwell crosses HOVER_SUSTAIN_MS onwards. */
export function hoverSettled(
  dwell: HoverDwell,
  nowMs: number,
  sustainMs = HOVER_SUSTAIN_MS,
): boolean {
  return dwell.playerId !== null && nowMs - dwell.sinceMs >= sustainMs;
}

export interface NameplatesView {
  /** Draws this frame's plates: the teammates in `states`, plus the one enemy plate in
   *  `states` carrying `hover: true` -- and only once that enemy has been under the crosshair
   *  for HOVER_SUSTAIN_MS (the view owns that timer, `hoverDwell`). A hover plate is dropped
   *  the frame its enemy leaves the crosshair, so it disappears with the aim. */
  update(states: readonly NameplateState[]): void;
}

/** Builds one plate's DOM once: marker over name over bar, in scoreboard row style --
 *  createElement/textContent, never innerHTML. */
function createPlate(): HTMLElement {
  const plate = document.createElement('div');
  plate.className = 'nameplate';
  const marker = document.createElement('div');
  marker.className = 'nameplate-marker';
  const name = document.createElement('div');
  name.className = 'nameplate-name';
  const health = document.createElement('div');
  health.className = 'nameplate-health';
  const fill = document.createElement('div');
  fill.className = 'nameplate-health-fill';
  health.appendChild(fill);
  plate.append(marker, name, health);
  return plate;
}

/** Writes one frame's worth of state onto a pooled plate element: position, team, hover flag,
 *  name and bar. Only the values that changed are touched -- a moving plate rewrites its
 *  transform, everything else waits for a value to differ (the scoreboard's own diff, one
 *  plate at a time). */
function syncPlate(plate: HTMLElement, state: NameplateState): void {
  // The anchor sits just over the head; the second translate centers the plate on it.
  plate.style.transform = `translate(${state.screenX.toFixed(1)}px, ${state.screenY.toFixed(1)}px) translate(-50%, 0)`;
  const team = String(state.team);
  if (plate.dataset['team'] !== team) plate.dataset['team'] = team;
  // The flag nameplates.css keys the bar-only shape off: no marker, no name.
  const hovered = state.hover ? 'true' : '';
  if ((plate.dataset['hover'] ?? '') !== hovered) plate.dataset['hover'] = hovered;
  const name = plate.querySelector<HTMLElement>('.nameplate-name');
  if (name && name.textContent !== state.name) name.textContent = state.name;
  const fill = plate.querySelector<HTMLElement>('.nameplate-health-fill');
  const width = `${(state.healthFraction * 100).toFixed(1)}%`;
  if (fill && fill.style.width !== width) fill.style.width = width;
}

/** Draws one frame of plates from the pool: a plate is built the first time its player is
 *  drawn, reused while they are (`syncPlate`), and removed the frame they are not -- a
 *  teammate who died, left, or walked out of range, and the hovered enemy the moment the
 *  crosshair is off them. `showHover` is the settled hover plate's player id, or null when
 *  the sustain has not elapsed and no hover plate should be on screen this frame. */
function syncPlates(
  states: readonly NameplateState[],
  showHover: number | null,
  pool: Map<number, HTMLElement>,
  root: HTMLElement,
): void {
  const shown = new Set<number>();
  for (const state of states) {
    // The hover plate waits out the sustain; the model's teammates never do.
    if (state.hover && state.playerId !== showHover) continue;
    shown.add(state.playerId);
    let plate = pool.get(state.playerId);
    if (!plate) {
      plate = createPlate();
      pool.set(state.playerId, plate);
      root.appendChild(plate);
    }
    syncPlate(plate, state);
  }
  for (const [id, plate] of pool) {
    if (!shown.has(id)) {
      plate.remove();
      pool.delete(id);
    }
  }
}

/** The pooled plate renderer. Elements are keyed by player id and reused across frames --
 *  a moving teammate rewrites one transform (plus name/bar only when the value changed),
 *  never tears down DOM; a plate only leaves the pool when its player dies or leaves, the
 *  same rebalance the scoreboard's roster diff makes.
 *
 *  `now` is the frame clock the hover sustain is measured against; injectable so a test can
 *  step it, defaulting to the same performance.now the frame loop itself is timed with. */
export function createNameplates(
  container: HTMLElement,
  now: () => number = () => performance.now(),
): NameplatesView {
  const root = document.createElement('div');
  root.id = 'nameplates';
  container.appendChild(root);
  const pool = new Map<number, HTMLElement>();
  let dwell = HOVER_DWELL_IDLE;
  return {
    update(states) {
      const nowMs = now();
      // nameplateStates appends at most one hover plate; the view is the only place that knows
      // how long it has been there, because only the view has a frame clock.
      const hoverId = states.findLast((state) => state.hover)?.playerId ?? null;
      dwell = hoverDwell(dwell, hoverId, nowMs);
      syncPlates(states, hoverSettled(dwell, nowMs) ? hoverId : null, pool, root);
    },
  };
}
