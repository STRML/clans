import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMission } from './mis.js';

describe('parseMission', () => {
  it('parses properties and nested objects generically', async () => {
    const source = await readFile(new URL('./__fixtures__/scene.mis', import.meta.url), 'utf8');
    expect(parseMission(source)[0]).toEqual({
      class: 'SimGroup',
      name: 'Team1',
      props: { team: '1' },
      children: [
        {
          class: 'SpawnSphere',
          name: 'SpawnA',
          props: { position: '326.888 -168.521 74.8106', radius: '5' },
          children: [],
        },
      ],
    });
  });

  it('accepts quoted values that spell a keyword or delimiter', () => {
    const [object] = parseMission('new A(X) {\n key = "new";\n other = "}";\n};');
    expect(object?.props).toEqual({ key: 'new', other: '}' });
  });

  it('rejects a quoted string where a structural token belongs', () => {
    expect(() => parseMission('new A(X) { key = "value"; "}";')).toThrow(SyntaxError);
    expect(() => parseMission('"new" A(X) { };')).toThrow(SyntaxError);
    expect(() => parseMission('new "A"(X) { };')).toThrow(
      'Expected class name, got quoted string at line 1',
    );
    expect(() => parseMission('new A("X") { };')).toThrow(
      'Expected object name, got quoted string at line 1',
    );
    expect(() => parseMission('new A(X) { "key" = "v"; };')).toThrow(
      'Expected property key, got quoted string at line 1',
    );
  });

  it('rejects a missing semicolon between two properties instead of merging them', () => {
    expect(() => parseMission('new A(X) {\n key = "v" other = "w";\n};')).toThrow(
      'Expected ; at line 2',
    );
    expect(() => parseMission('new A(X) {\n key = ;\n};')).toThrow(
      'Expected a value before ; at line 2',
    );
  });

  it('rejects a property value that runs into a nested object instead of dropping it', () => {
    expect(() => parseMission('new A(X) {\n key = value new B(Y) {\n };\n};')).toThrow(
      'Expected ; at line 2',
    );
  });

  it('reports the opening line for an unterminated object', () => {
    expect(() => parseMission('new SimGroup(Broken) {\r\n key = "value";')).toThrow(
      'Unterminated SimGroup opened at line 1',
    );
  });
});
