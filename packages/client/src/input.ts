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
  sensitivity = 0.002;
  private readonly keys = new Set<string>();

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
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 2) this.jet = false;
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
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** The sim input for this tick. Keys work without pointer lock; only the mouse needs it. */
  snapshot(): PlayerInput {
    const axis = (positive: string, negative: string): number =>
      (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
    return {
      moveX: axis('KeyD', 'KeyA'),
      moveZ: axis('KeyW', 'KeyS'),
      yaw: this.yaw,
      jump: this.isDown('Space'),
      jet: this.jet,
    };
  }
}
