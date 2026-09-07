import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMission } from './mis.js';
import { extractScene, torqueAxisAngleToYUp, torquePositionToYUp } from './scene.js';

/** Local mirrors of @clans/sim's BaseObjectKind ordinals, so this test file doesn't hardcode
 *  magic numbers twice. Must stay in lockstep with @clans/sim's real enum. */
const BASE_OBJECT_KIND = {
  Generator: 0,
  Sensor: 1,
  StationInventory: 2,
  StationVehiclePad: 3,
  ForceField: 4,
} as const;

/** Local mirror of @clans/sim's TurretBarrelId ordinals; see BASE_OBJECT_KIND above. */
const TURRET_BARREL = {
  PlasmaBarrelLarge: 0,
  AABarrelLarge: 1,
  SentryTurretBarrel: 2,
} as const;

async function loadFixtureScene() {
  const source = await readFile(new URL('./__fixtures__/scene.mis', import.meta.url), 'utf8');
  return extractScene(parseMission(source));
}

describe('scene extraction', () => {
  it('converts position and rotation axes exactly once', () => {
    expect(torquePositionToYUp('1 2 3')).toEqual([1, 3, -2]);
    expect(torqueAxisAngleToYUp('1 2 3 90')).toEqual({ axis: [1, 3, -2], degrees: 90 });
  });

  it('extracts typed leaves and inherited team membership', async () => {
    const source = await readFile(new URL('./__fixtures__/scene.mis', import.meta.url), 'utf8');
    const scene = extractScene(parseMission(source));
    // 223146 = row 103 col 170 once the stray high bits are masked; 747683 = row 104 col 163.
    expect(scene.terrain.emptySquares).toEqual([103 * 256 + 170, 104 * 256 + 163]);
    expect(scene.terrain).toEqual({
      terrainFile: 'Katabatic.ter',
      squareSize: 8,
      position: [-1024, 0, 1024],
      emptySquares: [103 * 256 + 170, 104 * 256 + 163],
    });
    expect(scene.sun.direction).toEqual([0.57735, -0.57735, -0.57735]);
    expect(scene.sky.visibleDistance).toBe(500);
    expect(scene.sky.fogDistance).toBe(400);
    expect(scene.sky.fogColor).toEqual([0.65, 0.65, 0.7, 1]);
    expect(scene.missionArea).toEqual({ minX: -896, minZ: -696, width: 1504, depth: 1392 });
    expect(scene.spawns).toEqual([
      { name: 'SpawnA', team: 1, position: [326.888, 74.8106, 168.521], radius: 5 },
    ]);
    expect(scene.flags).toEqual([{ team: 1, position: [330, 75, 180] }]);
    expect(scene.flagStands).toEqual([
      { team: 1, position: [330, 75, 180], rotation: { axis: [0, 1, 0], degrees: 45 } },
    ]);
  });

  it('rejects a scalar field that is missing or not a number', () => {
    const source =
      'new TerrainBlock(T) { terrainFile = "k.ter"; squareSize = "eight"; position = "0 0 0"; };\n' +
      'new Sun() { direction = "0 0 -1"; color = "1 1 1 1"; ambient = "0 0 0 1"; };\n' +
      'new Sky(Sky) { visibleDistance = "500"; fogDistance = "400"; fogColor = "0 0 0 1"; materialList = "x"; };\n' +
      'new MissionArea(M) { area = "0 0 1 1"; };';
    expect(() => extractScene(parseMission(source))).toThrow(
      'Expected a finite number for TerrainBlock.squareSize, got "eight"',
    );
  });

  it('rejects an explicit team property that is not an integer instead of falling back to the group name', () => {
    const source =
      'new SimGroup(Team1) {\n team = "not-a-number";\n new SpawnSphere(S) { position = "0 0 0"; radius = "5"; };\n};\n' +
      'new TerrainBlock(T) { terrainFile = "k.ter"; squareSize = "8"; position = "0 0 0"; };\n' +
      'new Sun() { direction = "0 0 -1"; color = "1 1 1 1"; ambient = "0 0 0 1"; };\n' +
      'new Sky(Sky) { visibleDistance = "500"; fogDistance = "400"; fogColor = "0 0 0 1"; materialList = "x"; };\n' +
      'new MissionArea(M) { area = "0 0 1 1"; };';
    expect(() => extractScene(parseMission(source))).toThrow(
      'Expected a finite number for SimGroup.team, got "not-a-number"',
    );
  });

  it('rejects a missing terrainFile instead of writing an empty string', () => {
    const source =
      'new TerrainBlock(T) { squareSize = "8"; position = "0 0 0"; };\n' +
      'new Sun() { direction = "0 0 -1"; color = "1 1 1 1"; ambient = "0 0 0 1"; };\n' +
      'new Sky(Sky) { visibleDistance = "500"; fogDistance = "400"; fogColor = "0 0 0 1"; materialList = "x"; };\n' +
      'new MissionArea(M) { area = "0 0 1 1"; };';
    expect(() => extractScene(parseMission(source))).toThrow('Missing TerrainBlock.terrainFile');
    const blank = source.replace(
      'new TerrainBlock(T) {',
      'new TerrainBlock(T) { terrainFile = "   ";',
    );
    expect(() => extractScene(parseMission(blank))).toThrow('Missing TerrainBlock.terrainFile');
  });
});

describe('buildBaseObjects', () => {
  it('extracts generator, sensor, station, and pad with the right kind and team', async () => {
    const scene = await loadFixtureScene();
    const gen = scene.baseObjects.find(
      (o) => o.kind === BASE_OBJECT_KIND.Generator && o.team === 1,
    );
    expect(gen?.position).toEqual([10, 0, 0]);
    const sensor = scene.baseObjects.find(
      (o) => o.kind === BASE_OBJECT_KIND.Sensor && o.team === 1,
    );
    expect(sensor).toBeDefined();
    const station = scene.baseObjects.find(
      (o) => o.kind === BASE_OBJECT_KIND.StationInventory && o.team === 1,
    );
    expect(station).toBeDefined();
    const pad = scene.baseObjects.find(
      (o) => o.kind === BASE_OBJECT_KIND.StationVehiclePad && o.team === 1,
    );
    expect(pad).toBeDefined();
  });
});

describe('buildTurrets', () => {
  it('extracts a Plasma-barreled TurretBaseLarge, an AA-barreled one, and a Sentry, each with its team', async () => {
    const scene = await loadFixtureScene();
    const plasma = scene.turrets.find((t) => t.barrel === TURRET_BARREL.PlasmaBarrelLarge);
    expect(plasma?.team).toBe(1);
    const aa = scene.turrets.find((t) => t.barrel === TURRET_BARREL.AABarrelLarge);
    expect(aa?.team).toBe(2);
    const sentry = scene.turrets.find((t) => t.barrel === TURRET_BARREL.SentryTurretBarrel);
    expect(sentry).toBeDefined();
  });
});

describe('buildInteriors', () => {
  it('extracts an interior placement with its shape name (extension stripped), position, and rotation', async () => {
    const scene = await loadFixtureScene();
    const bunker = scene.interiors.find((i) => i.shape === 'sbunk2');
    expect(bunker?.position).toEqual([70, 0, 0]);
    expect(bunker?.rotation.degrees).toBe(45);
  });
});

describe('buildBaseObjects: force fields', () => {
  it('extracts a ForceFieldBare as a base object with kind ForceField, its rotation, and its scale', async () => {
    const scene = await loadFixtureScene();
    const field = scene.baseObjects.find(
      (o) => o.kind === BASE_OBJECT_KIND.ForceField && o.team === 1,
    );
    expect(field?.position).toEqual([80, 0, 0]);
    expect(field?.rotation?.degrees).toBe(90);
    expect(field?.scale).toEqual([1, 6, 4]); // torqueScaleToYUp swaps Y/Z, no negation.
  });
  it('every non-ForceField base object leaves rotation and scale undefined', async () => {
    const scene = await loadFixtureScene();
    const gen = scene.baseObjects.find(
      (o) => o.kind === BASE_OBJECT_KIND.Generator && o.team === 1,
    );
    expect(gen?.rotation).toBeUndefined();
    expect(gen?.scale).toBeUndefined();
  });
});
