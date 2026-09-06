import type { MissionObject } from './mis.js';

export type Vec3 = [number, number, number];
export type Color4 = [number, number, number, number];
export interface AxisAngle {
  axis: Vec3;
  degrees: number;
}
export interface SceneData {
  terrain: { terrainFile: string; squareSize: number; position: Vec3; emptySquares: number[] };
  sun: { direction: Vec3; color: Color4; ambient: Color4 };
  sky: { visibleDistance: number; fogDistance: number; fogColor: Color4; materialList: string };
  missionArea: { minX: number; minZ: number; width: number; depth: number };
  spawns: Array<{ name: string | null; team: number; position: Vec3; radius: number }>;
  flags: Array<{ team: number; position: Vec3 }>;
  flagStands: Array<{ team: number; position: Vec3; rotation: AxisAngle }>;
}

/** A property that must be present. Mission files never omit these. */
function requiredString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new TypeError(`Missing ${name}`);
  return value;
}

/** One finite number from a mission property, with the property name in the error. */
function scalar(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(parsed)) {
    throw new TypeError(`Expected a finite number for ${name}, got "${String(value)}"`);
  }
  return parsed;
}

function numbers(value: string, count: number): number[] {
  const parsed = value.trim().split(/\s+/).map(Number);
  if (parsed.length !== count || parsed.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`Expected ${count} finite numbers, got "${value}"`);
  }
  return parsed;
}

/** Negate, without letting a zero input turn into a distinct -0 output. */
function negate(value: number): number {
  return value === 0 ? 0 : -value;
}

export function torquePositionToYUp(value: string): Vec3 {
  const [x = 0, y = 0, z = 0] = numbers(value, 3);
  return [x, z, negate(y)];
}

export function torqueAxisAngleToYUp(value: string): AxisAngle {
  const [x = 0, y = 0, z = 0, degrees = 0] = numbers(value, 4);
  return { axis: [x, z, negate(y)], degrees };
}

function color(value: string): Color4 {
  const [r = 0, g = 0, b = 0, a = 1] = numbers(value, 4);
  return [r, g, b, a];
}

interface LocatedObject {
  object: MissionObject;
  ancestors: MissionObject[];
}

function flatten(objects: MissionObject[], ancestors: MissionObject[] = []): LocatedObject[] {
  return objects.flatMap((object) => [
    { object, ancestors },
    ...flatten(object.children, [...ancestors, object]),
  ]);
}

function required(found: LocatedObject | undefined, className: string): LocatedObject {
  if (!found) throw new Error(`Mission is missing ${className}`);
  return found;
}

/** An explicit team property must be a non-negative integer; a bad value is an error, never a fallback. */
function teamProperty(parent: MissionObject): number {
  const value = scalar(parent.props.team, `${parent.class}.team`);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `Expected a non-negative integer for ${parent.class}.team, got "${String(parent.props.team)}"`,
    );
  }
  return value;
}

function teamFor(ancestors: MissionObject[]): number {
  for (const parent of [...ancestors].reverse()) {
    if (parent.props.team !== undefined) return teamProperty(parent);
    const match = /^Team(\d+)$/i.exec(parent.name ?? '');
    if (match) return Number(match[1]);
  }
  throw new Error('SpawnSphere has no enclosing team');
}

function findByClass(all: LocatedObject[], className: string): MissionObject {
  return required(
    all.find(({ object }) => object.class === className),
    className,
  ).object;
}

function buildTerrain(terrain: MissionObject): SceneData['terrain'] {
  return {
    terrainFile: requiredString(terrain.props.terrainFile, 'TerrainBlock.terrainFile'),
    squareSize: scalar(terrain.props.squareSize, 'TerrainBlock.squareSize'),
    position: torquePositionToYUp(terrain.props.position ?? ''),
    emptySquares: emptySquares(terrain.props.emptySquares),
  };
}

/**
 * Torque stores each empty square as row * 256 + col with stray high bits above bit 15
 * (Katabatic has values up to 748451). Mask both to 8 bits and re-pack as row * 256 + col.
 */
function emptySquares(value: string | undefined): number[] {
  if (value === undefined || value.trim() === '') return [];
  return numbers(value, value.trim().split(/\s+/).length).map((raw) => {
    const col = raw & 0xff;
    const row = (raw >>> 8) & 0xff;
    return row * 256 + col;
  });
}

function buildSun(sun: MissionObject): SceneData['sun'] {
  return {
    direction: torquePositionToYUp(sun.props.direction ?? ''),
    color: color(sun.props.color ?? ''),
    ambient: color(sun.props.ambient ?? '0 0 0 1'),
  };
}

function buildSky(sky: MissionObject): SceneData['sky'] {
  return {
    visibleDistance: scalar(sky.props.visibleDistance, 'Sky.visibleDistance'),
    fogDistance: scalar(sky.props.fogDistance, 'Sky.fogDistance'),
    fogColor: color(sky.props.fogColor ?? '0.65 0.65 0.7 1'),
    materialList: requiredString(sky.props.materialList, 'Sky.materialList'),
  };
}

function buildMissionArea(area: MissionObject): SceneData['missionArea'] {
  const [areaX = 0, areaY = 0, width = 0, depth = 0] = numbers(area.props.area ?? '', 4);
  return { minX: areaX, minZ: -(areaY + depth), width, depth };
}

function buildSpawns(all: LocatedObject[]): SceneData['spawns'] {
  return all
    .filter(({ object }) => object.class === 'SpawnSphere')
    .map(({ object, ancestors }) => ({
      name: object.name,
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
      radius: scalar(object.props.radius, 'SpawnSphere.radius'),
    }));
}

/**
 * The flag and its stand are not dedicated Torque classes: the mission represents them as a
 * generic Item/StaticShape whose `dataBlock` names the actual game object ("Flag",
 * "ExteriorFlagStand"). Filter on dataBlock, not class.
 */
function buildFlags(all: LocatedObject[]): SceneData['flags'] {
  return all
    .filter(({ object }) => object.props.dataBlock === 'Flag')
    .map(({ object, ancestors }) => ({
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
    }));
}

function buildFlagStands(all: LocatedObject[]): SceneData['flagStands'] {
  return all
    .filter(({ object }) => object.props.dataBlock === 'ExteriorFlagStand')
    .map(({ object, ancestors }) => ({
      team: teamFor(ancestors),
      position: torquePositionToYUp(object.props.position ?? ''),
      rotation: torqueAxisAngleToYUp(object.props.rotation ?? '0 0 1 0'),
    }));
}

export function extractScene(objects: MissionObject[]): SceneData {
  const all = flatten(objects);
  return {
    terrain: buildTerrain(findByClass(all, 'TerrainBlock')),
    sun: buildSun(findByClass(all, 'Sun')),
    sky: buildSky(findByClass(all, 'Sky')),
    missionArea: buildMissionArea(findByClass(all, 'MissionArea')),
    spawns: buildSpawns(all),
    flags: buildFlags(all),
    flagStands: buildFlagStands(all),
  };
}
