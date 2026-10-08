# CHANGELOG

## [2026-10-08]

- pf1e-char-sheet v0.22.0-beta.1, the first beta release:
    - released as a `.pam` on GitHub Releases by a workflow (`.github/workflows/release-pf1e.yml`)
      when a `pf1e-v<version>` tag is pushed; README has install, bug-report and release steps
    - MIT licensed (`LICENSE.md`, included in the `.pam`)
    - update check understands pre-release versions (`0.22.0-beta.1` < `0.22.0-beta.2` < `0.22.0`)
    - fixed: Duplicate token could take a token the DM clicked while waiting for the copy
    - fixed: with several players connected, a tracker change was written to the sheet by every client
    - fixed: damage with more than one dice term ("1d8+2d6 fire") was cut short or adjusted wrongly
    - fixed: a max HP of 0 was pushed to the HP tracker; clearing the current-HP field stored a non-number
    - fixed: a spell listed twice in the Hero Lab export showed up twice
    - fixed: spells with an empty class attribute were matched to the first spellcasting class
    - re-importing the same character keeps current HP (full stays full, otherwise capped at the new max)
- Add 5e SRD 5.1 mod
- Add license to .pam file in zip script
- pf1e-char-sheet v0.21.2: the update check writes its outcome to the browser console
  (`[pf1e-sheet] update check: ...`): installed vs GitHub version, or why GitHub couldn't be reached
- pf1e-char-sheet v0.21.1: trackers are labelled by how their uses work ("3 per day", "20 rounds per
  day", "50 charges", "N uses") instead of always "per day"; wands and other charged items don't
  recharge
- pf1e-char-sheet: the import message can be dismissed (✕), and with more than 5 trackers it gives
  a count instead of every name

## [2026-10-07]

- pf1e-char-sheet v0.21.0:
    - trackers for every x/day and x/round ability (Hero Lab's tracked resources) and for spell slots
      per day, created on import and kept in step on re-import without touching current values
    - Spells tab of its own, only when there are spells, with DC, range and duration
    - spell dice macros: a Macro toggle per spell with a formula guessed from the spell's text (editable)
    - fixed: spells without a spell class (e.g. a monster's racial spellcasting) were dropped on import
    - update check: the DM sees a message on the sheet when a newer version is on GitHub
    - Duplicate token button on the monster/NPC sheet: copies the token (PlanarAlly's own copy & paste)
      with its sheet, trackers, auras and dice macros
    - Track checkboxes on the Specials tab switch individual ability trackers off and on

- pf1e-char-sheet v0.20.0:
    - limited sheet for monsters and NPCs: any token that isn't a character gets a DM-only sheet with
      Core, Combat, Skills, Adjustments and Specials tabs, filled from a Hero Lab import
    - uses the official `@planarally/mod-api` types for trackers, the event bus, data blocks and tab
      registration, and implements `dispose`
    - the sheet follows the focused token instead of the active character
    - Adjustments tab: built-in PF1 buffs and conditions plus custom adjustments, toggled on and off,
      with PF1 stacking, applied to the sheet's numbers, rolls and dice macros
    - damage macros use only the leading dice formula ("2d6+4 plus grab" -> "2d6+4")
    - fixed: an open sheet kept showing the old current HP after the token's HP tracker was edited

## [2026-10-06]

- removed the api lib in favour of the new npm package `@planarally/mod-api`
- updated all mods to the latest state where relevant
- fixed the obfuscated trackers mod colour setup
- swapped out prettier+eslint for oxfmt+oxlint
- Added pf1e-char-sheet mod (v0.18.0): Pathfinder 1e character sheet with Hero Lab XML import,
  HP tracker sync, auras, and dice rolls from the token's Custom Data
    - one roll button per iterative attack (`+13/+8/+3`)
    - Diagnostics tab reduced to two read-only reports: a health check and a full API dump
    - ported to the `@planarally/mod-api` npm package and the new toolchain
- pf1e-char-sheet v0.19.0: roll macros moved out of the `/rolls` branch to the top level of Custom Data,
  limited to initiative, saves, attacks and damage, plus skills picked in a new Macro column on the
  Skills tab; each weapon's attack and damage macros can be switched off in a Macro column on the
  Combat tab

## [2025-05-04]

- Updated all packages to the new version of the mod API
- Added wildsea mod
- Modified obfuscated-trackers example to configure the tracker in a separate shape tab
