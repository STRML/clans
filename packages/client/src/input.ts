import type { PlayerInput } from '@clans/sim';

const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Pointer-lock mouse look plus keyboard state. Yaw follows the sim convention: forward is
 * (sin yaw, 0, cos yaw) in world space, so yaw decreases when the mouse moves right.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  jet = false;
  fire = false;
  sensitivity = 0.002;
  private readonly keys = new Set<string>();
  private wasUseHeld = false;
  private wasCommandCircleHeld = false;

  constructor(private readonly target: HTMLElement) {}

  attach(): void {
    const { target } = this;
    target.addEventListener('click', () => {
      if (document.pointerLockElement !== target) target.requestPointerLock();
    });
    target.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space' || event.code.startsWith('F')) event.preventDefault();
      this.keys.add(event.code);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== target) this.releaseAll();
    });
    target.addEventListener('mousedown', (event) => {
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
    if (document.pointerLockElement !== this.target) return;
    this.yaw -= event.movementX * this.sensitivity;
    this.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.pitch - event.movementY * this.sensitivity),
    );
  }

  /** Drop every held input. Called on blur and pointer-lock exit so nothing sticks. */
  releaseAll(): void {
    this.keys.clear();
    this.jet = false;
    this.fire = false;
    this.wasUseHeld = false;
    this.wasCommandCircleHeld = false;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** True on the call where `E` transitions from up to held since the last call --
   *  mirrors movement.ts's own jump-edge convention (`wasJumpHeld`), consumed once per read
   *  so a held key doesn't reopen a just-closed station menu every frame. */
  usePressedThisFrame(): boolean {
    const held = this.isDown('KeyE');
    const pressed = held && !this.wasUseHeld;
    this.wasUseHeld = held;
    return pressed;
  }

  /** Same edge-triggered shape as `usePressedThisFrame`, for the `C` commander-map toggle. */
  commandCirclePressedThisFrame(): boolean {
    const held = this.isDown('KeyC');
    const pressed = held && !this.wasCommandCircleHeld;
    this.wasCommandCircleHeld = held;
    return pressed;
  }

  /** The lowest held number key 1-5, or 0 if none are held — matches `weaponIdForSlot`. */
  private slotFromKeys(): number {
    for (let n = 1; n <= 5; n += 1) {
      if (this.isDown(`Digit${String(n)}`)) return n;
    }
    return 0;
  }

  /** The sim input for this tick. Keys work without pointer lock; only the mouse needs it. */
  snapshot(): PlayerInput {
    const axis = (positive: string, negative: string): number =>
      (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
    return {
      moveX: axis('KeyD', 'KeyA'),
      moveZ: axis('KeyW', 'KeyS'),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.isDown('Space'),
      jet: this.jet,
      fire: this.fire,
      altFire: this.isDown('KeyG'),
      slot: this.slotFromKeys(),
      packActive: this.isDown('KeyR'),
    };
  }
}
