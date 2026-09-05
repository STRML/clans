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

  it('reports the opening line for an unterminated object', () => {
    expect(() => parseMission('new SimGroup(Broken) {\r\n key = "value";')).toThrow(
      'Unterminated SimGroup opened at line 1',
    );
  });
});
