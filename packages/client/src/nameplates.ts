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
 * app.ts mounts the view on document.body and calls update() once per rendered frame with
 * the camera pose the frame just drew with.
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

/** Projects the living teammates in front of the camera into plates. Culls, in order: the
 *  local player themself, enemies (the spec line is teammates only -- enemies stay nameless
 *  on the world HUD exactly as in T2), the dead, anything behind the eye plane, anything
 *  past NAMEPLATE_RANGE_M, and anything projecting outside the viewport. Camera-space work
 *  follows THREE's own project() decomposition (world -> camera via matrixWorldInverse,
 *  camera -> NDC via projectionMatrix, which divides by w), with the behind-the-camera test
 *  done in camera space first -- the camera looks down -Z there, so z >= 0 is behind the
 *  eye and its perspective divide would mirror the plate across the screen. */
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
  for (const player of players) {
    if (player.id === localPlayerId || !player.alive) continue;
    if (player.team !== localTeam) continue;
    eye
      .set(player.x, player.y + NAMEPLATE_ANCHOR_M, player.z)
      .applyMatrix4(camera.matrixWorldInverse);
    // Camera matrices are rigid, so the camera-space length is the eye-to-player distance.
    if (eye.z >= 0 || eye.length() > NAMEPLATE_RANGE_M) continue;
    eye.applyMatrix4(camera.projectionMatrix);
    if (Math.abs(eye.x) > 1 || Math.abs(eye.y) > 1) continue;
    states.push({
      playerId: player.id,
      team: player.team,
      screenX: (eye.x * 0.5 + 0.5) * viewport.width,
      screenY: (0.5 - eye.y * 0.5) * viewport.height,
      // The server's Roster message carries every display name (netclient.roster), so a
      // missing name is a one-frame race between a snapshot and a roster broadcast; the
      // plate shows `P<id>` for that frame rather than blanking.
      name: names.get(player.id) ?? `P${String(player.id)}`,
      // Clamp >= 0 so an overkill snapshot (negative health) never renders a negative bar;
      // the upper clamp is presentation insurance, the sim has no over-health.
      healthFraction: Math.min(1, Math.max(0, player.healthFraction)),
    });
  }
  return states;
}

export interface NameplatesView {
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

/** The pooled plate renderer. Elements are keyed by player id and reused across frames --
 *  a moving teammate rewrites one transform (plus name/bar only when the value changed),
 *  never tears down DOM; a plate only leaves the pool when its player dies or leaves, the
 *  same rebalance the scoreboard's roster diff makes. */
export function createNameplates(container: HTMLElement): NameplatesView {
  const root = document.createElement('div');
  root.id = 'nameplates';
  container.appendChild(root);
  const pool = new Map<number, HTMLElement>();
  return {
    update(states) {
      const shown = new Set<number>();
      for (const state of states) {
        shown.add(state.playerId);
        let plate = pool.get(state.playerId);
        if (!plate) {
          plate = createPlate();
          pool.set(state.playerId, plate);
          root.appendChild(plate);
        }
        // The anchor sits just over the head; the second translate centers the plate on it.
        plate.style.transform = `translate(${state.screenX.toFixed(1)}px, ${state.screenY.toFixed(1)}px) translate(-50%, 0)`;
        const team = String(state.team);
        if (plate.dataset['team'] !== team) plate.dataset['team'] = team;
        const name = plate.querySelector<HTMLElement>('.nameplate-name');
        if (name && name.textContent !== state.name) name.textContent = state.name;
        const fill = plate.querySelector<HTMLElement>('.nameplate-health-fill');
        const width = `${(state.healthFraction * 100).toFixed(1)}%`;
        if (fill && fill.style.width !== width) fill.style.width = width;
      }
      for (const [id, plate] of pool) {
        if (!shown.has(id)) {
          plate.remove();
          pool.delete(id);
        }
      }
    },
  };
}
