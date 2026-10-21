# PF1e Character Sheet

A PlanarAlly mod that adds a Pathfinder 1st Edition character sheet tab to shapes marked as
characters, with one-click import from a Hero Lab XML export (File > Custom Output > Export XML).
For the DM, any other token gets a limited sheet for monsters and NPCs.

Hero Lab is the source of truth: the sheet is read-only except for current HP. Edit the character in
Hero Lab, re-export and re-import to update the sheet, and only adjust current HP in PlanarAlly
during play.

## Installing

1. Download `pf1e-char-sheet-<version>.pam` from the latest release on the
   [Releases page](https://github.com/ankorite/planarally-mods/releases).
2. In PlanarAlly, open DM Settings → Mod and upload the `.pam`.
3. To update, upload the newer `.pam` the same way. Sheets already imported keep their data.

Requirements:

- A PlanarAlly server with the mod API (the `dev` branch or a release that includes mods). Built against
  mod API 0.6; older servers (0.2 to 0.5) still work, without one-click shared rolls.
- Hero Lab Classic, exporting with File > Custom Output > Export XML. Export with Hero Lab's own
  adjustments switched off and use the sheet's Adjustments tab instead, or they count twice.

## Reporting a bug

Open an issue on [GitHub](https://github.com/ankorite/planarally-mods/issues) with:

- what you did, what you expected, and what happened;
- the mod version (DM Settings → Mod, or the version in the update banner);
- the **Health check** from the sheet's Diagnostics tab (DM only) for the token involved;
- anything in the browser console (F12) starting with `[pf1e-sheet]`;
- if an import went wrong, the Hero Lab XML (or the part of it that matters).

## Known limitations

- Hero Lab is the only import source; there is no manual entry beyond current HP and the toggles.
- Adjustments cover the common PF1 rules (bonus stacking, max Dex from armor, 1.5x Strength for
  two-handed weapons, Constitution to max HP) but not every special case, e.g. off-hand weapons or
  natural attacks' secondary Strength.
- Spell formulas for macros are guessed from the spell's text; check them on the Spells tab.
- Re-importing keeps current HP (still full if it was full, otherwise capped at the new maximum).
- Duplicate token relies on PlanarAlly's Ctrl+C / Ctrl+V, so it replaces PlanarAlly's shape clipboard.
- See also the limitations listed under [Importing from Hero Lab](#importing-from-hero-lab).

This mod is MIT licensed (see `LICENSE.md`) and is not affiliated with Paizo Inc. or Lone Wolf
Development.

## Building

From the repository root:

```zsh
pnpm install
pnpm -F '@planarally/pf1e-char-sheet' build
pnpm zip pf1e-char-sheet
```

Upload the resulting `.pam` from `dist-zip/` in DM Settings → Mod.

### Checks and tests

```zsh
pnpm -F '@planarally/pf1e-char-sheet' lint:ci
pnpm -F '@planarally/pf1e-char-sheet' format:ci
pnpm -F '@planarally/pf1e-char-sheet' test
```

The unit tests (Vitest, in `src/__tests__/`) cover the Hero Lab parser, the adjustments, the shared
rules storage, resources, spell formulas, nat 20/1 detection and the update check.
`.github/workflows/ci-pf1e.yml` runs these, and builds every mod, on every pull request.

### Releasing

`.github/workflows/release-pf1e.yml` checks, tests and builds the mod and publishes a GitHub release
with the `.pam` attached when a tag `pf1e-v<version>` is pushed. A plain version (`1.0.1`) is a normal
release; one with a `-` (`1.1.0-beta.1`) is published as a pre-release.

1. Set the version in `mod.toml` and `package.json`, add it to the root `CHANGELOG.md`, and merge to
   `main` (the update check reads `main`'s `mod.toml`).
2. Tag that commit and push the tag:

    ```zsh
    git tag pf1e-v1.0.0
    git push origin pf1e-v1.0.0
    ```

The workflow refuses a tag that doesn't match the version in `mod.toml`.

## Source layout

- `mod.toml` — mod manifest
- `src/main.ts` — entry point: registers the shape tab and the tracker → sheet HP sync
- `src/access.ts` — DM check and character check, shared by the tab filter and the sheet
- `src/data.ts` — the `PF1Character` schema stored in the shape's DataBlock
- `src/CharSheet.vue` — the sheet UI (Sheet / Spells / Resources / Adjustments / Feats / Specials /
  Inventory / Token / Config tabs, or Sheet / Spells / Resources / Adjustments / Specials / Token / Config
  for a monster/NPC; Spells and Resources only when there are spells / limited-use resources). Being
  split up: the Adjustments, Feats, Inventory, Config and Diagnostics tabs and the rule card are already
  components in `src/sheet/`
- `src/sheet/` — the sheet's components, the context they share with `CharSheet.vue`
  (`context.ts`, provide / inject), the rule cards (`ruleCards.ts`) and the sheet's styles (`sheet.scss`)
- `src/herolab/parser.ts` — Hero Lab XML → `PF1Character` importer
- `src/customdata.ts` — exports the sheet to the token's Custom Data
- `src/roll.ts` — dice rolls through PlanarAlly's dice engine
- `src/trackers.ts` — HP tracker sync
- `src/auras.ts` — auras from Hero Lab senses and auras
- `src/resources.ts` — trackers for x/day and x/round abilities and spell slots
- `src/spells.ts` — spell dice macros and the formula guessed from a spell's text
- `src/adjustments.ts` — the built-in adjustments, PF1 stacking, and applying them to the character
- `src/diagnostics.ts` — the DM-only Diagnostics tab's reports
- `src/updates.ts` — checks GitHub for a newer version of the mod
- `src/crits.ts` — the natural 20 / natural 1 animation, from PlanarAlly's dice history
- `src/rules.ts` — rules text of feats, spells, skills and specials in the campaign's room blocks and
  PlanarAlly's compendium
- `src/duplicate.ts` — duplicates a monster/NPC token together with its sheet

## Importing from Hero Lab

On import the sheet is filled with:

- identity, classes and mythic path/tier (read from the class summary, as Hero Lab has no element for it), ability scores
- HP, AC (normal / touch / flat-footed), saves, BAB, CMB/CMD, initiative, speed
- melee and ranged attacks
- skills (ranks, class-skill flag, trained-only, total)
- feats and spells, with a short excerpt inline and the full rules text on hover (anywhere on a feat or
  special shows its name, category / type, source and uses, then the rules text)
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

## The sheet

The **Sheet** tab is laid out like Hero Lab's printed character sheet: black section bars, black
labels ("STR / Strength"), boxed numbers, and the paper sheet's breakdowns:

- the class line, race, size, gender, age, alignment and deity
- **Abilities**: score, modifier, and a temp adjustment / temp modifier when an adjustment changes it
  (hover a score for Hero Lab's base score)
- **HP** (total, current - the one editable number - and nonlethal), hit dice, **Initiative** = Dex + misc,
  **Speed** with armor and base speed, armor check penalty and max Dex
- **AC** = 10 + armor + shield + Dex + size + natural + deflection + dodge + misc, then touch and flat-footed
- **Saving throws** = base + ability + magic (resistance) + misc, and Hero Lab's situational modifiers
- **Base attack bonus** with the melee / ranged attack lines, **CMB** = BAB + Str + size/misc and
  **CMD** = 10 + BAB + Str + Dex + size/misc (and flat-footed CMD)
- a **Weapon** block per attack: attack bonus, critical, type, range and damage
- **Skills**: total = ability + ranks + misc, with class skill ✓, trained-only (T) and armor-check (A) flags;
  hover a skill for its breakdown, situational modifiers (marked *) and Hero Lab's rules text
- **Combat maneuvers**, **Languages**, **Money & experience**

Highlighted totals are roll buttons: click one to roll it. Whatever the Adjustments tab adds shows up in
a **Temp** box next to the breakdown, so the imported numbers stay visible. The **M** boxes put a roll in
PlanarAlly's dice macros (initiative, each save, each weapon, each skill).

The breakdowns need an import made with this version; an older import shows the totals only until it
is re-imported.

The **Token** tab has what acts on the token itself: **Push HP to tracker**, the auras with **Create /
update auras on the token**, and the Custom Data buttons. The other tabs use the same black bars.

### Config tab

The **Config** tab chooses what the sheet shows, per character; the choices are kept when you re-import.

- **Sheet sections**: switch off any block of the Sheet tab (e.g. Combat maneuvers, Money and experience).
- **Weapons**: hide individual weapons, e.g. a bite or unarmed strike you never use.
- **Skills**: hide individual skills, or **Hide skills without ranks** in one go (**Show all skills** undoes it).
- **Rule cards**: how many seconds to hover before a rule card appears (default 2; saved for this
  browser, for every sheet).
- **Natural 20 / natural 1**: switch the animation off (or on) for this browser.
- **Tabs**: hide tabs you don't use (Spells, Resources, Adjustments, Feats, Specials, Inventory, Token).

A hidden weapon or skill is also left out of PlanarAlly's dice macros, since its **M** box is no longer on
the sheet. Hiding a section or tab only hides it.

## Rule cards

Resting the mouse on a skill, feat, spell or special for 2 seconds (set on the Config tab, per
browser; 0 shows it at once) shows a rule card: the name in a black bar, a details line
(a skill's breakdown and flags, a feat's category, a spell's level, school, casting time, range,
duration and DC, a special's type, source and uses) and the rules text in paragraphs with
**Benefit:** / **Check:**-style labels in bold. Moving onto the card keeps it open; clicking a name
pins it, so long text can be scrolled. A pinned card for a feat, spell or skill that is in PlanarAlly's
compendium has an **Open in compendium** button, which opens that rule's page in the compendium panel.

## Natural 20 / natural 1

Whenever a d20 comes up a natural 20 or a natural 1, a short animation plays over the map: a gold
"NATURAL 20!" burst or a red, shaking "NATURAL 1", with who rolled and what (e.g. "Ulric · Attack: +3
greatsword"). It never blocks clicks and is gone after about two seconds.

- It works for every d20 roll the player sees: PlanarAlly's dice panel (2D, or 3D once the dice settle),
  rolls other players share with them, and this sheet's own rolls - not just the sheet's. Only the
  d20s that count: the lower die of a "keep highest" roll doesn't trigger it.
- Each player sees it for the rolls that reach them, so a roll shared only with the DM shows for the
  roller and the DM.
- Switch it off for this browser on the Config tab. With the system's "reduce motion" setting it fades
  in and out without bursting or shaking.

## Compendium

On a PlanarAlly server with the compendium (mod API 0.2 or later), the full rules text of feats, spells,
skills and a character's specials is stored **once per campaign** instead of on every token's sheet:

- On import, any feat, spell, skill or special text the campaign doesn't have yet is saved in shared
  room data blocks and registered in PlanarAlly's compendium as the **PF1e (Hero Lab)** book (Feats,
  Spells by school, Skills, Specials by category or source), where it can be browsed, searched and
  linked from chat and notes.
- The text comes off a sheet once the server is known to have it: from the next session (or as soon as
  another player's save brings it). Until then the sheet keeps it, so nothing can be lost. A typical
  character's sheet data ends up about three quarters smaller.
- Older sheets, and sheets whose text is still on them, are moved the same way whenever they are
  opened; a rule the compendium lost is written back from a sheet that still has its text.
- A special is stored under its name without what changes as the character levels: "Trap Sense +2
  (Ex)" and "Trap Sense +3 (Ex)" are both **Trap Sense**, so a level-up doesn't add another entry. Two
  different texts with the same short name get their source added ("Mutagen (Investigator)"). Sheets
  from 1.0 move their specials to the short names when opened; the old full-name entries are kept but
  no longer listed once the same text is under the short name.
- The rules are spread over 32 small blocks, so two players saving at once rarely touch the same one.
  (Rules stored by the 0.22 betas in a single block are still read.)
- Every client registers the book when the game loads, and again when anyone's import adds rules.
- A monster's or NPC's specials stay on its DM-only sheet, so its own abilities never appear in the
  players' compendium (its feats, spells and skills are general rules and do go there).
- A server without the compendium keeps the text on each sheet, as before.
- The Diagnostics health check reports the compendium's size, how many rules aren't confirmed on the
  server yet, and this sheet's size.

## Monsters and NPCs

A token that isn't a PlanarAlly character gets a limited sheet, visible to the DM only. Export the
monster or NPC from Hero Lab the same way as a character and import it on the token. It works like the
full sheet (read-only except current HP; the token is renamed, and gets an HP tracker, auras and dice
macros) but only has these tabs:

- **Sheet**: the paper-style front page (see The sheet)
- **Adjustments**: buffs and conditions, as on the full sheet (see Adjustments)
- **Spells**: only when it has spells, as on the full sheet (see Spells)
- **Resources**: only when it has limited-use abilities or spell slots, as on the full sheet
- **Specials**: Hero Lab's special abilities
- **Token**: HP push, auras and Custom Data
- **Config**: what the sheet shows (see Config tab)

**Duplicate token** in the header makes a copy of the token with its sheet intact, e.g. to fill an
encounter with five orcs from one import. The mod API can't create tokens, so it uses PlanarAlly's own
copy & paste (it selects the token and presses Ctrl+C, Ctrl+V for you; Cmd on a Mac): the copy has the
same image, size, name, HP, trackers, auras and dice macros, lands on the current layer just offset from
the original, and is selected afterwards. The sheet data is copied to it, pointing at the copy's own
trackers and auras, so each token tracks its own HP and uses. It replaces whatever was on PlanarAlly's
shape clipboard.

The header shows "Monster / NPC" to tell the two apart. HP changes made on the token's tracker flow
back to the sheet as for characters; changing HP on a token that has no imported sheet never creates
one.

## Adjustments

The **Adjustments** tab switches buffs and conditions on and off, like Hero Lab's Adjust tab. Hero
Lab's own adjustments can't be read from its XML export (only their combined result is in the numbers),
so **export from Hero Lab with its adjustments switched off** and switch them on here instead,
otherwise they count twice.

- **From Hero Lab:** mutagens and cognatogens. Hero Lab has an alchemist or investigator add each
  brewed mutagen as an item ("Mutagen: +4 Dex, -2 Wis, +2 Nat AC"), and each one becomes an adjustment
  here: an alchemical bonus to the ability, the penalty, and natural armor. Hero Lab doesn't say whether
  it was drunk when the file was exported, so the sheet looks at the scores: if the mutagen's penalty
  is already in them (Wis 13 showing as 11), it counts the mutagen as active in the export, already
  in the numbers, and starts it ticked. Untick it when it wears off and the sheet takes it back out.
  If the guess is wrong, fix it with the mutagen's **active in the export** box. Ticking a mutagen
  drinks a dose: it uses one of the mutagen's uses on the Resources tab (and its tracker, if tracked);
  unticking it gives nothing back. With no doses left it still switches on, and says so.
  An investigator's **Studied Combat** is here too, from its special ("Studied Combat (+3, 4 rounds)"):
  +3 insight on melee attacks and +3 on melee damage. It starts off.
- **Built-in:** Bless, Prayer, Haste, Heroism, Greater Heroism, Good Hope, Divine Favor (+1), Shield
  of Faith (+2), Holy Aura, Mage Armor, Shield, Barkskin (+2), the six ability buffs (Bull's Strength,
  Cat's Grace, ...), Enlarge Person, Reduce Person, Inspire Courage +1 to +4, Rage, Flanking, Charging, Fighting
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
CMB, CMD and Str skills (a finesse weapon attacks with Dex instead, and adds Dex to damage with Fencing
Grace, Slashing Grace, Dervish Dance or the agile property - the sheet works out which weapons from Hero
Lab's attack and damage numbers); Dex to ranged attack, AC, Reflex, initiative, CMD and Dex skills; Con to Fort;
Wis to Will; and every ability to its skills. Haste adds one extra attack at the highest bonus.

The choices are stored with the character, shared with the table and kept when you re-import.

Not modelled: HP from Con changes, x1.5 Str on two-handed damage, situational parts ("+2 vs fear"),
and spells whose bonus scales with caster level beyond the listed value (add a custom one). Weapons
from imports made before this version count as melee until the character is re-imported.

## Spells

The **Spells** tab lists each spellcasting class (caster level, concentration, slots per day) with its
spells grouped by level. Each spell shows its DC (hover for the save), range and duration under its
name; its rules text is on its rule card (rest the mouse on the name, or click it).
Only spells the character can cast now are listed: Hero Lab also exports spells known above the highest
level the class can cast yet (an oracle's whole cure line, for instance), and those are left out until
a re-import after the character can cast them.
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

Each spell also shows its **casting defensively** check: the class's concentration bonus (plus 4 with
the Combat Casting feat, which Hero Lab doesn't include in its concentration total) against DC 15 + 2 ×
the spell's level, with a **Roll** button for 1d20 + concentration.

## Trackers for limited-use abilities

Hero Lab exports every limited-use ability and charged item as a tracked resource ("Darkness (3/day)",
"Bardic Performance (20 rounds/day)", "Wand of Cure Light Wounds" with its charges). Each of them, and
each spell level's slots per day ("Oracle level 1 slots"), is counted on the Resources tab, and any of
them can also be put on the token as a PlanarAlly tracker by ticking its **Track** box. Nothing is
tracked on the token until you tick it, so the token only gets the trackers you want.

### Resources tab

The **Resources** tab (shown when there are any) lists every resource with how its uses work ("3 per
day", "20 rounds per day", "1 per week", "50 charges" for wands, staffs, rods and anything named with
charges, otherwise "N uses") and the **uses left**, with − / + buttons and a field to type a number.

- The sheet keeps the uses left for every resource, whether or not it has a tracker on the token.
- With **Track** ticked (it starts unticked) the resource also has a tracker on the token, and the two stay in step both
  ways: using one on the sheet updates the tracker, and changing the tracker in PlanarAlly updates
  the sheet. Unticking removes the tracker but keeps the count; ticking again makes a tracker that
  starts from the sheet's count.
- Nothing refills on its own, which is right for charges (a wand's don't come back). **New day**
  refills the daily ones (x/day, rounds/day, spell slots) and leaves charges and plain uses alone.
- Re-importing the same character keeps the uses left (full stays full at a new maximum, otherwise
  capped at it). A new resource, or a different character, starts at Hero Lab's uses left.

### Trackers on the token

- New trackers start at the sheet's uses left (at first, the uses left in the Hero Lab export).
- Re-importing never refills or overwrites a tracker's current value. It updates the maximum, follows
  Hero Lab's name ("20 rounds/day" → "22 rounds/day") unless you renamed the tracker, creates missing
  ones and removes the ones it made for abilities that are gone.
- An ability the sheet doesn't manage yet adopts an existing tracker with exactly its name instead of
  adding a second one. Other hand-made trackers, and the HP tracker, are never touched.
- They aren't drawn as bars on the token. On a character they're visible to everyone; on a monster
  or NPC only the DM sees them.
- Each one is switched on with its **Track** checkbox on the Resources tab, or on the Specials tab
  next to the ability (spell slots and anything else without a matching special are listed there
  under "Other trackers"). Ticking adds the tracker; unticking removes it from the token. The choice
  is kept when you re-import; a resource new in the export starts unticked.
- Sheets imported before 0.22.0-beta.3, when everything was tracked by default, keep the trackers
  they have.
- **Create / update trackers on the token** on the Resources tab re-creates a ticked resource's
  tracker if it was deleted, and fixes maximums, without a re-import.

## HP tracker

HP syncs both ways with the token's tracker named "HP" (case- and space-insensitive):

- **Sheet → tracker**: committing the current-HP field (blur / Enter) updates the tracker. After an
  import, or with **Push HP to tracker**, the tracker is created if the token has none.
- **Tracker → sheet**: any change to the HP tracker, from you or another player, updates current HP
  on the sheet.
- Only current HP flows back to the sheet; max HP comes from the Hero Lab import.
- Trackers with any other name are never touched.

## Dice rolls

The highlighted totals on the Sheet tab are the roll buttons: ability modifiers (checks), initiative,
saves, CMB, skills and the weapons. Each weapon gets one button per iterative attack, labelled with its
bonus (`+13` `+8` `+3`), and its damage is a button when it has dice.

Every button rolls against the token's Custom Data fields rather than a fixed number, e.g.
`1d20 + {STR mod}`, `1d20 + {Spellcraft}`, `1d20 + {Atk greatsword} - 5`, `{Roll Damage greatsword}`. Editing a value in
PlanarAlly's Custom Data tab (a buff, a penalty) therefore changes every roll that uses it. If a field
is missing, the sheet re-exports Custom Data once and retries; it never rolls with a modifier silently
dropped.

On a server with mod API 0.6 or later, a button rolls straight away through PlanarAlly's own dice
API: the same roll as its dice tool (3D dice if you use them, the notification, the dice history), in
one click. Two modes, chosen above the tabs and remembered per browser:

- **Roll (shared as your dice tool)** (default): shared the way your dice tool's "share with" is set.
- **Roll for me only**: nobody else sees it.

On an older server the two modes are:

- **PA dice panel** (default): the formula is placed in PlanarAlly's dice panel and you press Enter.
  This is PlanarAlly's native roll: 3D dice, "share with", and the notification other players see.
- **Quick roll**: rolled immediately and shown only to you. With **Result popup** on (the default),
  PlanarAlly's result card opens and the roll is added to your dice history.

Crit confirmation, crit multipliers and per-weapon crit ranges are not handled; **Dmg** rolls the base
damage formula (the `Roll Damage <weapon>` macro).

## Custom Data export

Every import (and the Token tab's **Export to Custom Data** button) writes the sheet into the token's
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
    - `Roll Initiative`, `Roll Fortitude`, `Roll Reflex`, `Roll Will`, each of which can be switched
      off with its **M** box on the Sheet tab (the roll buttons keep working)
    - per weapon, `Roll Attack <weapon>` (`1d20 + {Atk <weapon>}`), or one per attack for iterative
      attacks (`+13/+8/+3` → `Roll Attack <weapon> 1st|2nd|3rd`: `1d20 + {Atk <weapon>}`, `... - 5`,
      `... - 10`), then `Roll Damage <weapon>` (the damage dice; none for flat damage like "6").
      Every weapon is included until you untick the **M** box on its Weapon block; its sheet buttons
      keep working either way.
    - `Roll <skill>` for each skill ticked in the **M** column of the Sheet tab's skills. The choice is
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
- A few **ranged abilities** listed elsewhere in Hero Lab get the same kind of aura for their range:
  currently the oracle's **Life Link** (e.g. 140 ft., the reach of its bonds).

The Token tab lists them with a **Create / update auras on the token** button. The sheet only manages
auras it created: re-importing updates changed radii, removes auras Hero Lab no longer lists and
recreates deleted ones, while auras you made by hand are never touched. To hide a sheet aura without
it coming back on the next import, switch it off in PlanarAlly instead of deleting it. Radii are in
feet.

## Who sees what

- **The full sheet** only appears on characters the viewer can edit; the DM can always see it.
- **The limited sheet** (monsters and NPCs) appears on every other token, for the DM only. A DM
  previewing as a "fake player" doesn't see it.
- **The Diagnostics tab** is DM-only.
- **The update message** (a newer version on GitHub) is DM-only.

## Diagnostics

The DM-only **Diagnostics** tab has two read-only reports to copy into a bug report:

- **Health check**: checks the sheet on this token. It verifies that every PlanarAlly API function the
  sheet uses exists, compares the HP tracker, Custom Data and auras with the sheet, resolves every roll
  formula without rolling it, and lists recent tracker / Custom Data events. Problems are listed at
  the top.
- **Full API dump**: everything PlanarAlly's mod API exposes, plus a scan of PlanarAlly's own code
  for hook and event names. It is large; use it when a PlanarAlly update breaks something.

## Update check

When the DM opens a sheet, the mod reads the `version` in this package's `mod.toml` on the repository's
`main` branch (from `raw.githubusercontent.com`) and compares it with the installed version. If GitHub's
is newer, a banner at the top of the sheet says so, with a link to the GitHub Releases page to download the new `.pam`. **✕** hides it until
the next new version.

- Only the DM sees it, and only the DM's browser contacts GitHub, once per page load.
- An installed version newer than `main` (a test build) shows nothing.
- If GitHub can't be reached, or the repository is made private, there's no banner. The outcome is
  always written to the browser console (F12) as `[pf1e-sheet] update check: ...`: the installed and
  GitHub versions, or the error, e.g. a request blocked by the server's Content-Security-Policy or a
  browser extension.
- GitHub caches the file for up to 5 minutes, so a just-merged version can take a few minutes to show.

## Sheet width

The **S / M / L** buttons at the right of the tab row set the sheet width (remembered per browser).
Wide tables scroll inside their own container.
