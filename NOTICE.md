# Notice

The code in this repository is MIT licensed. The game data it loads is not ours.

## Tribes 2 game data

Terrain, mission, model, and texture files come from Tribes 2, developed by Dynamix and
published by Sierra On-Line, released as freeware by Sierra in 2004. Tribes and Tribes 2
remain the property of their rights holders. If you hold those rights and want a file
removed, open an issue and it will be removed.

Files used in milestone 1:

- `Katabatic.mis` and `Katabatic.ter`: the Katabatic mission and terrain.
- `IceWorld.Snow.png`, `IceWorld.RockBlue.png`, `IceWorld.SnowRock.png`, `IceWorld.Ice.png`: the terrain textures.

Later milestones add converted `.glb` interiors and shapes. Milestone 3 adds no new source
files: its `Flag` and `ExteriorFlagStand` objects come from the same `Katabatic.mis` already
credited above.

## Sources

- Data files are downloaded from the mirror at
  [github.com/exogen/t2-mapper](https://github.com/exogen/t2-mapper) under
  `docs/base/@vl2/`. Only its data files are used. None of its source code is.
- STL exports of the Dynamix source models come from
  [files.nastyhobbit.org/t2-models](https://files.nastyhobbit.org/?dir=t2-models). They
  are the fallback where no converted glb exists.
- Gameplay numbers (armor, weapon, vehicle, and base asset datablocks) are read from the
  Tribes 2 base scripts as mirrored at
  [github.com/jdknight/t2ds](https://github.com/jdknight/t2ds).

Source data files are not committed. `packages/assets` downloads them into a local cache
and writes the converted outputs to `assets/out/`, which is committed.
