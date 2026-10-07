# PF1e Character Sheet

A PlanarAlly mod that adds a Pathfinder 1st Edition character sheet tab to shapes marked as
characters, with one-click import from a Hero Lab XML export (File > Custom Output > Export XML).
For the DM, any other token gets a limited sheet for monsters and NPCs.

Hero Lab is the source of truth: the sheet is read-only except for current HP. Edit the character in
Hero Lab, re-export and re-import to update the sheet, and only adjust current HP in PlanarAlly
during play.

## Building

From the repository root:

```zsh
pnpm install
pnpm -F '@planarally/pf1e-char-sheet' build
pnpm zip pf1e-char-sheet
```

Upload the resulting `.pam` from `dist-zip/` in DM Settings → Mod.

## Source layout

- `mod.toml` — mod manifest
- `src/main.ts` — entry point: registers the shape tab and the tracker → sheet HP sync
- `src/access.ts` — DM check and character check, shared by the tab filter and the sheet
- `src/data.ts` — the `PF1Character` schema stored in the shape's DataBlock
- `src/CharSheet.vue` — the sheet UI (Core / Combat / Skills / Adjustments / Feats / Spells / Specials /
  Inventory tabs, or Core / Combat / Skills / Adjustments / Spells / Specials for a monster/NPC; Spells only
  when there are spells)
- `src/herolab/parser.ts` — Hero Lab XML → `PF1Character` importer
- `src/customdata.ts` — exports the sheet to the token's Custom Data
- `src/roll.ts` — dice rolls through PlanarAlly's dice engine
- `src/trackers.ts` — HP tracker sync
- `src/auras.ts` — auras from Hero Lab senses and auras
- `src/resources.ts` — trackers for x/day and x/round abilities and spell slots
- `src/spells.ts` — spell dice macros and the formula guessed from a spell's text
- `src/adjustments.ts` — the built-in adjustments, PF1 stacking, and applying them to the character
- `src/diagnostics.ts` — the DM-only Diagnostics tab's reports

## Importing from Hero Lab

On import the sheet is filled with:

- identity, classes, ability scores
- HP, AC (normal / touch / flat-footed), saves, BAB, CMB/CMD, initiative, speed
- melee and ranged attacks
- skills (ranks, class-skill flag, trained-only, total)
- feats and spells, with a short excerpt inline and the full rules text on hover (ⓘ)
- spellcasting per class (caster level, concentration, slots/day, known spells with DC, range and
  duration), grouped by spell level; spells without a spell class, such as a monster's racial
  spellcasting, get their own group
- limited-use abilities (Hero Lab's tracked resources: every x/day and x/round ability)
- specials (senses, auras, defensive/offensive abilities, spell-like abilities, items, ...)
- inventory (magic items and gear, with quantity / weight / cost)

After a successful import the token is renamed to the character's name, the HP tracker is
created or updated, the x/day, x/round and spell-slot trackers and the auras are created, and the
sheet is exported to Custom Data.

Only the character's own data is read: a nested minion (animal companion, eidolon, mount) is never
mixed into the character's stats or lists.

Known limitations:

- Prepared casters' memorized spells have only been tested with empty slots.
- Archetypes are kept as part of the class name (`"Oracle (Dual-Cursed Oracle)"`), as Hero Lab exports them.
- Only the first `<character>` in a file is imported.

## Monsters and NPCs

A token that isn't a PlanarAlly character gets a limited sheet, visible to the DM only. Export the
monster or NPC from Hero Lab the same way as a character and import it on the token. It works like the
full sheet (read-only except current HP; the token is renamed, and gets an HP tracker, auras and dice
macros) but only has these tabs:

- **Core**: race, size, classes, ability scores with check rolls, auras and the Custom Data buttons
- **Combat**: HP, AC, saves, initiative, speed, BAB/CMB/CMD, and the attacks with roll buttons
- **Skills**: skills with roll buttons and the Macro column
- **Adjustments**: buffs and conditions, as on the full sheet (see Adjustments)
- **Spells**: only when it has spells, as on the full sheet (see Spells)
- **Specials**: Hero Lab's special abilities

The header shows "Monster / NPC" to tell the two apart. HP changes made on the token's tracker flow
back to the sheet as for characters; changing HP on a token that has no imported sheet never creates
one.

## Adjustments

The **Adjustments** tab switches buffs and conditions on and off, like Hero Lab's Adjust tab. Hero
Lab's own adjustments can't be read from its XML export (only their combined result is in the numbers),
so **export from Hero Lab with its adjustments switched off** and switch them on here instead,
otherwise they count twice.

- **Built-in:** Bless, Prayer, Haste, Heroism, Greater Heroism, Good Hope, Divine Favor (+1), Shield
  of Faith (+2), Holy Aura, Mage Armor, Shield, Barkskin (+2), the six ability buffs (Bull's Strength,
  Cat's Grace, ...), Enlarge Person, Inspire Courage +1 to +4, Rage, Flanking, Charging, Fighting
  Defensively, Shaken, Sickened and Fatigued.
- **Custom:** a name and one or more effects (amount, bonus type, what it changes: an ability score,
  attack, melee or ranged attack, damage, AC, saves, skills, initiative, CMD or speed). New ones are
  switched on straight away.

Enabled adjustments are applied to everything the sheet shows and rolls, and to the token's dice
macros (Custom Data is re-exported on every change). A line under the header lists what's on.
Bonuses follow PF1 stacking: same-type bonuses don't stack (only the highest counts), while dodge,
circumstance and untyped bonuses do, and penalties always add up. AC bonuses land on touch and
flat-footed AC by type (armor, shield and natural don't apply to touch AC; dodge doesn't apply when
flat-footed). An ability change carries through to what it feeds: Str to melee attack, melee damage,
CMB, CMD and Str skills; Dex to ranged attack, AC, Reflex, initiative, CMD and Dex skills; Con to Fort;
Wis to Will; and every ability to its skills. Haste adds one extra attack at the highest bonus.

The choices are stored with the character, shared with the table and kept when you re-import.

Not modelled: HP from Con changes, x1.5 Str on two-handed damage, situational parts ("+2 vs fear"),
and spells whose bonus scales with caster level beyond the listed value (add a custom one). Weapons
from imports made before this version count as melee until the character is re-imported.

## Spells

The **Spells** tab lists each spellcasting class (caster level, concentration, slots per day) with its
spells grouped by level: DC (hover for the save), range, duration, and the rules text on hover (ⓘ).
It only appears when the character or creature has spells.

Each spell has a **Macro** checkbox, a formula and a **Roll** button. Hero Lab doesn't export a spell's
dice as data, only its rules text, so the formula is guessed from that text at the spell's caster
level, e.g. at caster level 7:

- "1d6 points of fire damage per caster level (maximum 10d6)" → `7d6`
- "cures 1d8 points of damage + 1 point per caster level (maximum +5)" → `1d8+5`
- "1d6 points of damage per two caster levels (maximum 5d6)" → `3d6`

Only dice that deal damage or heal count ("lingers 1d6 rounds" doesn't). Edit the formula if the guess
is wrong or missing; clear the field to go back to the guess. Ticked spells with a formula become
`Cast <spell>` dice macros. The choices and edited formulas are saved with the character and kept when
you re-import.

## Trackers for limited-use abilities

Hero Lab exports every x/day and x/round ability as a tracked resource ("Darkness (3/day)", "Bardic
Performance (20 rounds/day)"). Each becomes a PlanarAlly tracker on the token, as does each spell
level's slots per day ("Oracle level 1 slots"), so uses can be ticked off in play. They're created on
import and with **Create / update trackers on the token** on the Core tab, which lists them.

- New trackers start at the uses left in the Hero Lab export.
- Re-importing never refills or overwrites a tracker's current value. It updates the maximum, follows
  Hero Lab's name ("20 rounds/day" → "22 rounds/day") unless you renamed the tracker, creates missing
  ones and removes the ones it made for abilities that are gone.
- An ability the sheet doesn't manage yet adopts an existing tracker with exactly its name instead of
  adding a second one. Other hand-made trackers, and the HP tracker, are never touched.
- They aren't drawn as bars on the token. On a character they're visible to everyone; on a monster
  or NPC only the DM sees them.

## HP tracker

HP syncs both ways with the token's tracker named "HP" (case- and space-insensitive):

- **Sheet → tracker**: committing the current-HP field (blur / Enter) updates the tracker. After an
  import, or with **Push HP to tracker**, the tracker is created if the token has none.
- **Tracker → sheet**: any change to the HP tracker, from you or another player, updates current HP
  on the sheet.
- Only current HP flows back to the sheet; max HP comes from the Hero Lab import.
- Trackers with any other name are never touched.

## Dice rolls

Roll buttons are on the Core tab (ability checks), Skills tab, and Combat tab (initiative, saves, CMB
and the attacks table). Each weapon gets one button per iterative attack, labelled with its bonus
(`+13` `+8` `+3`), plus **Dmg** when the damage has dice.

Every button rolls against the token's Custom Data fields rather than a fixed number, e.g.
`1d20 + {STR mod}`, `1d20 + {Spellcraft}`, `1d20 + {Atk greatsword} - 5`, `{Roll Damage greatsword}`. Editing a value in
PlanarAlly's Custom Data tab (a buff, a penalty) therefore changes every roll that uses it. If a field
is missing, the sheet re-exports Custom Data once and retries; it never rolls with a modifier silently
dropped.

Two roll modes, chosen above the tabs and remembered per browser:

- **PA dice panel** (default): the formula is placed in PlanarAlly's dice panel and you press Enter.
  This is PlanarAlly's native roll: 3D dice, "share with", and the notification other players see.
- **Quick roll**: rolled immediately and shown only to you. With **Result popup** on (the default),
  PlanarAlly's result card opens and the roll is added to your dice history.

Crit confirmation, crit multipliers and per-weapon crit ranges are not handled; **Dmg** rolls the base
damage formula (the `Roll Damage <weapon>` macro).

## Custom Data export

Every import (and the Core tab's **Export to Custom Data** button) writes the sheet into the token's
Custom Data under the source `pf1e-sheet`. Only that source is ever changed: elements you made in
PlanarAlly are never touched, and **Remove sheet data from Custom Data** deletes only what the sheet
wrote.

What is written:

- `/abilities`: `STR`, `STR mod`, ... for all six abilities.
- `/combat`: `Init`, `Fort`, `Ref`, `Will`, `BAB`, `CMB`, `CMD`, `AC`, `Touch AC`, `Flatfooted AC`,
  `Max HP`, `Speed`, and `CL <class>` / `Concentration <class>` for each spellcasting class.
  Current HP is not exported; it lives in the tracker.
- `/skills`: one number per skill, e.g. `Spellcraft`.
- `/attacks`: per weapon, `Atk <weapon>` (the first attack bonus; later iterative attacks are offsets
  from it, so one edit moves them all).
- Roll macros, at the top level rather than in a branch:
    - `Roll Initiative`, `Roll Fortitude`, `Roll Reflex`, `Roll Will`
    - per weapon, `Roll Attack <weapon>` (`1d20 + {Atk <weapon>}`), or one per attack for iterative
      attacks (`+13/+8/+3` → `Roll Attack <weapon> 1st|2nd|3rd`: `1d20 + {Atk <weapon>}`, `... - 5`,
      `... - 10`), then `Roll Damage <weapon>` (the damage dice; none for flat damage like "6").
      Every weapon is included until you untick it in the **Macro** column of the Combat tab's attacks
      table; its sheet buttons keep working either way.
    - `Roll <skill>` for each skill ticked in the **Macro** column of the Skills tab. The choice is
      saved with the character and kept when you re-import (as is the attack choice).
    - `Cast <spell>` for each spell ticked in the **Macro** column of the Spells tab, with its formula
      (see Spells).

PlanarAlly lists every roll macro in the **Dice Macros** panel of its dice prompt while the token is
selected; click one and press Enter to roll it. Only these rolls are macros: everything else is a
number, so ability checks, CMB and Concentration stay on the sheet's buttons and out of the panel. You
can also type your own formulas in the dice prompt, such as `1d20 + {STR mod} + {BAB}`.

Names contain only letters, digits and spaces so they work as `{variables}` (e.g. "Knowledge (arcana)"
becomes "Knowledge arcana"), and are unique across all prefixes. Re-exporting only changes what
differs and removes elements the sheet no longer writes. The elements are editable in PlanarAlly, but
the next import overwrites them.

## Auras

Auras are created from the Hero Lab specials:

- **Senses** with a range (Darkvision, Blindsight) become a vision aura of that radius, not drawn.
  Senses without a range (Low-Light Vision, Scent) are skipped.
- **Auras** with a radius (e.g. Aura of Courage, 10 ft.) become a visible translucent radius aura.

The Core tab lists them with a **Create / update auras on the token** button. The sheet only manages
auras it created: re-importing updates changed radii, removes auras Hero Lab no longer lists and
recreates deleted ones, while auras you made by hand are never touched. To hide a sheet aura without
it coming back on the next import, switch it off in PlanarAlly instead of deleting it. Radii are in
feet.

## Who sees what

- **The full sheet** only appears on characters the viewer can edit; the DM can always see it.
- **The limited sheet** (monsters and NPCs) appears on every other token, for the DM only. A DM
  previewing as a "fake player" doesn't see it.
- **The Diagnostics tab** is DM-only.

## Diagnostics

The DM-only **Diagnostics** tab has two read-only reports to copy into a bug report:

- **Health check**: checks the sheet on this token. It verifies that every PlanarAlly API function the
  sheet uses exists, compares the HP tracker, Custom Data and auras with the sheet, resolves every roll
  formula without rolling it, and lists recent tracker / Custom Data events. Problems are listed at
  the top.
- **Full API dump**: everything PlanarAlly's mod API exposes, plus a scan of PlanarAlly's own code
  for hook and event names. It is large; use it when a PlanarAlly update breaks something.

## Sheet width

The **S / M / L** buttons at the right of the tab row set the sheet width (remembered per browser).
Wide tables scroll inside their own container.
