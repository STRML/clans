import type { PlayerInput } from '@clans/sim';
import { keymap } from './keymap.js';

const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Pointer-lock mouse look plus keyboard state. Yaw follows the sim convention: forward is
 * (sin yaw, 0, cos yaw) in world space, so yaw decreases when the mouse moves right.
 *
 * Gameplay keys resolve through `keymap.ts`'s action map -- the design spec's
 * "Rebindable through a JSON keymap" input bullet
 * (docs/superpowers/specs/2026-09-05-clans-tribes2-browser-demo-design.md:319) -- so every
 * code below comes from the exported `keymap` (loaded once at boot from
 * `assets/out/keymap.json`, the client's Vite public dir) and this file never names a
 * key. Two bindings stay hardcoded because they are not keyboard actions: jet/fire are
 * mouse buttons (the attach() mousedown handlers -- the original game's own default
 * triggers), and the number keys 1-9 double as the dialog-selection keys in the
 * commander-map and voice-bind menus, exactly as T2's GUI hardwires option picks to the
 * digits.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  jet = false;
  fire = false;
  sensitivity = 0.002;
  uiOpen = false;
  private resumeClick = false;
  private readonly keys = new Set<string>();
  private wasUseHeld = false;
  private wasCommandCircleHeld = false;
  private wasAnyDigitHeld = false;
  private wasEscapeHeld = false;
  private wasVoiceMenuHeld = false;
  private wasCameraToggleHeld = false;

  constructor(private readonly target: HTMLElement) {}

  /** Called only from a click/key gesture, including vehicle selection. */
  resumeMouseLook(): void {
    if (this.uiOpen) return;
    this.resumeClick = false;
    if (document.pointerLockElement !== this.target) {
      void this.target.requestPointerLock()?.catch(() => {
        this.resumeClick = true;
      });
    }
  }

  attach(): void {
    const { target } = this;
    target.addEventListener('click', () => this.resumeMouseLook());
    target.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', (event) => {
      // Tab as well: the scoreboard is a hold-to-show key like T2's, and the browser's own
      // focus traversal would steal both the key and subsequent pointer-lock input.
      if (event.code === 'Space' || event.code === 'Tab' || event.code.startsWith('F'))
        event.preventDefault();
      if (!event.repeat) this.keys.add(event.code);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== target) this.releaseAll();
    });
    target.addEventListener('mousedown', (event) => {
      if (this.uiOpen || this.resumeClick) return;
      if (event.button === 2) this.jet = true;
      else if (event.button === 0) this.fire = true;
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 2) this.jet = false;
      else if (event.button === 0) this.fire = false;
    });
    window.addEventListener('mousemove', (event) => this.look(event));
  }

  private look(event: MouseEvent): void {
    if (this.uiOpen || document.pointerLockElement !== this.target) return;
    const sensitivity = this.sensitivity * (this.isZooming() ? 0.5 : 1);
    this.yaw -= event.movementX * sensitivity;
    this.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.pitch - event.movementY * sensitivity),
    );
  }

  /** Drop every held input. Called on blur and pointer-lock exit so nothing sticks. */
  releaseAll(): void {
    this.keys.clear();
    this.jet = false;
    this.fire = false;
    this.wasUseHeld = false;
    this.wasCommandCircleHeld = false;
    this.wasAnyDigitHeld = false;
    this.wasEscapeHeld = false;
    this.wasVoiceMenuHeld = false;
    this.wasCameraToggleHeld = false;
  }

  /** Menus own mouse/keyboard actions until closed; the next canvas click resumes look. */
  setUiOpen(open: boolean): void {
    if (open === this.uiOpen) return;
    this.uiOpen = open;
    this.releaseAll();
    if (open) {
      this.resumeClick = true;
      if (document.pointerLockElement === this.target) document.exitPointerLock();
    }
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Hold the zoom key to zoom (default Z; Z avoids the original A binding because A is
   *  movement here). */
  isZooming(): boolean {
    return !this.uiOpen && this.isDown(keymap.zoom);
  }

  /** The Tab scoreboard is held, not toggled: show while the key is down, hide on release,
   *  exactly the original game's own TAB overlay (`scoreHud` visibility follows the key).
   *  Level-triggered like isZooming, so no edge state to consume; menus suppress it via the
   *  same uiOpen gate every other held binding reads. */
  isScoreboardHeld(): boolean {
    return !this.uiOpen && this.isDown(keymap.scoreboard);
  }

  /** True on the call where the use key (default `E`) transitions from up to held since
   *  the last call --
   *  mirrors movement.ts's own jump-edge convention (`wasJumpHeld`), consumed once per read
   *  so a held key doesn't reopen a just-closed station menu every frame. */
  usePressedThisFrame(): boolean {
    const held = this.isDown(keymap.use);
    const pressed = held && !this.wasUseHeld;
    this.wasUseHeld = held;
    return pressed;
  }

  /** Same edge-triggered shape as `usePressedThisFrame`, for the commander-map toggle
   *  (default `C`). */
  commandCirclePressedThisFrame(): boolean {
    const held = this.isDown(keymap.commanderMap);
    const pressed = held && !this.wasCommandCircleHeld;
    this.wasCommandCircleHeld = held;
    return pressed;
  }

  /** Edge-triggered read of digit keys 1-9, for one-shot UI confirms (a commander-map order
   *  kind, a voice-bind line) -- distinct from `slotFromKeys` below, which is read every
   *  frame for weapon switching, where re-selecting an already-equipped weapon on a held key
   *  is harmless. Consumed once per read like `usePressedThisFrame`, so a held digit doesn't
   *  resend the same order/voice-bind on every frame it stays down. Returns 0 when no digit
   *  is newly pressed this frame. */
  digitPressedThisFrame(): number {
    for (let n = 1; n <= 9; n += 1) {
      if (this.isDown(`Digit${String(n)}`)) {
        const pressed = !this.wasAnyDigitHeld;
        this.wasAnyDigitHeld = true;
        return pressed ? n : 0;
      }
    }
    this.wasAnyDigitHeld = false;
    return 0;
  }

  /** Same edge-triggered shape as `commandCirclePressedThisFrame`, for dismissing a pending
   *  commander-map order or closing the voice-bind menu without sending anything. */
  escapePressedThisFrame(): boolean {
    const held = this.isDown(keymap.escape);
    const pressed = held && !this.wasEscapeHeld;
    this.wasEscapeHeld = held;
    return pressed;
  }

  /** Same edge-triggered shape as `commandCirclePressedThisFrame`, for the voice-bind
   *  quick-chat menu toggle (default `V`). */
  voiceMenuPressedThisFrame(): boolean {
    const held = this.isDown(keymap.voiceMenu);
    const pressed = held && !this.wasVoiceMenuHeld;
    this.wasVoiceMenuHeld = held;
    return pressed;
  }

  /** Same edge-triggered shape again, for the `X` vehicle-camera toggle. T2's own switch is
   *  the client-side `$firstPerson` pref (`GameConnection::mFirstPerson`, default true in
   *  game/gameConnection.cc), not a key in the base scripts our reference set has, so the
   *  binding is ours and the semantics are T2's: the resting mode is the model's `Eye` node
   *  and this selects the datablock's chase end. */
  cameraTogglePressedThisFrame(): boolean {
    if (this.uiOpen) return false;
    const held = this.isDown(keymap.cameraToggle);
    const pressed = held && !this.wasCameraToggleHeld;
    this.wasCameraToggleHeld = held;
    return pressed;
  }

  /** The lowest held weapon-slot key, or 0 if none are held -- matches `weaponIdForSlot`.
   *  Slots scan the keymap's slot bindings in slot order (defaults Digit1-Digit5), so
   *  "lowest held wins" follows slot priority, not any property of the codes themselves. */
  private slotFromKeys(): number {
    const slotKeys = [keymap.slot1, keymap.slot2, keymap.slot3, keymap.slot4, keymap.slot5];
    for (let n = 0; n < slotKeys.length; n += 1) {
      if (this.isDown(slotKeys[n]!)) return n + 1;
    }
    return 0;
  }

  /** The sim input for this tick. Keys work without pointer lock; only the mouse needs it. */
  snapshot(): PlayerInput {
    if (this.uiOpen)
      return {
        moveX: 0,
        moveZ: 0,
        yaw: this.yaw,
        pitch: this.pitch,
        jump: false,
        jet: false,
        fire: false,
        altFire: false,
        slot: 0,
        packActive: false,
        use: false,
      };
    const axis = (positive: string, negative: string): number =>
      (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
    return {
      moveX: axis(keymap.right, keymap.left),
      moveZ: axis(keymap.forward, keymap.back),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.isDown(keymap.jump),
      jet: this.jet,
      fire: this.fire,
      // The hand grenade (weapons.ts's tryThrowGrenade) rides the sim's altFire bit.
      altFire: this.isDown(keymap.grenade),
      slot: this.slotFromKeys(),
      packActive: this.isDown(keymap.pack),
      // Always false here: Input has no world access to know whether E is mount-relevant.
      // app.ts's frame() overrides this with usePressedThisFrame() gated by
      // canSendVehicleUse(world, playerId) before this sample ever reaches stepWorld/net.tick
      // (M5, Task 14) -- the same reason `yaw`/`pitch` here drive the mounted vehicle's own
      // steering without any change needed in this class: stepVehicles reads them straight
      // off this same PlayerInput.
      use: false,
    };
  }
}
