# Tribes 2 UI and audio reference

This is a fidelity audit reference for the vanilla Tribes 2 presentation. The
screenshots are external references for comparison; this document makes no
claim that they are licensed for redistribution or that every pixel is
bit-exact across resolutions and patches.

## Screenshots

- [RAWG infantry CTF](https://media.rawg.io/media/screenshots/e90/e90c1035a55495286dbbe376fdb40dbc.jpg) — medium confidence. Teal translucent notification box upper-left; green health and blue energy bars feeding a cyan circular compass/clock upper-right; narrow cyan equipment rack on the right; two-row Storm/Inferno flag table bottom-left; faint circular reticle.
- [PlayT2 infantry frame](https://playt2.com/images/install_1.jpg) — medium confidence. Similar teal chat/notification panel, compact flag table, cyan/green status bars, circular compass/clock, and small right-edge item cells. Community archive provenance.
- [WSGF vehicle frame](https://www.wsgf.org/f/u/styles/node_gallery_display/public/contrib/dr/698/ingame_16x10.png?itok=QPgb2_W3) — medium confidence. This is a Wildcat scout ground vehicle in third-person on a pad, not a Shrike cockpit. Use it for vehicle HUD placement and compact instrument proportions only.
- [MyAbandonware air-combat frame](https://www.myabandonware.com/media/screenshots/t/tribes-2-isb/tribes-2_7.jpg) — medium confidence. Foggy flight view with ring reticle, upper-right status/compass, right-side item cells, and bottom-right equipment buttons.
- [MobyGames New Warrior menu](https://cdn.mobygames.com/screenshots/10516970-tribes-2-windows-creating-new-warrior.jpg) — high confidence. Dark teal textured shell, cyan `LAN GAME` header, JOIN/HOST/WARRIOR SETUP tabs, olive selected state and border, cyan `NEW WARRIOR` modal, green beveled controls, and bottom Launch/Training/LAN Game tabs.

The [Tribes Depot screenshot gallery](https://wiki.tribesdepot.com/wiki/Tribes_2/Screenshots/)
is an additional original-game gallery, but its full-size image links were not
retrievable during this audit. Do not use PlayT2's
[betahuds.jpeg](https://playt2.com/images/textures/betahuds.jpeg) as vanilla
evidence: that page identifies the HUD as TacoFusor's custom work.

Compare the implementation against these references for corner anchoring,
teal/green/cyan palette, narrow icon cells, thin reticles, and the compact
vehicle instrument cluster. Preserve the sparse play-space around HUD elements.

## Original GUI and HUD source paths

Authoritative mirror: [exogen/t2-mapper](https://github.com/exogen/t2-mapper/tree/HEAD/docs/base/@vl2).
Raw files use the prefix
`https://raw.githubusercontent.com/exogen/t2-mapper/HEAD/`.

- GUI bitmap root: `docs/base/@vl2/textures.vl2/textures/gui/`
- Weapon icons: `hud_new_blaster.png`, `hud_new_chaingun.png`,
  `hud_new_disc.png`, `hud_new_elfgun.png`, `hud_new_grenlaunch.png`,
  `hud_new_handgren.png`, `hud_new_missile.png`, `hud_new_mortar.png`,
  `hud_new_plasma.png`, `hud_new_shocklance.png`, `hud_new_sniper.png`,
  `hud_new_targetlaser.png`
- Pack icons: `hud_new_packammo.png`, `hud_new_packcloak.png`,
  `hud_new_packenergy.png`, `hud_new_packinventory.png`,
  `hud_new_packmotionsens.png`, `hud_new_packradar.png`,
  `hud_new_packrepair.png`, `hud_new_packsatchel.png`,
  `hud_new_packsensjam.png`, `hud_new_packshield.png`,
  `hud_new_packturret.png`
- HUD structure: `hud_new_panel.png`, `hud_new_weaponselect.png`,
  `hud_new_scorewindow.png`, `hud_armbar.png`, `hud_ergbar.png`,
  `hud_new_cog.png`, `hud_new_compass.png`, `hud_new_NSEW.png`, `hud_playertriangle.png`, `hud_enemytriangle.png`
- Reticles: `RET_*.png`, `crosshairs.png`, `hud_ret_shrike.png`,
  `hud_ret_bomber.png`, `hud_ret_sniper.png`, `hud_ret_targlaser.png`,
  `hud_ret_shocklance.png`, `hud_ret_tankchaingun.png`,
  `hud_ret_tankmortar.png`
- Vehicle HUD: `hud_veh_new_dash.png`, `hud_veh_icon_shrike.png`,
  `hud_veh_speedaltwin.png`, `hud_veh_enrgbar.png`,
  `hud_veh_weaponwin.png`, `hud_veh_new_dashpiece_1.png` through `_5.png`,
  `hud_veh_new_hilite_left.png`, `_middle.png`, and `_right.png`
- GUI chrome: `dlg_box.png`, `dlg_button.png`, `dlg_fieldfill.png`,
  `dlg_fieldgrade.png`, `dlg_frame_edge.png`, `dlg_frame_end.png`,
  `dlg_titletab.png`, `darkWindow.png`, `darkScroll.png`

Original script consumers are under
`docs/base/@vl2/scripts.vl2/scripts/`, especially `hud.cs`,
`inventoryHud.cs`, `objectiveHud.cs`, and
`vehicles/clientVehicleHud.cs` / `serverVehicleHud.cs`.

## Original audio source paths

Audio mirror root: `docs/base/@vl2/audio.vl2/audio/`. The implementation uses the
mirror's M4A encodings of these original recordings. Exact shipped paths are listed
in `packages/assets/src/audio-sources.ts`.

- Armor: `fx/armor/thrust`, `ski_soft`, `light_LF_soft`.
- Weapons: `fx/weapons/spinfusor_fire`, `chaingun_fire`, `mortar_fire`,
  `sniper_fire`, `blaster_fire`, and `mortar_explode`.
- Powered objects: `fx/powered/station_hum`, `generator_hum`, `inv_pad_on`,
  `vehicle_screen_on2`, `vehicle_screen_off`, and `station_denied`.
- Vehicles: `fx/vehicles/shrike_engine` and `outrider_engine`.
- Flags: `fx/misc/flag_capture` and `flag_snatch`.
- Voice: nine recordings under `voice.vl2/audio/voice/Bot1/`; menu entries name
  their categories rather than claiming exact transcripts.

Original audio profiles in `scripts/audioProfiles.cs`, `station.cs`, `staticShape.cs`,
weapon scripts, and vehicle scripts supply audible ranges. Station hum uses 10–50 m;
generator and engine loops use 20–100 m. `StationInventory::getSound` explicitly
returns no deactivation sound; vehicle stations use `StationVehicleDeactivateSound`.

Current limits: menu layout remains simplified; explosion/footstep variants, full
directional acoustics, and continuous weapon-loop timing are not reproduced completely.

## Projectile fidelity

The same upstream script mirror supplies `weapons/disc.cs`, `weapons/blaster.cs`,
`weapons/chaingun.cs`, `weapons/sniperRifle.cs`, and `vehicles/vehicle_air_scout.cs`.
The Blaster's EnergyBolt uses muzzle velocity 90, velocity inheritance 0.5,
0.05 drag, 0.998 bounce elasticity, and a three-second lifetime. It has no gravity.
Shrike shots use their own laser tracer rather than the handheld Blaster bolt.
The rifle beam is red, distinct from the green targeting-laser tool.

`controlDefaults.cs` initializes zoom FOV to 45 degrees and uses hold A for zoom.
Clans uses hold Z because A is strafe-left in its WASD layout; right mouse remains
jet. No additional zoom levels are assumed.

Projectile skins are recorded in `packages/assets/src/projectile-sources.ts`;
impact and looping travel samples are in `audio-sources.ts`. Projectile meshes
and explosion flashes remain approximations rather than original animated DTS
models. Impact effects/sounds currently follow the last visible projectile
position when it disappears; very short-lived shots between snapshots can be
missed by this presentation path.


September 9 playtest follow-up: the Blaster no longer adds an invented 0.3-second
reload timeout after its 0.3-second Fire state. Chaingun held fire is tuned to
0.10 seconds (source: 0.15), and Shrike fire to 0.20 seconds (source: 0.125),
following the user's faster/slower feedback. These two rates are intentional
playtest changes, not claimed vanilla constants.

Chaingun and Shrike now use the original `tracer00`/`tracercross` and
`shrikeBolt`/`shrikeBoltCross` textures from `weapons/chaingun.cs`, with additive
crossed ribbons, source widths/lengths, and compact impact glows. The Shrike's
blue-violet color comes from its texture, with white material tint. These remain
an approximation of Torque's camera-facing tracer renderer.

The Spinfusor explosion now uses the original `disc_explosion.glb`, authored geometry
animation and `blue00`/`disc00` textures at source scale. IFL textures currently use their
first frame. Flying discs use additive blue glow and a world-up flight frame to avoid
heading-dependent roll.

Turret barrels mount to the original sockets and track targets through their turn/elevation
nodes; source Fire clips animate shots. Damage and repair share an elevated hit sphere
around the visible assembly. Friendly turret wrecks recover below the original disabled
damage thresholds (large 1.35; sentry 0.84). These spheres remain approximate geometry.

Flag sounds follow `CTFGame.cs`: `flag_snatch`/`flag_taken` for pickups,
`flag_capture`/`flag_lost` for captures, plus `flag_drop` and `flag_return`.
Solo play checks each simulation tick; multiplayer consumes authoritative event sequences.
