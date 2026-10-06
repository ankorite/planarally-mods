# CHANGELOG

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
