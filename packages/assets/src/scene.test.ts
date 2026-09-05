import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMission } from './mis.js';
import { extractScene, torqueAxisAngleToYUp, torquePositionToYUp } from './scene.js';

describe('scene extraction', () => {
  it('converts position and rotation axes exactly once', () => {
    expect(torquePositionToYUp('1 2 3')).toEqual([1, 3, -2]);
    expect(torqueAxisAngleToYUp('1 2 3 90')).toEqual({ axis: [1, 3, -2], degrees: 90 });
  });

  it('extracts typed leaves and inherited team membership', async () => {
    const source = await readFile(new URL('./__fixtures__/scene.mis', import.meta.url), 'utf8');
    const scene = extractScene(parseMission(source));
    expect(scene.terrain).toEqual({
      terrainFile: 'Katabatic.ter',
      squareSize: 8,
      position: [-1024, 0, 1024],
    });
    expect(scene.sun.direction).toEqual([0.57735, -0.57735, -0.57735]);
    expect(scene.sky.visibleDistance).toBe(500);
    expect(scene.sky.fogDistance).toBe(400);
    expect(scene.sky.fogColor).toEqual([0.65, 0.65, 0.7, 1]);
    expect(scene.missionArea).toEqual({ minX: -896, minZ: -696, width: 1504, depth: 1392 });
    expect(scene.spawns).toEqual([
      { name: 'SpawnA', team: 1, position: [326.888, 74.8106, 168.521], radius: 5 },
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
  });
});
