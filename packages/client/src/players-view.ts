import * as THREE from 'three';
import { ArmorId, FIXED_TICK_MS, type PlayerSnapshotData } from '@clans/sim';
import { playerModelUrl } from './assets.js';
import { poseShape } from './shape-animation.js';
import { disposeShape, loadShapeFrom } from './shape-loader.js';
import type { RemotePose } from './remote.js';

/**
 * Remote players, drawn as the shipped T2 armour models instead of the blue capsule this
 * module replaces. Every reference below is to github.com/tribes2/engine (the 2001 V12 drop
 * T2 shipped from) or to the armour datablocks the sim already transcribes
 * (`packages/sim/src/armor.ts`, whose provenance note names `scripts/player.cs`,
 * LightMaleHumanArmor :1195 / MediumMaleHumanArmor :1461 / HeavyMaleHumanArmor :1714, and
 * `shapeFile = "light_male.dts"` et al).
 *
 * The models are rigid-node hierarchies, not skinned meshes: `light_male.dts` carries no
 * skinned mesh and no movement sequences at all, only the `Bip01 ...` node tree with body
 * parts (`Submesh_pelvis`, `Submesh_head`, ...) parented to those nodes. Every clip is an
 * external `.dsq` sequence that animates NODE transforms, which is why playback here is
 * `poseShape`'s seek-by-time -- the same convention vehicle-view.ts already uses -- and why
 * no vertex skinning appears anywhere in this file.
 */

/** The biped each ArmorId wears. The sim's three datablocks are the three bodies whose
 *  `shapeFile` names them (armor.ts's provenance note above); anything else -- a snapshot
 *  from a newer server, a corrupted armour byte -- wears Light, matching armor.ts's own
 *  `ARMORS[... ?? ArmorId.Light]` default rather than rendering nothing. */
const PLAYER_BODY: Record<ArmorId, string> = {
  [ArmorId.Light]: 'light_male',
  [ArmorId.Medium]: 'medium_male',
  [ArmorId.Heavy]: 'heavy_male',
};

export function playerBodyFor(armor: number): string {
  return PLAYER_BODY[armor as ArmorId] ?? PLAYER_BODY[ArmorId.Light];
}

// --- Clip names -------------------------------------------------------------------------
// Every name below is the `.dsq` suffix verbatim, which is the name the shape's own sequence
// list carries. `PlayerData::preload` resolves three of them by name off that list rather
// than by index -- `look`, `ski` and `standjump` (player.cc:307-317) -- and the action table
// names seven more (player.cc:120-139), so a clip name here is a name the engine would also
// find. The `cel*` (emote) and `look*` sets are deliberately unused: no snapshot field
// selects them.

/** At rest, and the fallback for any clip a model does not carry: `RootAnim` is index 0 of
 *  `PlayerData::ActionAnimationList` and the state `pickActionAnimation` returns to whenever
 *  nothing else applies (player.cc:2276, 2301-2303). */
export const ROOT_CLIP = 'root';
/** The one death clip this client prefers. T2 ships eleven (`dieback`, `diechest`,
 *  `dieforward`, `diehead`, `dieknees`, `dieleglf`, `dielegrt`, `diesidelf`, `diesidert`,
 *  `dieslump`, `diespin`) and the retail scripts choose between them by hit location, which
 *  the snapshot does not carry: `PlayerSnapshotData` reports health and nothing about where
 *  the damage landed. `dieslump` is the one that reads as a plain collapse with no direction
 *  or limb claim, so it is the honest constant here. */
export const DIE_CLIP = 'dieslump';
/** What a body that does not carry `DIE_CLIP` collapses with instead, in preference order.
 *  The bodies do not ship the same subset: the emitted `medium_male.glb` carries nine of the
 *  eleven die clips and has no `dieslump` at all. A corpse is worth more than the exact clip
 *  -- the alternative is `resolvedClip` falling through to root and leaving the player
 *  standing -- so the view walks this list and takes the first one its model has. */
const DEATH_CLIP_FALLBACKS = [
  'dieback',
  'diechest',
  'dieforward',
  'diehead',
  'dieknees',
  'dieleglf',
  'dielegrt',
  'diesidelf',
  'diesidert',
  'diespin',
] as const;
export const LAND_CLIP = 'land';
export const SKI_CLIP = 'ski';
export const JET_CLIP = 'jet';
export const FALL_CLIP = 'fall';
export const FORWARD_CLIP = 'forward';
export const BACK_CLIP = 'back';
export const SIDE_CLIP = 'side';
export const JUMP_CLIP = 'jump';
/** The jump a standstill produces. `standjumpAction` is resolved by name at preload
 *  (player.cc:307-317) and selected in updateMove's jump block by the speed the player had
 *  when the impulse fired (player.cc:1734-1742). */
export const STANDING_JUMP_CLIP = 'standjump';

/** Downward velocity at which the engine stops holding the jump pose and calls the player
 *  falling: `sFallingThreshold = -10` (player.cc:78), tested as `mFalling = vel.z <
 *  sFallingThreshold` and consumed first by `pickActionAnimation` (player.cc:2281-2285). */
const FALLING_THRESHOLD = -10;
/** `sStandingJumpSpeed = 2.0` (player.cc:66): above it a jump plays JumpAnim, at or below it
 *  `standJumpAction` (player.cc:1736-1739). Read against the horizontal speed of the same
 *  sample, which the jump impulse does not change. */
const STANDING_JUMP_SPEED = 2;
/** `pickActionAnimation`'s velocity floor for choosing a movement clip at all:
 *  `F32 curMax = 0.1` (player.cc:2305). Below it the player is RootAnim. */
const MOVE_EPSILON = 0.1;
/** The impact speed a landing needs before the engine puts the player in its recover state,
 *  the only place LandAnim is ever set: `if (bd > mDataBlock->minImpactSpeed && ...)
 *  setState(RecoverState, recover)` (player.cc:2688-2701). T2's player.cs sets
 *  `minImpactSpeed = 45` for every armor (armor.ts's provenance note; damage.ts's
 *  applyFallDamage cites the same script value as the fall-damage threshold). An impact
 *  below it leaves the jump/fall pose alone -- which is what keeps a ski hop, landing every
 *  second or so, from living in the landing pose. */
const LAND_IMPACT_SPEED = 45;
/** `recoverDelay = 30` (PlayerData::Player, player.cc:171) -- the recover window's length in
 *  the engine's 32 ms ticks, which is exactly this sim's FIXED_TICK_MS. */
const RECOVER_DELAY_TICKS = 30;
/** Spread between two players running the same body, so a squad does not march in lockstep.
 *  The clip phase is a free-running clock (see clipSeconds); this offsets it per id by a
 *  fraction of the longest movement cycle in the shipped set. */
const PHASE_SPREAD_MS = 370;

/** How long a corpse stays on the field, at minimum. T2's own corpse timeout is far longer --
 *  `$CorpseTimeoutValue = 22 * 1000` (scripts/player.cs:16), faded over its last second and
 *  then `schedule($CorpseTimeoutValue, "delete")`d in `Armor::onDisabled`
 *  (player.cs:2076-2082) -- but a corpse here cannot outlive the id that owns it: this sim
 *  respawns a dead player 5 s later (RESPAWN_TICKS, damage.ts) into the SAME player id and so
 *  the same PlayerView, and the body has to be off the field before its owner walks back on at
 *  their spawn point. 4 s sits just inside that window.
 *
 *  It is a floor and not the whole rule: the collapse this hold is holding is the body's own
 *  animation (see corpseFor), and those run longer than 4 s on some bodies -- medium_male's
 *  dieback is 4.23 s and its diechest 5.37 s -- so cutting the corpse off on a fixed 4 s would
 *  delete the body in the middle of its own fall, which is the "players vanish on death" this
 *  effect exists to fix. */
export const CORPSE_HOLD_MS = 4000;
/** How long the fallback topple takes, for the corpses that have no collapse of their own to
 *  play (the capsule stand-in, and any model shipping no usable die clip). Ours: a body takes
 *  a bit under a second to fall over, and 700 ms reads as a fall rather than a snap. */
const CORPSE_TOPPLE_MS = 700;
/** The angle that fallback topple turns through: a quarter turn, which lays a standing body
 *  flat. It is applied to the view root, whose rotation order is 'YXZ', so it turns about the
 *  body's own lateral axis (after the yaw) and the body falls along the way it was facing. */
const CORPSE_TOPPLE_RAD = Math.PI / 2;
/** How far a fallen corpse settles into the terrain, in metres. Applied to the root, i.e.
 *  straight down along world Y (the root's own axes are the world's), which is what keeps the
 *  body from hanging over the downslope side of the ridge it died on. A few centimetres: more
 *  than that and a body that already lies flat starts sinking visibly into the snow. */
const CORPSE_SINK_M = 0.08;

/** Everything the clip choice reads, all of it derived from a `PlayerSnapshotData` plus the
 *  three edges a snapshot alone cannot carry (a landing's impact speed, how long ago it
 *  happened, and the previous sample's vertical speed). Kept as a plain interface so
 *  `clipFor` stays pure and testable without three.js. */
export interface PlayerAnimState {
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  onGround: 0 | 1;
  ski: 0 | 1;
  health: number;
  /** The previous sample's vertical speed, which is what tells thrust from a jump arc: see
   *  the jet branch of airborneClip. */
  previousVy: number;
  /** Whether the previous sample was airborne. The landing itself must not read as thrust
   *  (vy climbs from 0 to the impulse's 8.3 m/s in one sample), so the takeoff sample is
   *  excluded from that test. */
  wasAirborne: boolean;
  /** Milliseconds since this player touched down, Infinity when they have been grounded
   *  since the first sample seen or are airborne now. */
  msGrounded: number;
  /** Downward speed (positive) at that touchdown, 0 when there was none. */
  touchdownVy: number;
}

/**
 * `pickActionAnimation`'s movement selection (player.cc:2301-2321) read against a snapshot:
 * the velocity is projected into the player's own frame and the largest component above the
 * 0.1 m/s floor wins, with root when nothing clears it. The frame is the sim's own -- `Forward
 * is (sin yaw, 0, cos yaw)`, `Right is forward x up = (-cos yaw, 0, sin yaw)`
 * (movement.ts:116-121) -- so `forward` is the speed along the facing the sim steers by and
 * `side` the strafe speed. The engine also MIRRORS one side animation for the other direction
 * (`forward = false`, player.cc:2310-2316) instead of shipping a second clip; this client has
 * one `side` clip and no mirroring, so both directions land on it -- the pose is right, its
 * arms and legs are simply not swapped.
 */
function movementClip(state: PlayerAnimState): string {
  const forward = state.vx * Math.sin(state.yaw) + state.vz * Math.cos(state.yaw);
  const side = -state.vx * Math.cos(state.yaw) + state.vz * Math.sin(state.yaw);
  let best = MOVE_EPSILON;
  let clip = ROOT_CLIP;
  if (forward > best) {
    best = forward;
    clip = FORWARD_CLIP;
  }
  if (-forward > best) {
    best = -forward;
    clip = BACK_CLIP;
  }
  if (Math.abs(side) > best) clip = SIDE_CLIP;
  return clip;
}

/** The airborne half of the state machine. `pickActionAnimation` tests `mFalling` first
 *  (player.cc:2281-2285), so a hard fall outranks everything else; the engine otherwise
 *  holds the jump thread it set on the impulse for the whole arc (it is cleared by running
 *  on the ground again, player.cc:1706-1708, not by the descent), which is why the jump and
 *  standing-jump clips cover the descent too.
 *
 *  `jet` is the one clip here the engine's own tables never name -- the leaked Player has no
 *  jet code at all (movement.ts:228-231 records that the jet is a behavioral model this
 *  project wrote from the scripts, which do carry jet knobs: `maxJetHorizontalPercentage`,
 *  `maxJetForwardSpeed`). What the snapshot CAN show is thrust beating gravity: the sim adds
 *  `jetForce / mass` upward every tick while the trigger is held and charged
 *  (movement.ts:280-283, 26.21 m/s^2 for Light against GRAVITY = 20), and nothing else in
 *  flight ever adds vertical speed. A rising vertical speed on an already-airborne sample is
 *  therefore a jet firing and not a jump, whose own arc only ever decelerates. */
function airborneClip(state: PlayerAnimState): string {
  if (state.wasAirborne && state.vy < FALLING_THRESHOLD) return FALL_CLIP;
  if (state.wasAirborne && state.vy > state.previousVy) return JET_CLIP;
  return Math.hypot(state.vx, state.vz) > STANDING_JUMP_SPEED ? JUMP_CLIP : STANDING_JUMP_CLIP;
}

/**
 * The recover window a landing at `touchdownVy` (positive downward, m/s) opens, in
 * milliseconds: `recoverDelay` ticks scaled down linearly to a single tick for an impact
 * inside the first `minImpactSpeed * 0.9` above the threshold (player.cc:2692-2701). Zero
 * means the landing was too soft to be a recover state at all, which is the common case in
 * this game -- a ski hop lands far below 45 m/s and must keep its ski/run pose.
 */
export function landHoldMs(touchdownVy: number): number {
  if (touchdownVy <= LAND_IMPACT_SPEED) return 0;
  const range = LAND_IMPACT_SPEED * 0.9;
  const value = touchdownVy - LAND_IMPACT_SPEED;
  const ticks =
    value < range ? 1 + Math.floor((RECOVER_DELAY_TICKS * value) / range) : RECOVER_DELAY_TICKS;
  return ticks * FIXED_TICK_MS;
}

/**
 * The clip a remote player is showing, given only what a snapshot can tell us. Pure and
 * three.js-free so every boundary in it is unit-testable.
 *
 * Dead first: the engine only picks action animations in its Move state
 * (`if (mState != MoveState || mDamageState != Enabled) return;`, player.cc:2270-2271), so a
 * dead player's clip is whatever death sequence was set and never one of these.
 */
export function clipFor(state: PlayerAnimState): string {
  if (state.health <= 0) return DIE_CLIP;
  if (state.onGround) {
    if (state.msGrounded <= landHoldMs(state.touchdownVy)) return LAND_CLIP;
    // `players.ski[id] = ctx.skiing` (movement.ts:440) is the datablock's own ski state, and
    // the engine resolves the sequence by that exact name ("ski", player.cc:307-317).
    return state.ski ? SKI_CLIP : movementClip(state);
  }
  return airborneClip(state);
}

/** What one frame of a corpse presentation is: whether the body is on the field at all, the
 *  tilt its root carries, and how far it has settled into the ground. */
export interface CorpseFrame {
  visible: boolean;
  tilt: number;
  sink: number;
}

/**
 * The corpse a dead player leaves behind, `sinceDeathMs` after the death edge. `collapseS` is
 * how long the body's own collapse animation runs, 0 when it has none to run (see the view's
 * collapseSeconds). Pure and three.js-free, like clipFor/landHoldMs above, so every boundary
 * here is unit-testable.
 *
 * The topple is normally the body's own animation. Every emitted armour carries the eleven
 * `die*` sequences this file names, and their own tracks take the body to the ground: on
 * `light_male.glb`, `dieslump` drives `Bip01 Pelvis` from 1.227 m down to 0.159 m and the model
 * from 2.30 m standing to 0.88 m at its end frame (measured off the emitted GLB through the
 * same three AnimationMixer these clips are played on; `medium_male`'s `dieback` ends at
 * 0.86 m and `heavy_male`'s `dieslump` at 1.64 m, and all three already put part of the body
 * just below grade -- down to -0.18 m on light -- without any help from this file). A view that
 * added a quarter turn of its own on top of that would compound two falls and push the
 * shoulder line roughly a metre under the terrain, so `tilt` and `sink` both stay 0 whenever
 * the body has a collapse to play.
 *
 * It is a fallback for the bodies that have none: the capsule stand-in, which exists while a
 * model is in flight and forever if one never arrives, and any model that ships no usable die
 * clip. Both would otherwise spend their whole hold standing upright, so the root itself
 * topples, at CORPSE_TOPPLE_MS and CORPSE_SINK_M below.
 */
export function corpseFor(sinceDeathMs: number, collapseS: number): CorpseFrame {
  if (sinceDeathMs >= Math.max(CORPSE_HOLD_MS, collapseS * 1000)) {
    return { visible: false, tilt: 0, sink: 0 };
  }
  if (collapseS > 0) return { visible: true, tilt: 0, sink: 0 };
  const fall = Math.min(1, Math.max(0, sinceDeathMs) / CORPSE_TOPPLE_MS);
  return { visible: true, tilt: fall * CORPSE_TOPPLE_RAD, sink: fall * CORPSE_SINK_M };
}

// --- The per-player view -----------------------------------------------------------------

/** The capsule the player model replaces, kept as the loading and failure fallback: while
 *  the GLB is in flight, and permanently if it never arrives. Geometry and colors are the
 *  ones remote.ts used before this change, so a failed model load looks exactly like the
 *  previous milestone. */
function createCapsule(): THREE.Mesh {
  const geometry = new THREE.CapsuleGeometry(0.6, 1.2, 4, 8);
  const material = new THREE.MeshStandardMaterial({ color: 0x4488ff });
  const mesh = new THREE.Mesh(geometry, material);
  // The root stands at the player's feet (the biped model's own origin is there), so the
  // capsule keeps the old world placement as a local offset: its center sits half a height
  // plus a radius above the feet, and a half turn puts its (irrelevant, it is a capsule)
  // facing where the shipped code had it.
  mesh.position.y = 1.2 / 2 + 0.6;
  mesh.rotation.y = Math.PI;
  mesh.castShadow = true;
  return mesh;
}

/**
 * One remote player: a root at their feet carrying the capsule fallback and, once it loads,
 * the armour model with its clips. The root's yaw is the client's own convention, the same
 * one `placeVehicleMesh` and the Shrike heading spec in e2e/shrike-spawn.spec.ts assume: model
 * forward is +Z, so `rotation.y = yaw` alone aims it. Measured on the emitted
 * `players/light_male.glb` rather than assumed -- its `Eye`/`Cam` nodes sit at z = +0.17 and
 * its `Jetnozzle0` at z = -0.19, its bbox low point is y = -0.01 (the feet are the origin, so
 * the root needs no vertical offset) and it stands 2.30 m tall, which is armor.ts's own
 * bounding box height for Light (2.3). No extra yaw offset belongs here.
 */
export class PlayerView {
  readonly root = new THREE.Group();
  private readonly capsule = createCapsule();
  private body = '';
  private holder: THREE.Group | null = null;
  /** Clip name (lowercase, as glTF keeps it) to length in seconds, captured at load: the
   *  clip phase needs the length to wrap a cycle, and `poseShape` clamps rather than wraps. */
  private readonly durations = new Map<string, number>();
  private previous: PlayerSnapshotData | null = null;
  private landedAtMs = Number.NEGATIVE_INFINITY;
  private touchdownVy = 0;
  /** When this player's current death was seen (ms on the caller's clock), or -Infinity while
   *  they are alive. The death latch is the one piece of state both the death clip and the
   *  corpse read: `clipSeconds` runs the collapse from it, and `applyCorpse` ages the body
   *  from it, so the two can never disagree about when this player died. */
  private diedAtMs = Number.NEGATIVE_INFINITY;

  constructor(readonly id: number) {
    this.root.name = `player-${String(id)}`;
    // The corpse's fallback topple (corpseFor) turns the root about the body's own lateral
    // axis; with the default 'XYZ' order that x rotation would be applied BEFORE the yaw and
    // so would always tip toward world -z instead of along whichever way the body was facing.
    this.root.rotation.order = 'YXZ';
    this.root.add(this.capsule);
  }

  /** Place, redress, and pose one interpolated sample. `pose` comes from RemoteBuffer, the
   *  same interpolation the capsule used; `sample` is that buffer's newest raw sample, whose
   *  discrete fields (armour, onGround, ski, health, velocity) are never blended.
   *
   *  `previous` is captured before the latches move: the clip choice needs the sample this
   *  one is compared against (takeoff, thrust, landing edge, death edge), and `observe` is
   *  what replaces it with this sample. */
  sync(sample: PlayerSnapshotData, pose: RemotePose, nowMs: number): void {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.y = pose.yaw;
    this.ensureBody(playerBodyFor(sample.armor));
    const previous = this.previous;
    this.observe(sample, previous, nowMs);
    this.pose(sample, previous, nowMs);
    // After pose, not before: this one moves the root the pose was drawn in.
    this.applyCorpse(sample, nowMs);
  }

  dispose(): void {
    this.dropModel();
    this.capsule.geometry.dispose();
    (this.capsule.material as THREE.Material).dispose();
    this.root.clear();
  }

  /** The two edges the mapping cannot read from a single sample: when this player last
   *  touched down (and how hard), and when they died. */
  private observe(
    sample: PlayerSnapshotData,
    previous: PlayerSnapshotData | null,
    nowMs: number,
  ): void {
    if (previous && previous.onGround === 0 && sample.onGround === 1) {
      this.landedAtMs = nowMs;
      this.touchdownVy = Math.max(0, -previous.vy);
    }
    if (sample.health <= 0 && this.deathEdge(sample, previous)) this.diedAtMs = nowMs;
    this.previous = sample;
  }

  /** Everything that counts as "this player's death starts here", and nothing else: the
   *  alive-to-dead health edge, the first sample this view ever sees of a player who was
   *  already dead (a client that joined mid-death -- there is no earlier sample to compare
   *  against), and a respawn sequence that moved while health stayed at 0, which is a second
   *  death landing entirely between two snapshots this client received. respawnSeq is the
   *  wire's own authoritative death counter -- damage.ts's respawnPlayer is the only writer,
   *  and netclient.ts already reads it for exactly this reason -- so the second death restarts
   *  the collapse and re-arms the corpse instead of inheriting the first corpse's clock.
   *
   *  Latching on the edge is also what makes the effect one-per-death: every later sample of
   *  the same death has previous.health <= 0 and a respawnSeq that matches, so none of the
   *  three arms fires again. */
  private deathEdge(sample: PlayerSnapshotData, previous: PlayerSnapshotData | null): boolean {
    if (!previous || previous.health > 0) return true;
    return previous.respawnSeq !== sample.respawnSeq;
  }

  private animState(
    sample: PlayerSnapshotData,
    previous: PlayerSnapshotData | null,
    nowMs: number,
  ): PlayerAnimState {
    return {
      vx: sample.vx,
      vy: sample.vy,
      vz: sample.vz,
      yaw: sample.yaw,
      onGround: sample.onGround,
      ski: sample.ski,
      health: sample.health,
      // A player seen for the first time has nothing to compare against: its own velocity
      // reads as "not thrusting" and it counts as airborne only from the next sample on.
      previousVy: previous ? previous.vy : sample.vy,
      wasAirborne: previous ? previous.onGround === 0 : false,
      msGrounded: sample.onGround ? nowMs - this.landedAtMs : Number.POSITIVE_INFINITY,
      touchdownVy: this.touchdownVy,
    };
  }

  private pose(
    sample: PlayerSnapshotData,
    previous: PlayerSnapshotData | null,
    nowMs: number,
  ): void {
    if (!this.holder) return; // No model yet (or none ever): the capsule stands in.
    const wanted = clipFor(this.animState(sample, previous, nowMs));
    const clip = this.resolvedClip(wanted);
    const duration = this.durations.get(clip);
    if (duration === undefined) return; // Model carries no clips: leave its bind pose.
    poseShape(this.holder, clip, this.clipSeconds(wanted, clip, duration, nowMs));
  }

  /** A clip the model does not carry falls back rather than to a frozen pose: an unknown
   *  name makes `poseShape` a no-op, which would leave whatever was last seeked. Root is the
   *  general answer (it is what the engine holds when nothing else applies); a death is the
   *  one case where any clip from the family is better than standing up, so it walks its own
   *  fallback list first. */
  private resolvedClip(clip: string): string {
    if (this.durations.has(clip)) return clip;
    if (clip === DIE_CLIP) {
      return DEATH_CLIP_FALLBACKS.find((name) => this.durations.has(name)) ?? ROOT_CLIP;
    }
    return ROOT_CLIP;
  }

  /** One-shot clips (landing, death) run once from their own edge and hold at the end, which
   *  is what `poseShape`'s clamp does for a value past the clip's length. Everything else
   *  loops on a free-running clock, offset per id so two players running the same body are
   *  not in lockstep.
   *
   *  `wanted` is the clip the state asked for and `clip` the one being played: they differ
   *  when the model does not carry the first, and which of the two is a one-shot is a
   *  property of the state (the landing and death edges), not of whichever body happened to
   *  supply the pose.
   *
   *  Known simplification: the engine scales a movement clip's rate by how fast the player is
   *  actually moving (`scale = mDot(vel, anim.dir) / anim.speed`, player.cc:2243-2262, with
   *  `anim.speed` the ground transform the sequence was authored with), so a sprinting
   *  soldier's legs cycle faster than a jogging one's. Reproducing it means integrating that
   *  rate into a per-view phase -- a free-running clock times a changing rate would jump --
   *  and the authored speed is not something this client reads off the clip, so every
   *  sustained clip here plays at its authored 1x rate. The pose is right; the cadence does
   *  not follow the ground speed. */
  private clipSeconds(wanted: string, clip: string, duration: number, nowMs: number): number {
    // A sequence with a single keyframe exports as a zero-length clip. `x % 0` is NaN, and
    // three happens to tolerate a NaN time only because a single-key track's interpolant
    // ignores it -- so the clip's one frame is sought explicitly instead of relied upon.
    if (!(duration > 0)) return 0;
    if (wanted === LAND_CLIP) return (nowMs - this.landedAtMs) / 1000;
    if (wanted === DIE_CLIP) return (nowMs - this.diedAtMs) / 1000;
    return ((nowMs + this.id * PHASE_SPREAD_MS) / 1000) % duration;
  }

  /** The corpse: the same mesh the living player was using a moment ago, left where they fell
   *  and then taken off the field -- T2's own death keeps the body too (`Player::updateDamageState`
   *  swaps the object's type mask to `CorpseObjectType` and the shape keeps the death thread it
   *  was given, player.cc:1862-1875), so nothing new is built here and nothing is duplicated.
   *  An alive sample always wins: it restores visibility, the resting rotation and the height
   *  in one line, which is what the respawn sample does the moment the id comes back at its
   *  spawn point. */
  private applyCorpse(sample: PlayerSnapshotData, nowMs: number): void {
    const corpse =
      sample.health <= 0 ? corpseFor(nowMs - this.diedAtMs, this.collapseSeconds()) : null;
    this.root.visible = corpse ? corpse.visible : true;
    this.root.rotation.x = corpse ? corpse.tilt : 0;
    this.root.position.y -= corpse ? corpse.sink : 0;
  }

  /** How long the collapse this body plays runs, in seconds, or 0 when it has none: 0 for the
   *  capsule stand-in (no model loaded yet, or one that never arrives) and for a model that
   *  carries no die clip at all, which resolvesClip reports as the fall back to root. Both are
   *  the cases corpseFor's own root topple is for, so the two answers cannot drift apart. */
  private collapseSeconds(): number {
    const clip = this.resolvedClip(DIE_CLIP);
    return clip === ROOT_CLIP ? 0 : (this.durations.get(clip) ?? 0);
  }

  /** Swap the model when the armour changes under a reused id -- a station loadout change,
   *  or a freed id respawning as another armour. Same shape as vehicle-view's kind change:
   *  the old model's GPU resources are freed, never left for the GC. */
  private ensureBody(body: string): void {
    if (body === this.body) return;
    this.body = body;
    this.dropModel();
    // Visible until a model actually arrives: this is the documented fallback for a load
    // that never completes or fails, and it must also come back if an armour swap replaces
    // a loaded model with one that cannot be fetched.
    this.capsule.visible = true;
    // A fresh holder per load: loadShapeFrom's own disposal contract marks the root it is
    // given as disposed, so a root that has been disposed can never be loaded into again.
    this.holder = new THREE.Group();
    this.root.add(this.holder);
    loadShapeFrom(this.holder, playerModelUrl(body), 0, (_scene, animations) => {
      for (const clip of animations) this.durations.set(clip.name.toLowerCase(), clip.duration);
      // The model and the capsule are siblings, so neither inherits the other's visibility:
      // the capsule has to be hidden explicitly or the blue stand-in draws over the soldier.
      this.capsule.visible = false;
    });
  }

  private dropModel(): void {
    if (!this.holder) return;
    this.root.remove(this.holder);
    disposeShape(this.holder);
    this.holder = null;
    this.durations.clear();
  }
}
