/**
 * Original Tribes 2 samples, published in t2-mapper's `audio.vl2` volume.
 * Keep these as source files rather than synthesized substitutes: the client
 * decodes them with Web Audio after the normal asset build copies them below.
 */
export const AUDIO_SOURCES = {
  'armor-thrust.m4a': 'audio.vl2/audio/fx/armor/thrust.m4a',
  'armor-ski-soft.m4a': 'audio.vl2/audio/fx/armor/ski_soft.m4a',
  'armor-footstep.m4a': 'audio.vl2/audio/fx/armor/light_LF_soft.m4a',
  // Issue #56 armour/surface footstep variants. player.cs gives every armour datablock its own
  // L/R footstep set, and each armour names one AudioProfile per T2 surface class
  // (soft/hard/metal/snow): the profiles themselves at player.cs:252-305 light, :424-477
  // medium, :595-648 heavy, and the datablock rows that select them at :1350-1357 light,
  // :1604-1611 medium, :1854-1861 heavy. Our FootstepSurface collapses those four classes to
  // the two this game distinguishes: terrain -> the class's `soft` recording, interior -> its
  // `metal` one. The left-foot take is the same one the light row already used
  // (light_LF_soft), so the armours stay comparable.
  'medium-footstep.m4a': 'audio.vl2/audio/fx/armor/med_LF_soft.m4a',
  'medium-footstep-metal.m4a': 'audio.vl2/audio/fx/armor/med_LF_metal.m4a',
  'heavy-footstep.m4a': 'audio.vl2/audio/fx/armor/heavy_LF_soft.m4a',
  'heavy-footstep-metal.m4a': 'audio.vl2/audio/fx/armor/heavy_LF_metal.m4a',
  'station-hum.m4a': 'audio.vl2/audio/fx/powered/station_hum.m4a',
  'generator-hum.m4a': 'audio.vl2/audio/fx/powered/generator_hum.m4a',
  'inventory-pad-on.m4a': 'audio.vl2/audio/fx/powered/inv_pad_on.m4a',
  'vehicle-screen-on.m4a': 'audio.vl2/audio/fx/powered/vehicle_screen_on2.m4a',
  'vehicle-screen-off.m4a': 'audio.vl2/audio/fx/powered/vehicle_screen_off.m4a',
  'station-denied.m4a': 'audio.vl2/audio/fx/powered/station_denied.m4a',
  // Issue #56 turret-impact samples. Each base turret's barrel script hangs its own recording
  // on its projectile's explosion: sentryTurret.cs:32-36 SentryTurretExpSound
  // (`soundProfile = SentryTurretExpSound`, :81) and plasmaBarrelLarge.cs:44-48
  // PlasmaBarrelExpSound (`soundProfile = PlasmaBarrelExpSound`, :173). The AA barrel declares
  // no recording of its own -- aaBarrelLarge.cs:121 reuses the Blaster's `blasterExpSound`
  // (blaster.cs:48-51 -> blaster_impact), which this manifest already ships.
  'turret-sentry-impact.m4a': 'audio.vl2/audio/fx/powered/turret_sentry_impact.m4a',
  'turret-plasma-impact.m4a': 'audio.vl2/audio/fx/powered/turret_plasma_explode.m4a',
  'spinfusor-fire.m4a': 'audio.vl2/audio/fx/weapons/spinfusor_fire.m4a',
  'chaingun-fire.m4a': 'audio.vl2/audio/fx/weapons/chaingun_fire.m4a',
  // Issue #56 Chaingun state recordings. chaingun.cs gives each ShapeBaseImageData state its
  // own sound: `ChaingunSwitchSound` on Activate (AudioProfile :46-52, `stateSound[0]`, :577),
  // `ChaingunSpinUpSound` on Spinup (:84-90, `stateSound[3]`, :600) and `ChaingunSpinDownSound`
  // on both Spindown and EmptySpindown (:76-82, `stateSound[5]`/:626 and `stateSound[6]`/:636).
  // Fire's own recording is the looping one already listed above (AudioDefaultLooping3d).
  'chaingun-activate.m4a': 'audio.vl2/audio/fx/weapons/chaingun_activate.m4a',
  'chaingun-spinup.m4a': 'audio.vl2/audio/fx/weapons/chaingun_spinup.m4a',
  'chaingun-spindown.m4a': 'audio.vl2/audio/fx/weapons/chaingun_spindown.m4a',
  'mortar-fire.m4a': 'audio.vl2/audio/fx/weapons/mortar_fire.m4a',
  'sniper-fire.m4a': 'audio.vl2/audio/fx/weapons/sniper_fire.m4a',
  'blaster-fire.m4a': 'audio.vl2/audio/fx/weapons/blaster_fire.m4a',
  'mortar-explode.m4a': 'audio.vl2/audio/fx/weapons/mortar_explode.m4a',
  // Issue #56 hand-grenade detonation. The thrown grenade's HandGrenadeExplosion carries
  // `soundProfile = GrenadeExplosionSound` (grenade.cs:180, and :307 for its underwater
  // sibling), which grenadeLauncher.cs:77-83 defines as `fx/weapons/grenade_explode.wav` --
  // NOT the flash grenade's `fx/explosions/grenade_flash_explode.wav` (flashGrenade.cs:8-13),
  // a different thrown item this game does not ship.
  'grenade-explode.m4a': 'audio.vl2/audio/fx/weapons/grenade_explode.m4a',
  'spinfusor-impact.m4a': 'audio.vl2/audio/fx/weapons/spinfusor_impact.m4a',
  'spinfusor-projectile.m4a': 'audio.vl2/audio/fx/weapons/spinfusor_projectile.m4a',
  'mortar-projectile.m4a': 'audio.vl2/audio/fx/weapons/mortar_projectile.m4a',
  'blaster-impact.m4a': 'audio.vl2/audio/fx/weapons/blaster_impact.m4a',
  'blaster-projectile.m4a': 'audio.vl2/audio/fx/weapons/blaster_projectile.m4a',
  'chaingun-impact.m4a': 'audio.vl2/audio/fx/weapons/chaingun_impact.m4a',
  'chaingun-projectile.m4a': 'audio.vl2/audio/fx/weapons/chaingun_projectile.m4a',
  'sniper-impact.m4a': 'audio.vl2/audio/fx/weapons/sniper_impact.m4a',
  'shrike-blaster-projectile.m4a': 'audio.vl2/audio/fx/vehicles/shrike_blaster_projectile.m4a',
  'vehicle-explosion.m4a': 'audio.vl2/audio/fx/explosions/vehicle_explosion.m4a',
  // Issue #51 repair audio. repairpack.cs:33-39 RepairPackFireSound is the beam itself
  // (`filename = "fx/packs/repair_use.wav"`, CloseLooping3d) and is what the repair gun's
  // Repair state plays (`stateSound[4]`, :153) and what the beam projectile carries
  // (`sound = RepairPackFireSound`, :46). The one-shot is the pack's own Activation:
  // RepairPackActivateSound (repairpack.cs:25-31, `fx/packs/packs.repairPackOn.wav`) on the
  // RepairPackImage Activate state, `stateSound[1]` (:79) -- the toggle that mounts the gun,
  // a different moment from the beam going live.
  'repair-beam.m4a': 'audio.vl2/audio/fx/packs/repair_use.m4a',
  'repair-activate.m4a': 'audio.vl2/audio/fx/packs/packs.repairPackOn.m4a',
  'flag-capture.m4a': 'audio.vl2/audio/fx/misc/flag_capture.m4a',
  'flag-snatch.m4a': 'audio.vl2/audio/fx/misc/flag_snatch.m4a',
  'flag-drop.m4a': 'audio.vl2/audio/fx/misc/flag_drop.m4a',
  'flag-taken.m4a': 'audio.vl2/audio/fx/misc/flag_taken.m4a',
  'flag-lost.m4a': 'audio.vl2/audio/fx/misc/flag_lost.m4a',
  'flag-return.m4a': 'audio.vl2/audio/fx/misc/flag_return.m4a',
  'outrider-engine.m4a': 'audio.vl2/audio/fx/vehicles/outrider_engine.m4a',
  'shrike-engine.m4a': 'audio.vl2/audio/fx/vehicles/shrike_engine.m4a',
  'shrike-blaster.m4a': 'audio.vl2/audio/fx/vehicles/shrike_blaster.m4a',
  'voice-target-destroyed.m4a': 'voice.vl2/audio/voice/Bot1/tgt.destroyed.m4a',
  'voice-flag-take.m4a': 'voice.vl2/audio/voice/Bot1/flg.take.m4a',
  'voice-thanks.m4a': 'voice.vl2/audio/voice/Bot1/gbl.thanks.m4a',
  'voice-defend-flag.m4a': 'voice.vl2/audio/voice/Bot1/def.flag.m4a',
  'voice-repair-me.m4a': 'voice.vl2/audio/voice/Bot1/rep.me.m4a',
  'voice-enemy-warning.m4a': 'voice.vl2/audio/voice/Bot1/wrn.enemy.m4a',
  'voice-yes.m4a': 'voice.vl2/audio/voice/Bot1/gbl.yes.m4a',
  'voice-no.m4a': 'voice.vl2/audio/voice/Bot1/gbl.no.m4a',
  'voice-nice.m4a': 'voice.vl2/audio/voice/Bot1/gbl.nice.m4a',
} as const;
