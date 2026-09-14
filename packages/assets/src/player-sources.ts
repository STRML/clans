/** The three armour bodies the sim spawns (`armorFor`: light/medium/heavy) and the animation
 *  clips each one ships.
 *
 *  A body's mesh and node hierarchy is a `shapes.vl2` shape (`light_male.dts`, and so on),
 *  and its clips are *external* — one standalone `.dsq` per clip, next to the `.dts` in the
 *  same mirror directory, which is why the shape files themselves carry no movement
 *  sequences at all (light_male.dts holds only `JetFlare`/`Damage`, both IFL material
 *  markers). The engine assembles the two halves at load time: a `TSShapeConstructor`
 *  datablock names a base shape and a list of sequence files, and `TSShapeConstructor::onAdd`
 *  (`ts/tsShapeConstruct.cc:40-117`) opens each `.dsq` and calls `TSShape::importSequences`
 *  (`ts/tsShapeOldRead.cc:1046`) to append it to the shape.
 *
 *  The clip lists below are the body's `TSShapeConstructor` datablock — that is, the clips the
 *  game actually loads — widened to everything the mirror publishes for the body. The player
 *  spec asks for "the `die*` set", and a body's death animation is picked from all of them, so
 *  a death clip the mirror ships is worth carrying even where the base datablock points two
 *  death slots at one file instead. Four clips come from that widening: `medium_male_dielegrt`,
 *  `heavy_male_dieknees`, `heavy_male_dieleglf` and `heavy_male_dielegrt`. One published file
 *  is left out — `medium_male_dieslump.dsq` is a 0-byte file in the mirror (git's empty blob)
 *  and no datablock references it either, so there is nothing to convert, which is why medium
 *  ships one death clip fewer than light.
 *
 *  Two notes on what the datablocks say and what this manifest does with it:
 *
 *  - A `sequenceN` line may carry a second token, the name the sequence takes in the loaded
 *    shape (`sequence1 = "light_male_forward.dsq run"` renames the file's internal `Forward`
 *    to `run`, which is the name `PlayerData::ActionAnimationList` uses — `game/player.cc:128`
 *    lists `root`, `run`, `back`, `side`, `fall`, `jump`, `land`). This manifest keeps the
 *    *file suffix* as the clip name instead, verbatim, because that is the contract the
 *    client's `clipFor` and the GLB clip names are built to (`forward`, not `run`), and
 *    because the file suffix is what identifies the clip on disk.
 *  - The same file can be named twice under two death names (medium's `death7` is
 *    `medium_male_diechest.dsq` again, heavy's `death9` is `heavy_male_dieforward.dsq`), so
 *    the engine loads more sequences than there are distinct clips. One clip per file is
 *    emitted; the aliases collapse onto it, which is all a single-name-per-clip GLB can
 *    express.
 *
 *  `newland` is the one clip no `TSShapeConstructor` in the base or classic script tree names,
 *  yet the mirror ships it for `light_male` and the player contract asks for it, so it is
 *  carried where it exists. There is no `medium_male_newland` or `heavy_male_newland` in the
 *  mirror at all — nor `looksn` for heavy — so each body carries the clips its own sources
 *  have and no more; the build test asserts each body's published set against this manifest
 *  rather than against a set that cannot exist. */
export interface PlayerBody {
  /** Body name: the `<body>.dts`/`<body>_<clip>.dsq` file stem and the `players/<body>.glb`
   *  output name. */
  readonly body: string;
  /** Clip names, each the suffix of a `<body>_<clip>.dsq` in the mirror, and the name of the
   *  clip it becomes in the emitted GLB. */
  readonly clips: readonly string[];
}

/** The mirror directory every player source is cached under, next to the `.dts` shapes the
 *  rest of `fetch.ts`'s `shapes.vl2` entries come from. */
export const PLAYER_SHAPE_DIRECTORY = 'shapes.vl2/shapes';

export const PLAYER_BODIES: readonly PlayerBody[] = [
  {
    body: 'light_male',
    clips: [
      'back',
      'celdisco',
      'celflex',
      'celrocky',
      'celsalute',
      'celtaunt',
      'celwave',
      'dieback',
      'diechest',
      'dieforward',
      'diehead',
      'dieknees',
      'dieleglf',
      'dielegrt',
      'diesidelf',
      'diesidert',
      'dieslump',
      'diespin',
      'fall',
      'forward',
      'head',
      'headside',
      'idlepda',
      'jet',
      'jump',
      'land',
      'lookde',
      'lookms',
      'looknw',
      'looksn',
      'newland',
      'recoilde',
      'root',
      'scoutroot',
      'side',
      'sitting',
      'ski',
      'standjump',
      'tauntbest',
      'tauntimp',
    ],
  },
  {
    body: 'medium_male',
    clips: [
      'back',
      'celdance',
      'celflex',
      'celrocky',
      'celsalute',
      'celtaunt',
      'celwave',
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
      'fall',
      'forward',
      'head',
      'headside',
      'idlepda',
      'jet',
      'jump',
      'land',
      'lookde',
      'lookms',
      'looknw',
      'looksn',
      'recoilde',
      'root',
      'side',
      'sitting',
      'ski',
      'standjump',
      'tauntbest',
      'tauntimp',
    ],
  },
  {
    body: 'heavy_male',
    clips: [
      'back',
      'celdance',
      'celflex',
      'celjump',
      'celsalute',
      'celtaunt',
      'celwave',
      'dieback',
      'diechest',
      'dieforward',
      'diehead',
      'dieknees',
      'dieleglf',
      'dielegrt',
      'diesidelf',
      'diesidert',
      'dieslump',
      'diespin',
      'fall',
      'forward',
      'head',
      'headside',
      'idlepda',
      'jet',
      'jump',
      'land',
      'lookde',
      'lookms',
      'looknw',
      'recoilde',
      'root',
      'side',
      'ski',
      'standjump',
      'tauntbest',
      'tauntimp',
    ],
  },
];

/** One body's `.dts` source, cache-relative — the shape the clips are appended to. */
export function playerShapeSource(body: PlayerBody): string {
  return `${PLAYER_SHAPE_DIRECTORY}/${body.body}.dts`;
}

/** One body's clip source: the standalone `.dsq` `fetch.ts` caches and `dsq.ts` reads. */
export function playerClipSource(body: PlayerBody, clip: string): string {
  return `${PLAYER_SHAPE_DIRECTORY}/${body.body}_${clip}.dsq`;
}

/** Every player source file, cache-relative, in the order the sources are declared: the
 *  shape and then its clips, body by body. `fetch.ts` downloads exactly this list. */
export function playerSourceFiles(): string[] {
  return PLAYER_BODIES.flatMap((body) => [
    playerShapeSource(body),
    ...body.clips.map((clip) => playerClipSource(body, clip)),
  ]);
}
