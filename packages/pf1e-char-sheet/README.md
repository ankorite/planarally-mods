# PF1e Character Sheet

A PlanarAlly mod that adds a Pathfinder 1st Edition character sheet tab to
shapes marked as characters, with one-click import from a Hero Lab XML export.

## Layout

- `mod.toml` — mod manifest (metadata PA reads when the `.pam` is uploaded)
- `src/main.ts` — mod entry point, registers the shape tab
- `src/data.ts` — the `PF1Character` schema stored in the shape's DataBlock
- `src/CharSheet.vue` — the sheet UI (Core / Combat / Skills / Feats & Spells / Inventory tabs)
- `src/herolab/parser.ts` — Hero Lab XML → `PF1Character` importer

## Integrating into the planarally-mods workspace

1. Drop this folder into `packages/pf1e-char-sheet/` in your `planarally-mods` checkout.
2. Add it to `pnpm-workspace.yaml` if it isn't picked up automatically by the `packages/*` glob.
3. From the repo root:
   ```
   pnpm install
   pnpm -r build-api
   pnpm -F '@planarally/pf1e-char-sheet' build
   pnpm zip pf1e-char-sheet
   ```
4. Upload the resulting `.pam` from `dist-zip/` in DM Settings → Mod.

## HP tracker integration

Two-way, built on the real runtime API (see "Round 1/2 findings" below), not the stale published types.

- **Sheet -> tracker** (`trackers.ts` `pushHp`, called from `CharSheet.vue`): when you commit the
  current-HP field (blur / Enter - deliberately not every keystroke), the token's tracker named
  "HP" (case/space-insensitive) is updated via `trackers.update`. After a Hero Lab import, and via
  the **Push HP to tracker** button, the tracker is **created** if the token has none
  (`trackers.add`: name "HP", drawn as a bar, visible, PA's default colours).
- **Tracker -> sheet** (`main.ts` `onTrackerUpdated`): PA emits `tracker:updated` on `api.eventBus`
  after every tracker change (local UI or another player). If it is an HP tracker on a character
  shape, the new **current** value is written into the sheet's DataBlock.
- **Only current HP flows back.** Max HP belongs to the Hero Lab import (the sheet is read-only), and
  a hand-made tracker commonly has `maxvalue` 0, which must never overwrite a real max.
- A tracker named something else (e.g. PA's default "New tracker") is never touched.

Unverified: whether the DataBlock write from `main.ts` refreshes the open sheet immediately or only
after the server round-trip - check this when testing tracker -> sheet.

## Token rename on import

After a successful import the token is renamed to the character's name with
`api.systems.properties.setName(localId, name, {ui: true, server: true})`. Verified via the
diagnostics build: it updates the shape's property state, and PA's source sends the change to the
server when `server` is true. (The earlier attempt mutated `systemsState.properties.mutable.data`,
which is why it did nothing.) Still worth confirming it survives a page reload.

## Dice rolls

Roll buttons: Core tab (ability checks), Skills tab, Combat tab (initiative, saves, CMB) and the attacks
table (one button per iterative attack, labelled with its bonus - `+13` `+8` `+3` - and Dmg when the
damage has dice).

**Every button rolls against the token's Custom Data fields, never a pasted number**: `1d20 +
{STR mod}`, `1d20 + {Spellcraft}`, `1d20 + {Atk 3 greatsword}`, `{Dmg 3 greatsword}`. A value edited
in PlanarAlly's Custom Data tab (a buff, a penalty) therefore changes every roll that uses it. The
field names come from the same builder that exports them (`buildSheet` returns the elements and the
exact names - they are de-duplicated and sanitised, so a button must use what the field really got).

Two modes, chosen above the tabs and remembered per browser (default: PA dice panel):

- **PA dice panel** (`openInDicePanel`): the formula goes into PlanarAlly's own dice panel exactly as
  clicking a Custom Data dice-expression does (`loadSystems` -> activate the Dice tool -> 100 ms ->
  `dice.setInput`) and you press Enter. That is PA's **native** roll: 3D dice, "share with", and the
  toast other players see (verified with a second account). `{fields}` are left for PA to expand, but
  are written in its explicit `{[shapeId]name}` form so they resolve for this token even if another is
  selected by then. While the sheet is open it holds a Custom Data lease for the token
  (`loadState`/`dropState` with its own key) so PA's resolver still has the fields if the token gets
  deselected before you press Enter.
- **Quick roll** (`rollFormula`): rolled right here with PA's 2d engine (`parse -> roll + evaluate each
  dice part -> collect`) and shown **only to you**: nothing is sent to other players. The **Result
  popup** checkbox (on by default) also opens PA's own result card and records the roll in its dice
  history (`dice.addToHistory(roll, playerName, label)` + `dice.showResults(roll)`, verified).

**Why the sheet resolves fields itself in quick mode.** The engine's `parse()` knows nothing about
`{...}`; PA expands variables only in its dice panel, with code that isn't exposed to mods.
`resolveFormula` is a port of PA's own `hb`/`gb`, checked against the original on every formula the
sheet can produce for both real test characters (314 formulas, no disagreements) plus path prefixes,
case, `reference` aliases, punctuation in names, the `[shapeId]` form, nested dice-expressions and
text values. **PA silently drops a variable it can't find** (`1d20 + {Nope}` becomes `1d20 + `, the
modifier just vanishes), so both modes look every field up first and refuse to roll when one is
missing, naming it. Because fields come from the last import/export, a missing one (say the
character was imported before an update added fields) triggers one automatic re-export and a retry.

Chat is not used: an earlier version posted quick rolls to the shared chat, but PlanarAlly's chat
doesn't persist across reloads and the table doesn't use it, so all of that was removed.

Limits: rolls use the 2d engine; crit confirmation/multipliers and per-weapon crit ranges are not
handled (`Dmg` rolls the base damage formula only); a quick roll cannot fire PA's native toast for
other players - only a roll made in its own dice panel does.

## Auras from the Hero Lab specials

Auras are inferred from the XML instead of being set up by hand. Hero Lab's Specials tab is spread
over several containers; two are read (always with `own`, so a mount's or companion's senses are
never the rider's):

- `<senses>`: **Darkvision (60 feet)** / "Darkvision 60 ft." (and **Blindsight**, which behaves the
  same on a map) becomes a **vision aura**: a vision source of that radius, not drawn, exactly PA's
  own default "New aura" with your radius. Senses with no range (Low-Light Vision, Scent, Deaf) are
  skipped. Two sources of the same sense (race + item) keep the longer range.
- `<auras>`: entries with a radius, e.g. **Aura of Courage +4 (10 ft.)**, become a **visible radius
  aura** (translucent blue) so the table can see who is inside. Entries with no radius are skipped.

On import the sheet creates them on the token (`auras.add`), and the Core tab lists them with a
**Create / update auras on the token** button. It tracks what it created by key -> PA uuid (stored
with the character), never by name:

- re-importing the same character makes no changes;
- a changed radius only updates `value` (your renames/colours are left alone);
- an aura Hero Lab no longer has is removed - but only one the sheet created;
- auras you made by hand are never touched, even with the same name;
- a missing aura (first import, or you deleted it) is recreated. To hide one without it returning
  on the next import, switch it off in PlanarAlly instead of deleting it.

The identity key ignores a "+4"-style bonus, so an aura that grows with level is updated in place.
Radii are taken as feet, which is PlanarAlly's default location unit; a table using another unit
would need the number converted. Auras emit no events in PlanarAlly, so nothing flows back from the
token to the sheet. Low-light vision has no PlanarAlly equivalent and is not modelled.

## Custom Data export (rolls PlanarAlly's own dice panel can use)

Every import (and the Core tab's **Export to Custom Data** button) writes the sheet into the token's
Custom Data under the source `pf1e-sheet`. Only that source is ever read, updated or removed:
elements made by hand in PlanarAlly (source `planarally`) and its UI placeholder rows are never
touched, and **Remove sheet data from Custom Data** deletes only what the sheet wrote.

What is written (about 90 elements per character; all names are plain letters/digits/spaces so they
work as `{variables}`):

- `/abilities`: `STR`, `STR mod`, ... for all six.
- `/combat`: `Init`, `Fort`, `Ref`, `Will`, `BAB`, `CMB`, `CMD`, `AC`, `Touch AC`, `Flatfooted AC`,
  `Max HP`, `Speed`, and `CL <class>` / `Concentration <class>` for each spellcasting class.
  (Current HP is deliberately not exported - it changes in play and lives in the tracker.)
- `/skills`: one number per skill, e.g. `Spellcraft`.
- `/attacks`: per weapon, `Atk <weapon>` (a number: the first iterative attack bonus; later attacks are
  offsets from it, so one edit moves them all) and `Dmg <weapon>`
  (a rollable dice-expression: the damage formula; none for flat damage like "6").
- `/rolls`: ready-made `dice-expression` elements: `Roll Initiative`, `Roll Fortitude|Reflex|Will`,
  `Roll CMB`, `Roll STR check` ..., `Roll Concentration <class>`, `Roll <skill>` for every skill, and
  `Roll Attack <weapon>` (= `1d20 + {Atk <weapon>}`). A weapon with iterative attacks (`+13/+8/+3`)
  gets one per attack instead: `Roll Attack <weapon> 1st|2nd|3rd` (= `1d20 + {Atk <weapon>}`,
  `1d20 + {Atk <weapon>} - 5`, `1d20 + {Atk <weapon>} - 10`). They reference the number elements, so
  re-importing updates the numbers and the rolls follow. (Older exports also had `Roll Damage
  <weapon>`; `Dmg <weapon>` replaced it, and the next sync removes the old ones.)

The sheet's own roll buttons use exactly these fields (see Dice rolls), so editing one in PlanarAlly's
Custom Data tab changes every roll that uses it.

Using it in PlanarAlly: select the token, open its Custom Data tab and click a "Roll ..." element - PA
fills its dice panel and you press Enter for a **native** roll (3D dice, share-with, the toast other
players see). Or type your own formulas in the dice panel: `1d20 + {Spellcraft}`, `1d20 + {STR mod} +
{BAB}`; bare variables use whichever token is selected.

Re-syncing is idempotent: unchanged data makes no calls, a changed value is updated in place, an
element the sheet no longer exports is removed, and a changed element *kind* swaps the element
(PA's `updateValue` refuses a value of another type). Verified against PA's own variable resolver
(`hb`/`gb`, ported verbatim from its bundle): every exported roll resolves, expands without
recursion, and evaluates to d20 + the right modifier for both real test exports; every number
resolves uniquely by its bare name.

Limits: variables resolve against Custom Data that PA has loaded, i.e. the selected/focused token.
Names are made unique across all prefixes on purpose (a bare `{name}` takes the first match anywhere,
and a self-referencing dice-expression would recurse forever). Skill names lose punctuation
("Knowledge (arcana)" -> "Knowledge arcana"). The elements are editable in PA, but the next import
overwrites them.

## Specials tab

Hero Lab's Specials tab is imported and shown on its own **Specials** tab, laid out like the feats:
name, the class/race/trait that grants it, a short excerpt, and an (i) icon whose hover shows the full
rules text. Specials sit in ten containers directly under `<character>`; each becomes a group, in this
order: Senses, Auras, Defensive abilities, Immunities, Resistances, Weaknesses, Damage reduction,
Offensive abilities, Spell-like abilities, Other abilities, Items & equipment.

- `otherspecials` is a catch-all that mixes class/race/trait abilities with magic items and scrolls.
  Entries with a Hero Lab `type` or a `sourcetext` are abilities ("Other abilities"); the rest are
  "Items & equipment". That split is a heuristic.
- A mount's or companion's specials are never imported (read with `own`, like everything else).
- The bookkeeping row " Equipment Slots In Use" is skipped, a source granted twice ("Oracle, Oracle")
  is shown once, and an entry repeated in the same group is shown once.
- Specials are plain data on the character (`specials`, optional so older saves still load).
  Full text is stored, so expect roughly 20-30 KB per character in the DataBlock.

## Who sees what

- **The sheet tab** is registered with a filter, so it only appears on characters the viewer can
  edit; the DM can always edit. PlanarAlly's tab filter is documented as receiving `hasEditAccess`.
  If a server doesn't pass it, the code falls back to PlanarAlly's own "can edit the focused shape"
  flag, then to "is the DM" - so a missing argument can hide the sheet from players but never from
  the DM.
- **The Diagnostics tab** is DM-only (`systemsState.game.reactive.isDm`). A DM who has switched to
  "fake player" to preview the player view gets the player view, i.e. no Diagnostics tab. If the
  DM role goes away while it is open, the sheet returns to the Core tab.
- Not gated: the tracker -> sheet HP sync (`main.ts`) listens on every client that has the mod
  loaded. A client without edit rights may therefore attempt the DataBlock write; whether the
  server rejects it has not been verified.

## Diagnostic build (0.9.x) - exploring what the live API really exposes

Purpose: find out what a PlanarAlly **dev** server really exposes to mods, aimed at three
integrations - the dice-rolling system, trackers, and auras. The published `@planarally/mod-api`
types have repeatedly disagreed with live servers, so this build inspects the runtime objects
directly instead of trusting them. Everything lives in `src/diagnostics.ts` (no imports, so it
can't be broken by type drift) and is surfaced through a **Diagnostics** tab on the sheet.

What the report covers: every member (own + whole prototype chain) of `api`, `api.systems.*`,
`api.systemsState.*`, `api.ui`; function source for tracker/aura/dice/chat/custom-data systems;
the **real runtime shape object** (the 3-field `IShape` type hides the aura/custom-data methods);
sample aura/tracker records off the shape; a name search across the API for
dice/roll/chat/aura/tracker/custom/...; the JS chunk filenames PA loaded (feature modules show up
by name); matching window globals; a probe of the Vue app's provided globals; and a
`GET /api/version` probe.

The exported `events` object is wrapped in a Proxy that records every property name PA looks up
on it. Unknown names still return `undefined`, so behavior is unchanged, but it reveals which
event names this server supports (aura updates, rolls, ...) beyond the four in the published
types. Do something in-game (edit a tracker, add an aura, roll dice) and re-run the report to
see them.

Two opt-in tracker self-tests create and remove a throwaway tracker (`PF1E-DIAG`) and report each
step plus whether `preTrackerUpdate` fired: **local** keeps everything on this client;
**server-synced** also round-trips the server (if something throws midway the temporary tracker
may be left behind - delete it by hand).

### Round 1 findings (PlanarAlly reporting release 2026.2, built from source)

**The published `@planarally/mod-api` types are stale; the runtime API is much richer.** Several
earlier "dead end" conclusions in this README were drawn from calling names that exist in the
types but not at runtime. What the live server actually exposes (from the round-1 report):

- `api` top level: `systems`, `systemsState`, `ui` (`shape`, `modals`), **`gameplay`**,
  **`eventBus`**, **`hooks`**, `getGlobalId`, `getShape`, and the DataBlock functions.
  `modals` offers `confirm`, `prompt`, `selectionBox`.
- **Trackers** (`api.systems.trackers`): `add(id, tracker, sync)`, `getAll(id)`, `get(id, uuid)`,
  `update(id, uuid, delta, sync)`, `remove(id, uuid, sync)`, `getOrCreateForShape(id)` (returns
  the array, does not create a tracker). There is no `getOrCreate`. `state.trackers` ends with a
  `temporary: true` "New tracker" placeholder row that is not a real tracker.
  `update()` runs `pipe("pre:tracker:update", ...)` and afterwards emits `tracker:updated` on the
  event bus (likewise `tracker:added`, `tracker:removed`).
- **Auras** (`api.systems.auras`): the same shape - `add/update/remove/get/getAll`. Fields seen in
  PA's own source: `uuid`, `value`, `dim`, `active`, `visible`, `visionSource`, `floodLight`
  (full schema still to be captured from a real aura).
- **Custom Data** (`api.systems.customData`): `addBranch`, `addElement`, `removeElement`,
  `removeBranch`, `updateValue`, `updateKind`, `setName`, `setReference`, `setDescription`,
  `getElementId`, `export(shapeId)`. Elements look like `{shapeId, source, prefix, name, kind,
  value, id, reference, description}`; user-made ones have `source: "planarally"`, which strongly
  suggests mods are meant to write their own elements under their own `source`. Emits
  `customData:added|updated|removed` and pipes `pre:customData:update`.
- **Dice** (`api.systems.dice`): `setInput(text)` fills PA's roll box and switches the UI to roll
  mode; `getSystem("2d"|"3d")` returns the dice engines (after `loadSystems()`); `showResults`,
  `addToHistory`. State in `systemsState.dice.raw` (`uiState`, `textInput`, `history`, `result`).
- **Chat** (`api.systems.chat`): `addMessage(id, author, parts[], sync)`; the source suggests
  `sync=true` sends it to the server (shared chat). Content is markdown-rendered.
- **Properties** (`api.systems.properties`): real setters exist - `setName(id, name, sync)`,
  `setShowBadge`, `setIsDefeated`, ... The earlier rename attempt mutated the wrong layer
  (`systemsState.properties.mutable.data`), which is why it did nothing.
- The old `ModEvents.preTrackerUpdate` export is not how this server delivers hooks: PA only
  looked up `init` and `initGame` on our exported `events` object. The replacement is almost
  certainly `api.hooks` (pipes such as `pre:tracker:update`) and `api.eventBus` - round 2 expands
  both.

### Round 2 findings (hooks, events, dice, data)

- **`api.hooks`** has `tap(name, fn)` and `pipe(name, value, ctx)`. PA runs
  `pipe("pre:tracker:update", delta, {id, tracker, syncTo})` and
  `pipe("pre:customData:update", delta, {id, element, syncTo})`; mods register with
  `api.hooks.tap(name, handler)` (handler signature not yet verified). The bundle scanner
  (diagnostics tab) lists every hook/event name in the build.
- **`api.eventBus`** has `on(name, cb)`, `once`, `emit`. Verified firing with
  `{id, trackerId, delta, syncTo}`-style payloads: `tracker:added|updated|removed` and
  `customData:added|updated|removed`. A `"*"` wildcard did not fire. **Auras emit nothing** - their
  `add/update/remove` have no event or hook.
- `api.gameplay.activateTool(name)`; `api.ui.modals.confirm/prompt/selectionBox` (promise-based
  dialogs a mod can use).
- **Dice engine** (`api.systems.dice.getSystem("2d")`): `parse`, `roll(part, {d100Mode})`,
  `evaluate`, `collect` (see Dice rolls). `dice.setInput(text)` pre-fills PA's roll box;
  `addToHistory(roll, player, name)` / `showResults(roll)` are local display. Rolls stored as
  `{parts, result}`.
- **Chat**: `addMessage(id, author, parts[], sync)`; `sync=true` calls the server emitter; content is
  markdown-rendered (`<p>...</p>`). Chat/dice can be disabled per room (`systemsState.room.raw`).
- **Records**: aura = `{uuid, active, visionSource, visible, name, value, dim, colour, borderColour,
  angle, direction, floodLight, temporary}`; tracker = `{uuid, name, value, maxvalue, visible, draw,
  primaryColor, secondaryColor, temporary}`.
- **Custom Data**: `addElement`/`updateValue`/`removeElement` verified live under `source:
  "pf1e-diag"` with `kind: "number"` (events fire). **Do not use `removeBranch` for cleanup** - it
  matches on `prefix` only and ignores `source`, so it would delete a user's own elements. Remove
  elements one by one, filtered by `source`. Valid `kind` values and how dice formulas reference
  custom data are still unknown (the bundle scan looks for both) - writing sheet values into Custom
  Data waits on that, because an invalid kind could break PA's Custom Data tab.
- **Properties**: `setName/setNameVisible/setShowBadge/setIsDefeated/...(id, value, sync)`.

### Round 3 findings (bundle scan)

- **Hooks/events actually in use**: PA pipes only `pre:tracker:update` and `pre:customData:update`;
  nothing inside PA taps them (mods are the intended users). Bus events emitted: `tracker:added|updated|removed`,
  `customData:added|updated|removed`, `i18n:init`. There are **no** dice, chat or aura events on the bus.
- **Socket (wire) names** of interest: `Chat.Add`, `Chat.Message.Update`, `Dice.Roll.Result`,
  `Room.Features.Chat.Set`, `Room.Features.Dice.Set`, `Shape.CustomData.Add|Remove|Update|Update.Name`,
  `Shape.Options.Aura.Create|Move|Remove|Update`, `Shape.Options.Tracker.Create|Move|Remove|Update`.
- **Custom Data kinds** (the `defaultValue` table): `number` (0), `text` (""), `boolean` (false) and
  **`dice-expression`** ("") - rendered by a `DiceFormat` component, with `ToggleFormat` for booleans.
  Clicking a dice-expression element runs `loadSystems` -> activate Dice tool -> `dice.setInput(...)`
  where each token is `{isVariable, ref, discriminator, text}`: a variable with no discriminator is
  replaced by the referenced element's `value`; one with a discriminator is written back as
  `{[discriminator]name}` and resolved later, at roll time. **The exact variable syntax is still to be
  read** (the focused native-dice scan looks for it). This is PA's intended way to make a rollable
  character sheet: write elements under a mod `source`, with dice-expression elements referencing
  number elements.
- A `custom data` element with `pending: 1` (id 1 in a freshly-opened Custom Data tab) is a UI
  placeholder row, not real data - skip `pending` elements when reading `export()`.
- PA's own chat input posts with `chat.addMessage(uuid, currentPlayer.name, parts, true)`.

### Round 4 findings (dice-expression variables, tool names)

- **Variable grammar** (PA's `hb`/`gb`): `{name}`, `{prefix/name}` or `{[shapeId]name}`, matching
  `/{(\[\d+\])?([\w /]+)}/g`. The last path segment is the name; the rest is the prefix (a leading
  "/" is added if missing). A variable matches an element whose `reference` (an alias, when set) or
  else `name` equals it, case-insensitively, after stripping every character outside `[\w /]`, and
  whose prefix matches when one was given. Without a `[shapeId]` the *selected/focused* token is used.
- `gb` expands the expression at roll time: each variable becomes the element's value (a
  dice-expression element is expanded recursively), unresolved variables are silently dropped, and
  segments are joined with spaces (`1d20 + {Init}` -> `1d20 +  -1` still evaluates as d20 - 1).
- The `reference` field is therefore a **variable alias**, not a pointer to a tracker or aura.
- Clicking a dice-expression element (DiceFormat) writes its text to the dice panel with variables
  left as `{[shapeId]name}`; they are resolved when you press Enter.
- Tool names (`api.gameplay.activateTool`): Select, Pan, Draw, Ruler, Ping, Map, Light, Vision, Spell,
  Dice, Note (a string enum).
- PA's native roll: `Lf.roll(parts, use3d, shareWith)` rolls with the same 2d/3d engines, then emits
  `Dice.Roll.Result` (an internal socket wrapper) with `{ player, roll: JSON.stringify(result),
  shareWith }` unless `shareWith === "none"`; receivers add it to history and show the toast.

Console handles: `window.pf1eApi` (the live API) and `window.pf1eDiag` (`report()`, `quick()`,
`state`), plus a `[pf1e-diag]` summary logged at game start. Strip this whole thing out once the
integration paths are understood.

## Read-only sheet (Hero Lab is the source of truth)

Everything is shown as plain text except current HP, which is the one editable field - the intended
workflow is: edit the character in Hero Lab, re-export/re-import to update the sheet, and only adjust
current HP in PlanarAlly during play. A short note under the name explains this in the UI.

Read-only values are plain text, not disabled inputs. That matters for layout: a form control has an
intrinsic width of roughly 170px, which is what made the attack and skill tables stretch, whereas text
wraps. (An earlier version disabled every input with one mechanical pass and accidentally disabled the
hidden file input behind "Import from Hero Lab", silently breaking import; converting inputs to text
again was checked the same way - the only inputs left are that file picker, the two roll-mode radios,
the result-popup checkbox and current HP.)

## Sheet width

PlanarAlly sizes the Edit Shape dialog to its content. With `width: 100%` on the sheet, any long line of
text (a feat excerpt, a status message) therefore stretched the dialog out to the screen edge - measured
in a content-sized test dialog, 1600px of a 1600px viewport and 900px of 900px, even with text-only
tables. The sheet now has an explicit width, set from the **S / M / L** buttons at the right of the tab
row (30rem / 40rem / 54rem, default M, remembered per browser in `localStorage`), capped to
`100vw - 12rem` so it still shrinks on a small screen. Tables scroll inside their own container if a
column set is wider than that.

## Spells grouped by level within each class

Within each spellcasting class's section, spells are now grouped under "Level 0", "Level 1",
etc. headers (ascending, alphabetical within a level), via a `spellsByLevel()` helper in
`CharSheet.vue`. This is a pure display grouping - the underlying `sc.spells` array in the
DataBlock is unchanged, so no re-import is needed to get this.

## Feat/spell full text on hover

Each feat and spell now carries both a short `description` (shown inline, same as before) and
a `fullText` field with the untruncated rules text (capped at 4000 characters as a safety
limit against pathological entries, not a normal-case limit). An ⓘ icon next to each name shows
`fullText` via the browser's native `title` tooltip on hover.

This uses a plain HTML tooltip rather than a custom popup on purpose: this server has already
shown that global page styles can leak into unexpected places in this dialog (see the earlier
feats-rendering-as-columns bug), and the browser's built-in tooltip isn't affected by that.
The trade-off is no control over styling/positioning/delay - if you want a richer popup instead
(scrollable, styled, click-to-pin), that's buildable but carries more risk of the same class of
CSS surprise, so flagging the trade-off rather than assuming which you'd prefer.

Re-importing is required to backfill `fullText` on a character imported before this version;
existing `description` excerpts don't get retroactively expanded on their own.

## Hero Lab import — status

The importer is built against one real HL 8.9h Pathfinder export (character
"Ulric Spiralborn", a multiclass Oracle/Paladin with heavy homebrew/community
content packs enabled), covering:

- identity, classes, ability scores
- HP, AC (normal/touch/flat-footed), saves, BAB, CMB/CMD, initiative, speed
- melee + ranged attacks
- skills (ranks, class-skill flag, trained-only, total)
- feats (name + short excerpt, not full rules text — see comment in parser.ts)
- spellcasting per class (caster level, concentration, slots/day, known spells)
- inventory (magic items + gear, with quantity/weight/cost note)

### Fixed: minion/companion/mount contamination (real bug, confirmed and fixed)

A character with a nested minion (animal companion, eidolon, mount - confirmed via a real
export with a purchased riding horse) stores it as a full nested `<character>` block at
`<character><minions><character>...`. The parser originally queried with plain
`character.querySelectorAll(...)`, which searches the *entire* subtree, not just the
character's own immediate data - so it also found the minion's nested `<attributes>`,
`<classes>`, `<skills>`, `<feats>`, `<melee>`/`<ranged>`, `<magicitems>`/`<gear>`, etc. Since
the minion's data comes later in the document, ability scores were silently overwritten by the
minion's (e.g. a 17th-level sorcerer's real CHA 35 came out as the mount's CHA 4), and
list-based data (skills, feats, spells, attacks, inventory) would have had the minion's entries
mixed in with the real character's.

Fixed by scoping every query to the character's own direct children only (the `own`/`ownAll`
helpers in `parser.ts`, built on the CSS `:scope` combinator), which never descends into a
nested `<minions>` subtree. Verified against two real exports: a character with no minion
(unaffected either way) and one with a mount (previously found 18 `<attribute>` elements
instead of the correct 6 - suggesting more than one nested character block merges in, not just
one). If you ever see a feat, skill, spell, or inventory item on the sheet that looks like it
belongs to an animal rather than the PC, that's the signature of this class of bug recurring -
check whether a new nested structure needs the same `own`/`ownAll` treatment.

### Known gaps / things to verify against more exports

- **Prepared casters (`spellsmemorized`)**: the sample character's Paladin
  slots were empty at export time, so the *populated* shape of
  `<spellsmemorized>` is unverified. The parser defensively looks for `<spell>`
  descendants anywhere under it, but if your prepared casters come back empty,
  send me an export from a character with active prepared spells and I'll fix
  the selector.
- **Archetypes**: HL folds the archetype into the class name string itself
  (e.g. `"Oracle (Dual-Cursed Oracle)"`) rather than exposing it as a separate
  field, so `ClassLevel.archetypes` is currently always empty. Splitting the
  name is possible but heuristic (not every class uses the same
  `Base (Archetype)` convention) — let me know if you want that.
- **Racial traits / class features / conditions** aren't imported yet (no
  schema for them). If you want those on the sheet, I can add a `features:
  FeatEntry[]`-shaped list sourced from `<specialabilities>`/class feature
  sections — need to confirm those tag names against the export too.
- **Multiple characters per file**: the parser takes the first
  `<character>` element. Hero Lab XML exports are one character per file in
  the normal export flow, so this should be fine, but flagging the assumption.
