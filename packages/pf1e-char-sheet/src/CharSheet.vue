<script setup lang="ts">
import type { LocalId } from "@planarally/mod-api";
import { ref, watch, computed, onBeforeUnmount } from "vue";

import { isCharacterShape, isDm as viewerIsDm } from "./access";
import {
    applyAdjustments,
    BONUS_TYPES,
    BUILTIN_ADJUSTMENTS,
    describeEffects,
    enabledAdjustments,
    TARGET_LABELS,
} from "./adjustments";
import { syncAuras } from "./auras";
import {
    attackFormula,
    buildElements,
    buildSheet,
    checkFormula,
    field,
    holdCustomDataLease,
    iterativeBonuses,
    ordinal,
    removeCustomData,
    ROLL_MACROS,
    syncCustomData,
    type RollMacro,
} from "./customdata";
import {
    abilityModifier,
    emptyCharacter,
    DATA_BLOCK_NAME,
    groupSpecials,
    type AbilityKey,
    type AdjustmentEffect,
    type AdjustmentState,
    type AdjustmentTarget,
    type FeatEntry,
    type PF1Character,
    SHEET_SECTIONS,
    type SheetConfig,
    type SheetResource,
    type SpecialEntry,
    type SpellcastingClass,
    type SpellEntry,
} from "./data";
import { buildApiDump, buildHealthCheck } from "./diagnostics";
import { duplicateToken } from "./duplicate";
import { parseHeroLabXml, HeroLabImportError } from "./herolab/parser";
import { api, modVersion } from "./main";
import {
    carryUsesLeft,
    pushUsesLeft,
    refillsDaily,
    resourceKeyForName,
    resourceLabel,
    syncTrackedResources,
    trackedKeys,
    usesLeft,
} from "./resources";
import { MissingFieldsError, RollError, openInDicePanel, rollFormula } from "./roll";
import { moveRulesToCompendium, openRule, ruleRegistered, rulesReady, ruleText, type RuleKind } from "./rules";
import { spellFormula, spellGuess, spellKey } from "./spells";
import { findHpTracker, pushHp, type HpPushResult } from "./trackers";
import { logDismissed, newerVersion, RELEASES_URL } from "./updates";

const { data, load, save, write } = api.useShapeDataBlock<PF1Character>(DATA_BLOCK_NAME, {
    defaultData: () => emptyCharacter(),
});

// What the sheet shows: the stored character with its enabled adjustments applied (adjustments.ts).
// Everything displayed reads `view`; edits (current HP, macro and adjustment choices) go to `data`.
const view = computed(() => applyAdjustments(data.value));

// The shape currently shown in the sheet, tracked separately from the DataBlock above
// because the tracker API is keyed by LocalId, not by the GlobalId the DataBlock uses.
const currentLocalId = ref<LocalId>();

// --- HP tracker sync ----------------------------------------------------------------
//
// Trackers have add / getAll / update / remove, and PA announces every change on api.eventBus. This file handles sheet -> tracker; main.ts handles tracker -> sheet by
// listening for "tracker:updated" (current HP only - max HP is owned by the Hero Lab import).
//
// A push happens when you COMMIT the HP field (blur / Enter), not on every keystroke: pushing each
// digit would round-trip through the event bus per keystroke, and an echo could overwrite what
// you are still typing.

// Keep this token's Custom Data loaded for PlanarAlly's own resolver while the sheet is open, so a
// formula sent to its dice panel still resolves if the token gets deselected before you press Enter.
// (Declared before the immediate watcher below, which calls refreshLease() during setup.)
let releaseLease: (() => void) | undefined;

function refreshLease(): void {
    releaseLease?.();
    releaseLease = undefined;
    const id = currentLocalId.value;
    if (id === undefined) return;
    try {
        releaseLease = holdCustomDataLease(api, id);
    } catch (e) {
        console.error("[pf1e-sheet] couldn't hold the Custom Data lease", e);
    }
}

onBeforeUnmount(() => releaseLease?.());

// The sheet shows the focused shape: the token whose edit dialog this tab is in. (Not the active
// character: a monster/NPC token isn't a character, and the active character needn't be the token
// being edited.)
watch(
    () => api.systemsState.selected.reactive.focus,
    (shape) => {
        if (shape === undefined) return;
        load(shape);
        currentLocalId.value = shape;
        refreshLease();
    },
    { immediate: true },
);

// A character gets the full sheet; any other token (monsters, NPCs - the tab only shows for the DM)
// gets the limited one (no Feats or Inventory tab).
const isCharacter = computed(() => currentLocalId.value !== undefined && isCharacterShape(api, currentLocalId.value));

const pushStatus = ref("");
let pushStatusTimeout: ReturnType<typeof setTimeout> | undefined;

function flashPushStatus(text: string): void {
    pushStatus.value = text;
    clearTimeout(pushStatusTimeout);
    pushStatusTimeout = setTimeout(() => (pushStatus.value = ""), 5000);
}

function describePush(result: HpPushResult): string {
    switch (result) {
        case "updated":
            return "HP tracker updated.";
        case "created":
            return 'HP tracker created on the token (named "HP").';
        case "no-tracker":
            return 'No tracker named "HP" on this token yet.';
        case "unsupported":
            return "This server doesn't support tracker updates from mods.";
    }
}

/** Fired when the HP field is committed: save, then update the token's HP tracker if it has one. */
function onHpCommitted(): void {
    // v-model.number leaves an emptied or non-numeric field as a string: put back the token's tracker
    // value (or max HP) rather than saving and pushing a non-number.
    const hp = data.value.combat.hp;
    if (typeof hp.current !== "number" || !Number.isFinite(hp.current)) {
        const tracker = currentLocalId.value === undefined ? undefined : findHpTracker(api, currentLocalId.value);
        hp.current = tracker?.value ?? hp.max;
        return;
    }
    save();
    if (currentLocalId.value === undefined) return;
    try {
        pushHp(api, currentLocalId.value, data.value.combat.hp.current, data.value.combat.hp.max, false);
    } catch (e) {
        console.error("[pf1e-sheet] pushing HP to the tracker failed", e);
    }
}

/** The "Push HP to tracker" button: same push, but creates the tracker if the token has none. */
function manualPushHp(): void {
    if (currentLocalId.value === undefined) {
        flashPushStatus("No token selected.");
        return;
    }
    try {
        const result = pushHp(api, currentLocalId.value, data.value.combat.hp.current, data.value.combat.hp.max, true);
        flashPushStatus(describePush(result));
    } catch (e) {
        console.error("[pf1e-sheet] pushing HP to the tracker failed", e);
        flashPushStatus("Pushing to the tracker failed - see the console.");
    }
}

// --- sub-tabs -------------------------------------------------------------

// --- Sheet width ---------------------------------------------------------------------------
// PlanarAlly sizes the Edit Shape dialog to its content, so without an explicit width any long line
// of text pushes the whole dialog out to the screen edge. The sheet therefore has a fixed width
// (still capped to the viewport) and wraps/scrolls inside it. S / M / L is remembered per browser.
const WIDTHS = { S: "30rem", M: "40rem", L: "54rem" } as const;
type WidthKey = keyof typeof WIDTHS;
const WIDTH_KEYS = Object.keys(WIDTHS) as WidthKey[];

function loadWidth(): WidthKey {
    try {
        const saved = localStorage.getItem("pf1e-sheet-width");
        if (saved === "S" || saved === "M" || saved === "L") return saved;
    } catch {
        /* storage can be unavailable; fall through to the default */
    }
    return "M";
}

const sheetWidth = ref<WidthKey>(loadWidth());
const widthStyle = computed(() => ({ "--pf1e-width": WIDTHS[sheetWidth.value] }));

function setWidth(w: WidthKey): void {
    sheetWidth.value = w;
    try {
        localStorage.setItem("pf1e-sheet-width", w);
    } catch {
        /* not persisted; still applies for this session */
    }
}

// "Sheet" is the paper-style front page (abilities, combat, saves, weapons, skills); "Token" has what
// acts on the token itself (auras, Custom Data, the HP push).
const BASE_TABS = [
    "Sheet",
    "Spells",
    "Resources",
    "Adjustments",
    "Feats",
    "Specials",
    "Inventory",
    "Token",
    "Config",
] as const;
const LIMITED_TABS = ["Sheet", "Spells", "Resources", "Adjustments", "Specials", "Token", "Config"] as const;
/** Tabs the Config tab can hide (the Sheet, Config and Diagnostics tabs always show). */
const HIDEABLE_TABS: readonly string[] = [
    "Spells",
    "Resources",
    "Adjustments",
    "Feats",
    "Specials",
    "Inventory",
    "Token",
];
type TabName = (typeof BASE_TABS)[number] | "Diagnostics";
const activeTab = ref<TabName>("Sheet");

// The Diagnostics tab (read-only reports on the sheet and PlanarAlly's mod API) is for the DM only.
// A DM who has switched to "fake player" (to preview what players see) gets the player view, i.e.
// no Diagnostics tab either.
const isDm = computed(() => viewerIsDm(api));
// The Spells and Resources tabs only appear when there are spells / limited-use resources.
const hasSpells = computed(() => data.value.spellcasting.some((sc) => sc.spells.length > 0));
const hasResources = computed(() => (data.value.resources ?? []).length > 0);
const visibleTabs = computed<readonly TabName[]>(() => {
    const all: readonly TabName[] = isCharacter.value ? BASE_TABS : LIMITED_TABS;
    const hiddenTabs = new Set(data.value.sheetConfig?.hiddenTabs ?? []);
    const tabs = all.filter(
        (t) => (t !== "Spells" || hasSpells.value) && (t !== "Resources" || hasResources.value) && !hiddenTabs.has(t),
    );
    return isDm.value ? [...tabs, "Diagnostics"] : tabs;
});

// --- Duplicate (monster/NPC sheet, so DM only) ---------------------------------------------------
const duplicating = ref(false);
const duplicateStatus = ref("");

async function duplicate(): Promise<void> {
    const id = currentLocalId.value;
    if (id === undefined || duplicating.value) return;
    duplicating.value = true;
    duplicateStatus.value = "Duplicating...";
    try {
        duplicateStatus.value = (await duplicateToken(api, id, data.value)).message;
    } catch (e) {
        console.error("[pf1e-sheet] duplicate failed", e);
        duplicateStatus.value = "Duplicating failed - see the console.";
    } finally {
        duplicating.value = false;
        setTimeout(() => (duplicateStatus.value = ""), 8000);
    }
}

// --- Update check (DM only): a newer version of the mod on GitHub ------------------------------
// Players can't install mods, so only the DM is told (and only the DM's browser asks GitHub).
// Dismissing hides the message until the next new version.
const UPDATE_DISMISSED_KEY = "pf1e-sheet-update-dismissed";
const availableUpdate = ref<string>();

watch(
    isDm,
    async (dm) => {
        availableUpdate.value = undefined;
        if (!dm) return;
        const version = await newerVersion(modVersion);
        let dismissed: string | null = null;
        try {
            dismissed = localStorage.getItem(UPDATE_DISMISSED_KEY);
        } catch {
            /* storage unavailable: show it */
        }
        if (!version || !viewerIsDm(api)) return;
        if (version === dismissed) logDismissed(version, UPDATE_DISMISSED_KEY);
        else availableUpdate.value = version;
    },
    { immediate: true },
);

function dismissUpdate(): void {
    try {
        if (availableUpdate.value) localStorage.setItem(UPDATE_DISMISSED_KEY, availableUpdate.value);
    } catch {
        /* not remembered; hidden for now anyway */
    }
    availableUpdate.value = undefined;
}

// Keep the open tab valid when the sheet switches between a character and a monster/NPC, or the DM
// role goes away while Diagnostics is open (e.g. switching to fake player).
watch(
    visibleTabs,
    (tabs) => {
        if (!tabs.includes(activeTab.value)) activeTab.value = tabs[0] ?? "Sheet";
    },
    { immediate: true },
);

// --- Diagnostics (see diagnostics.ts) ------------------------------------------------------
// Each report replaces the previous one; Copy puts it on the clipboard for a bug report.
const diagOutput = ref("");
const diagBusy = ref(false);
const diagTextarea = ref<HTMLTextAreaElement>();
const diagCopyStatus = ref("");

async function runDiag(fn: () => Promise<string>): Promise<void> {
    if (diagBusy.value) return;
    diagBusy.value = true;
    diagOutput.value = "";
    try {
        diagOutput.value = await fn();
    } catch (e) {
        diagOutput.value = `Report failed: ${String(e)}`;
    } finally {
        diagBusy.value = false;
    }
}

async function copyDiag(): Promise<void> {
    const text = diagOutput.value;
    try {
        // The async clipboard API only exists on secure contexts (https / localhost); a dev
        // server reached by plain http://ip:port won't have it, so fall back to selecting the
        // textarea and using the legacy copy command.
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            diagTextarea.value?.focus();
            diagTextarea.value?.select();
            document.execCommand("copy");
        }
        diagCopyStatus.value = "Copied.";
    } catch {
        diagCopyStatus.value = "Copy failed - click in the box, Ctrl+A, Ctrl+C.";
    }
    setTimeout(() => (diagCopyStatus.value = ""), 4000);
}

// --- Hero Lab import --------------------------------------------------------

const importError = ref("");
const fileInput = ref<HTMLInputElement>();

function triggerImport(): void {
    importError.value = "";
    fileInput.value?.click();
}

const importNotes = ref("");

async function onFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    importNotes.value = "";
    try {
        const text = await file.text();
        const character = parseHeroLabXml(text);
        // The skills picked as dice macros are a table choice, not Hero Lab data: keep them across
        // re-imports (dropping any skill the new export no longer has).
        const skillNames = new Set(character.skills.map((s) => s.name));
        character.macroSkills = (data.value.macroSkills ?? []).filter((n) => skillNames.has(n));
        // Likewise the adjustments: what's switched on is the table's state, not Hero Lab's.
        character.adjustments = JSON.parse(
            JSON.stringify(data.value.adjustments ?? { enabled: [], custom: [] }),
        ) as AdjustmentState;
        // And the spells picked as dice macros (with any edited formulas), for spells still there.
        const spellKeys = new Set(character.spellcasting.flatMap((sc) => sc.spells.map((s) => spellKey(sc, s))));
        const prevSpellMacros = data.value.spellMacros ?? { enabled: [], formulas: {} };
        character.spellMacros = {
            enabled: prevSpellMacros.enabled.filter((k) => spellKeys.has(k)),
            formulas: Object.fromEntries(Object.entries(prevSpellMacros.formulas).filter(([k]) => spellKeys.has(k))),
        };
        // Current HP is play state too: re-importing the same character (a level-up, a new item) keeps
        // the HP the token is at, capped at the new maximum - or full, if it was full. A different
        // character takes Hero Lab's HP.
        const prev = data.value;
        if (
            prev.importedAt &&
            prev.identity.name === character.identity.name &&
            Number.isFinite(prev.combat.hp.current)
        ) {
            const wasFull = prev.combat.hp.current >= prev.combat.hp.max;
            character.combat.hp.current = wasFull
                ? character.combat.hp.max
                : Math.min(prev.combat.hp.current, character.combat.hp.max);
        }
        // Uses left are play state as well, for the same character.
        if (prev.importedAt && prev.identity.name === character.identity.name) {
            character.resources = carryUsesLeft(character.resources ?? [], prev.resources ?? []);
        }
        // And the roll macros switched off on the Sheet tab.
        character.macroExcludedRolls = [...(data.value.macroExcludedRolls ?? [])];
        // And what the Config tab hides.
        if (data.value.sheetConfig) {
            character.sheetConfig = JSON.parse(JSON.stringify(data.value.sheetConfig)) as SheetConfig;
        }
        // And the trackers switched off on the Specials tab.
        const resourceKeys = new Set((character.resources ?? []).map((r) => r.key));
        character.trackedResources = trackedKeys(data.value).filter((k) => resourceKeys.has(k));
        delete character.untrackedResources;
        const attackNames = new Set(character.combat.attacks.map((a) => a.name));
        character.macroExcludedAttacks = (data.value.macroExcludedAttacks ?? []).filter((n) => attackNames.has(n));
        const id = currentLocalId.value;
        const notes: string[] = [];

        // Auras are synced first so the saved character carries the uuids of the auras it made,
        // which is how the next import finds (and updates) them instead of duplicating them.
        // Best-effort like everything token-related: the character itself is imported regardless.
        if (id !== undefined) {
            try {
                const result = syncAuras(api, id, character.auras ?? [], data.value.auras ?? []);
                character.auras = result.auras;
                if (result.summary) notes.push(result.summary);
            } catch (e) {
                console.error("[pf1e-sheet] aura sync after import failed", e);
                notes.push("Aura sync failed - see the console.");
            }
            // Same for the x/day, x/round and spell-slot trackers.
            try {
                const result = syncTrackedResources(
                    api,
                    id,
                    character.resources ?? [],
                    data.value.resources ?? [],
                    character.trackedResources ?? [],
                    isCharacter.value,
                );
                character.resources = result.resources;
                if (result.summary) notes.push(result.summary);
                const count = character.resources.length;
                if (count && !(character.trackedResources ?? []).length) {
                    notes.push(
                        `${count} limited-use resource${count === 1 ? "" : "s"} on the Resources tab - tick Track to put one on the token.`,
                    );
                }
            } catch (e) {
                console.error("[pf1e-sheet] tracker sync after import failed", e);
                notes.push("Tracker sync failed - see the console.");
            }
        }

        // The full rules text of feats, spells and skills goes to the campaign's compendium (once,
        // shared by every token) when the server has one; the sheet keeps the excerpts.
        try {
            const added = moveRulesToCompendium(api, character);
            if (added) notes.push(`Compendium: added ${added} rule${added === 1 ? "" : "s"} to "PF1e (Hero Lab)".`);
        } catch (e) {
            console.error("[pf1e-sheet] storing rules text in the compendium failed", e);
        }

        write(character);
        save();

        if (id === undefined) {
            notes.push("No token selected - skipped renaming it, the trackers and the auras.");
        } else {
            notes.push(renameShape(id, character.identity.name));
            try {
                notes.push(describePush(pushHp(api, id, character.combat.hp.current, character.combat.hp.max, true)));
            } catch (e) {
                console.error("[pf1e-sheet] HP tracker push after import failed", e);
                notes.push("HP tracker push failed - see the console.");
            }
            try {
                const cd = syncCustomData(api, id, buildElements(character));
                if (cd.summary) notes.push(cd.summary);
            } catch (e) {
                console.error("[pf1e-sheet] Custom Data export after import failed", e);
                notes.push("Custom Data export failed - see the console.");
            }
        }
        importNotes.value = notes.filter(Boolean).join(" ");
    } catch (e) {
        importError.value = e instanceof HeroLabImportError ? e.message : "Import failed.";
        console.error(e);
    } finally {
        (event.target as HTMLInputElement).value = "";
    }
}

const cdStatus = ref("");
let cdStatusTimeout: ReturnType<typeof setTimeout> | undefined;

function flashCd(text: string): void {
    cdStatus.value = text;
    clearTimeout(cdStatusTimeout);
    cdStatusTimeout = setTimeout(() => (cdStatus.value = ""), 6000);
}

/** Writes the sheet's numbers and ready-made rolls into the token's Custom Data (our source only). */
function exportCustomData(): void {
    const id = currentLocalId.value;
    if (id === undefined) return flashCd("No token selected.");
    try {
        const result = syncCustomData(api, id, buildElements(data.value));
        flashCd(result.summary || "Custom Data is already up to date.");
    } catch (e) {
        console.error("[pf1e-sheet] Custom Data export failed", e);
        flashCd("Custom Data export failed - see the console.");
    }
}

const macroStatus = ref("");
let macroStatusTimeout: ReturnType<typeof setTimeout> | undefined;

function isMacroSkill(name: string): boolean {
    return (data.value.macroSkills ?? []).includes(name);
}

/** The Sheet tab's skill Macro checkbox (skills are out of the macros unless ticked). */
function toggleMacroSkill(name: string, on: boolean): void {
    const current = (data.value.macroSkills ?? []).filter((n) => n !== name);
    data.value.macroSkills = on ? [...current, name] : current;
    applyMacroChange(name, on);
}

function isMacroAttack(name: string): boolean {
    return !(data.value.macroExcludedAttacks ?? []).includes(name);
}

/** The Sheet tab's weapon Macro checkbox (attacks are in the macros unless unticked). */
function toggleMacroAttack(name: string, on: boolean): void {
    const current = (data.value.macroExcludedAttacks ?? []).filter((n) => n !== name);
    data.value.macroExcludedAttacks = on ? current : [...current, name];
    applyMacroChange(name, on);
}

function isRollMacro(roll: RollMacro): boolean {
    return !(data.value.macroExcludedRolls ?? []).includes(roll);
}

/** The Sheet tab's initiative / save Macro checkboxes (in the macros unless unticked). */
function toggleRollMacro(roll: RollMacro, on: boolean): void {
    const current = (data.value.macroExcludedRolls ?? []).filter((r) => r !== roll);
    data.value.macroExcludedRolls = on ? current : [...current, roll];
    applyMacroChange(`Roll ${roll}`, on);
}

/** Saves a macro choice and re-exports Custom Data so the macro appears or goes right away. */
function applyMacroChange(name: string, on: boolean): void {
    save();
    const id = currentLocalId.value;
    let text = "";
    if (id !== undefined) {
        try {
            text = syncCustomData(api, id, buildElements(data.value)).summary;
        } catch (e) {
            console.error("[pf1e-sheet] Custom Data export after macro change failed", e);
            text = "Custom Data export failed - see the console.";
        }
    }
    macroStatus.value = text || `${name}: ${on ? "added to" : "removed from"} the dice macros.`;
    clearTimeout(macroStatusTimeout);
    macroStatusTimeout = setTimeout(() => (macroStatus.value = ""), 6000);
}

// --- Adjustments (buffs, conditions) ---------------------------------------------------------------

const ADJUSTMENT_GROUPS = ["Spells", "Class abilities", "Combat", "Conditions"] as const;
const adjustmentGroups = ADJUSTMENT_GROUPS.map((group) => ({
    group,
    items: BUILTIN_ADJUSTMENTS.filter((a) => a.group === group),
}));
const activeAdjustmentNames = computed(() => enabledAdjustments(data.value).map((a) => a.name));

function adjustmentState(): AdjustmentState {
    data.value.adjustments ??= { enabled: [], custom: [] };
    return data.value.adjustments;
}

function isAdjustmentOn(key: string): boolean {
    return (data.value.adjustments?.enabled ?? []).includes(key);
}

/** Saves a change and re-exports Custom Data, so the numbers, rolls and dice macros follow. */
function saveAndReexport(message: string): void {
    save();
    const id = currentLocalId.value;
    let text = "";
    if (id !== undefined) {
        try {
            text = syncCustomData(api, id, buildElements(data.value)).summary;
        } catch (e) {
            console.error("[pf1e-sheet] Custom Data export after an adjustment change failed", e);
            text = "Custom Data export failed - see the console.";
        }
    }
    macroStatus.value = text ? `${message} ${text}` : message;
    clearTimeout(macroStatusTimeout);
    macroStatusTimeout = setTimeout(() => (macroStatus.value = ""), 6000);
}

// --- Config tab: what the sheet shows ---------------------------------------------------------------

type ConfigList = "hiddenWeapons" | "hiddenSkills" | "hiddenSections" | "hiddenTabs";

function isHidden(list: ConfigList, name: string): boolean {
    return (data.value.sheetConfig?.[list] as string[] | undefined)?.includes(name) ?? false;
}

/** Shows or hides one thing. Weapons and skills also leave the dice macros, so those re-export. */
function setShown(list: ConfigList, name: string, shown: boolean, label = name): void {
    const config = (data.value.sheetConfig ??= {});
    const rest = ((config[list] as string[] | undefined) ?? []).filter((n) => n !== name);
    (config[list] as string[]) = shown ? rest : [...rest, name];
    const message = `${label}: ${shown ? "shown" : "hidden"}.`;
    if (list === "hiddenWeapons" || list === "hiddenSkills") saveAndReexport(message);
    else {
        save();
        macroStatus.value = message;
        clearTimeout(macroStatusTimeout);
        macroStatusTimeout = setTimeout(() => (macroStatus.value = ""), 6000);
    }
}

/** Hides every skill without ranks (or shows every skill again). */
function hideSkillsWithoutRanks(hide: boolean): void {
    const config = (data.value.sheetConfig ??= {});
    config.hiddenSkills = hide ? data.value.skills.filter((s) => s.ranks <= 0).map((s) => s.name) : [];
    saveAndReexport(hide ? "Skills without ranks hidden." : "All skills shown.");
}

const configTabs = computed(() =>
    (isCharacter.value ? BASE_TABS : LIMITED_TABS).filter((t) => HIDEABLE_TABS.includes(t)),
);

function toggleAdjustment(key: string, name: string, on: boolean): void {
    const state = adjustmentState();
    state.enabled = state.enabled.filter((k) => k !== key);
    if (on) state.enabled.push(key);
    saveAndReexport(`${name} ${on ? "on" : "off"}.`);
}

// --- Spell macros --------------------------------------------------------------------------------

function spellMacroState(): { enabled: string[]; formulas: Record<string, string> } {
    data.value.spellMacros ??= { enabled: [], formulas: {} };
    return data.value.spellMacros;
}

function isSpellMacro(sc: SpellcastingClass, spell: SpellEntry): boolean {
    return (data.value.spellMacros?.enabled ?? []).includes(spellKey(sc, spell));
}

function toggleSpellMacro(sc: SpellcastingClass, spell: SpellEntry, on: boolean): void {
    const state = spellMacroState();
    const key = spellKey(sc, spell);
    state.enabled = state.enabled.filter((k) => k !== key);
    if (on) state.enabled.push(key);
    const note = on && !spellFormula(data.value, sc, spell).trim() ? " Enter a formula for it to appear." : "";
    saveAndReexport(`Cast ${spell.name} ${on ? "added to" : "removed from"} the dice macros.${note}`);
}

/** Saves an edited formula; an empty field goes back to the formula guessed from the spell's text. */
function setSpellFormula(sc: SpellcastingClass, spell: SpellEntry, value: string): void {
    const state = spellMacroState();
    const key = spellKey(sc, spell);
    const trimmed = value.trim();
    const guess = spellGuess(sc, spell);
    if (trimmed === "" || trimmed === guess) delete state.formulas[key];
    else state.formulas[key] = trimmed;
    saveAndReexport(`${spell.name}: formula ${trimmed || guess || "cleared"}.`);
}

function rollSpell(sc: SpellcastingClass, spell: SpellEntry): void {
    const formula = spellFormula(data.value, sc, spell).trim();
    if (!formula) {
        rollStatus.value = `${spell.name} has no formula to roll - enter one in its field.`;
        return;
    }
    void doRoll(`Cast ${spell.name}`, formula);
}

const newAdjName = ref("");
const newAdjEffects = ref<AdjustmentEffect[]>([{ target: "attack", type: "untyped", value: 1 }]);
const ADJUSTMENT_TARGETS = Object.keys(TARGET_LABELS) as AdjustmentTarget[];

function addNewEffectRow(): void {
    newAdjEffects.value.push({ target: "attack", type: "untyped", value: 1 });
}

function addCustomAdjustment(): void {
    const name = newAdjName.value.trim();
    const effects = newAdjEffects.value.filter((e) => Number.isFinite(e.value) && e.value !== 0);
    if (!name || !effects.length) {
        macroStatus.value = "Give the adjustment a name and at least one non-zero effect.";
        return;
    }
    const state = adjustmentState();
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    state.custom.push({ id, name, effects: effects.map((e) => ({ ...e })) });
    state.enabled.push(id);
    newAdjName.value = "";
    newAdjEffects.value = [{ target: "attack", type: "untyped", value: 1 }];
    saveAndReexport(`${name} added and switched on.`);
}

function removeCustomAdjustment(id: string, name: string): void {
    const state = adjustmentState();
    state.custom = state.custom.filter((a) => a.id !== id);
    state.enabled = state.enabled.filter((k) => k !== id);
    saveAndReexport(`${name} removed.`);
}

/** Removes every Custom Data element this sheet wrote; elements you made by hand are untouched. */
function clearCustomData(): void {
    const id = currentLocalId.value;
    if (id === undefined) return flashCd("No token selected.");
    try {
        const result = removeCustomData(api, id);
        flashCd(result.summary || "Nothing from the sheet to remove.");
    } catch (e) {
        console.error("[pf1e-sheet] Custom Data removal failed", e);
        flashCd("Custom Data removal failed - see the console.");
    }
}

const resourceStatus = ref("");
let resourceStatusTimeout: ReturnType<typeof setTimeout> | undefined;

/**
 * Brings the token's trackers in line with the sheet: the Resources tab's button (re)creates missing ones,
 * and the Specials tab's Track checkboxes add or remove one. Returns the status text.
 */
function syncTrackersNow(): string {
    const id = currentLocalId.value;
    if (id === undefined) return "No token selected.";
    try {
        const current = data.value.resources ?? [];
        const result = syncTrackedResources(api, id, current, current, trackedKeys(data.value), isCharacter.value);
        data.value.resources = result.resources;
        save();
        if (result.summary) return result.summary;
        if (!trackedKeys(data.value).length) return "Nothing is tracked - tick Track on a resource to add its tracker.";
        return "Trackers are already up to date.";
    } catch (e) {
        console.error("[pf1e-sheet] tracker sync failed", e);
        return "Tracker sync failed - see the console.";
    }
}

function flashResourceStatus(text: string): void {
    resourceStatus.value = text;
    clearTimeout(resourceStatusTimeout);
    resourceStatusTimeout = setTimeout(() => (resourceStatus.value = ""), 6000);
}

/** The Resources tab's button: (re)create missing x/day, x/round and slot trackers, without a re-import. */
function resyncResources(): void {
    flashResourceStatus(syncTrackersNow());
}

// --- Specials tab: which limited-use abilities get a tracker -----------------------------------------

/** The tracked resource a special corresponds to: same name, or same name without its "(3/day)" part. */
function resourceForSpecial(sp: SpecialEntry): SheetResource | undefined {
    const all = data.value.resources ?? [];
    const key = resourceKeyForName(sp.name);
    return all.find((r) => r.name === sp.name) ?? all.find((r) => r.key === key);
}

/** Resources no special corresponds to, e.g. spell slots: listed separately on the Specials tab. */
const otherResources = computed(() => {
    const matched = new Set(
        (data.value.specials ?? []).map((sp) => resourceForSpecial(sp)?.key).filter((k): k is string => !!k),
    );
    return (data.value.resources ?? []).filter((r) => !matched.has(r.key));
});

function isTracked(r: SheetResource): boolean {
    return trackedKeys(data.value).includes(r.key);
}

function toggleTracked(r: SheetResource, on: boolean): void {
    const rest = trackedKeys(data.value).filter((k) => k !== r.key);
    data.value.trackedResources = on ? [...rest, r.key] : rest;
    delete data.value.untrackedResources;
    const text = syncTrackersNow();
    flashResourceStatus(
        text === "Trackers are already up to date." ? `${r.name}: ${on ? "tracked" : "not tracked"}.` : text,
    );
}

// --- Resources tab: uses left, kept on the sheet and mirrored to the token's tracker ---------------

/** Sets a resource's uses left (clamped), saves, and updates its tracker on the token if it has one. */
function setUsesLeft(r: SheetResource, value: number): void {
    const left = Math.max(0, Math.min(r.max, Math.round(Number.isFinite(value) ? value : usesLeft(r))));
    r.left = left;
    save();
    const id = currentLocalId.value;
    if (id === undefined) return;
    try {
        pushUsesLeft(api, id, r, left);
    } catch (e) {
        console.error("[pf1e-sheet] tracker update failed", e);
        flashResourceStatus("Updating the tracker failed - see the console.");
    }
}

function onUsesInput(r: SheetResource, event: Event): void {
    const input = event.target as HTMLInputElement;
    setUsesLeft(r, input.valueAsNumber);
    input.value = String(usesLeft(r)); // show the clamped value
}

/** After a night's rest: refill everything that comes back daily; charges and plain uses stay. */
function newDay(): void {
    const daily = (data.value.resources ?? []).filter(refillsDaily);
    for (const r of daily) setUsesLeft(r, r.max);
    flashResourceStatus(daily.length ? `Refilled ${daily.length} daily resource(s).` : "Nothing refills daily.");
}

const auraStatus = ref("");
let auraStatusTimeout: ReturnType<typeof setTimeout> | undefined;

/** The Token tab's button: (re)create any missing auras and fix radii, without a re-import. */
function resyncAuras(): void {
    const id = currentLocalId.value;
    let text: string;
    if (id === undefined) {
        text = "No token selected.";
    } else {
        try {
            const current = data.value.auras ?? [];
            const result = syncAuras(api, id, current, current);
            data.value.auras = result.auras;
            save();
            text = result.summary || (current.length ? "Auras are already up to date." : "No auras to create.");
        } catch (e) {
            console.error("[pf1e-sheet] aura resync failed", e);
            text = "Aura sync failed - see the console.";
        }
    }
    auraStatus.value = text;
    clearTimeout(auraStatusTimeout);
    auraStatusTimeout = setTimeout(() => (auraStatus.value = ""), 6000);
}

/**
 * Renames the token to the imported character's name via PA's real setter, properties.setName(
 * localId, name, sync). Verified with the diagnostics build: it updates the shape's property
 * state, and with server:true PA sends the change to the server. (An earlier attempt mutated
 * systemsState.properties.mutable.data instead, which is why that did nothing.)
 */
function renameShape(id: LocalId, name: string): string {
    if (!name) return "";
    const props = (
        api.systems as unknown as {
            properties?: { setName?: (id: number, name: string, sync: { ui: boolean; server: boolean }) => void };
        }
    ).properties;
    if (!props || typeof props.setName !== "function")
        return "Token not renamed (no properties.setName on this server).";
    try {
        props.setName(id, name, { ui: true, server: true });
        return `Token renamed to "${name}".`;
    } catch (e) {
        console.error("[pf1e-sheet] renaming the token failed", e);
        return "Token rename failed - see the console.";
    }
}

// --- Dice rolls ------------------------------------------------------------------------
//
// Every roll button rolls against the token's Custom Data fields - `1d20 + {STR mod}`, never a pasted
// number - so a value edited in PlanarAlly's Custom Data tab (a buff, a penalty) changes every roll that
// uses it. The names come from the same builder that exports the fields (see customdata.ts).
//
// Two modes. "panel": the formula goes into PlanarAlly's own dice panel and you press Enter there - PA's
// native roll, with 3D dice and the toast other players see (PA expands the fields itself). "quick":
// rolled right here with PA's 2d engine (roll.ts expands the fields) and shown only to you; nothing is
// sent to other players. Panel is the default because it is the one that is shared.
function loadRollMode(): "quick" | "panel" {
    try {
        return localStorage.getItem("pf1e-sheet-roll-mode") === "quick" ? "quick" : "panel";
    } catch {
        return "panel";
    }
}

const rollMode = ref<"quick" | "panel">(loadRollMode());

watch(rollMode, (mode) => {
    try {
        localStorage.setItem("pf1e-sheet-roll-mode", mode);
    } catch {
        /* not persisted; still applies for this session */
    }
});

// Show PlanarAlly's own result card (and record the roll in its dice history) for a quick roll.
// Verified on a live server: the card appears and the history entry carries the roll's label. On by
// default; remembered per browser because a popup on every skill check may not suit everyone.
function loadPopupPref(): boolean {
    try {
        return localStorage.getItem("pf1e-sheet-result-popup") !== "off";
    } catch {
        return true;
    }
}

const showResultCard = ref(loadPopupPref());

watch(showResultCard, (on) => {
    try {
        localStorage.setItem("pf1e-sheet-result-popup", on ? "on" : "off");
    } catch {
        /* not persisted; still applies for this session */
    }
});

const rollStatus = ref("");
const rolling = ref(false);

/** The Custom Data field names the buttons roll against, as the exporter names them. */
const sheetNames = computed(() => buildSheet(data.value).names);

async function doRoll(label: string, formula: string): Promise<void> {
    if (rolling.value) return;
    rolling.value = true;
    const shape = currentLocalId.value;

    const attempt = async (): Promise<string> => {
        if (rollMode.value === "panel") {
            rollStatus.value = `Opening ${label} in PA's dice panel...`;
            await openInDicePanel(api, formula, shape);
            return `${label}: ${formula} is in PA's dice panel - press Enter there to roll.`;
        }
        rollStatus.value = `Rolling ${label}...`;
        const out = await rollFormula(api, formula, { label, useNativeUi: showResultCard.value, shape });
        return (
            `${label}: ${out.total} (${out.breakdown}) = ${out.formula}` +
            (out.notes.length ? ` - ${out.notes.join("; ")}` : "")
        );
    };

    try {
        try {
            rollStatus.value = await attempt();
        } catch (e) {
            // The fields come from the last import/export. One that is missing - say the character was
            // imported before an update added it - is exported now and the roll tried once more.
            if (!(e instanceof MissingFieldsError) || shape === undefined) throw e;
            syncCustomData(api, shape, buildElements(data.value));
            rollStatus.value = `${await attempt()} (Custom Data was out of date, so it was re-exported first.)`;
        }
    } catch (e) {
        rollStatus.value = e instanceof RollError ? e.message : `Roll failed: ${String(e)}`;
        console.error("[pf1e-sheet] roll failed", e);
    } finally {
        rolling.value = false;
    }
}

/** A d20 check against one Custom Data field: `1d20 + {Spellcraft}`. */
function rollMod(label: string, fieldName: string | undefined): void {
    if (!fieldName) {
        rollStatus.value = `${label}: there is no Custom Data field for this - re-import the character.`;
        return;
    }
    void doRoll(label, checkFormula(fieldName));
}

/** Rolls the `n`th (0-based) iterative attack of attack row `i`. */
function rollAttack(i: number, n: number): void {
    const name = data.value.combat.attacks[i]?.name ?? "attack";
    const entry = sheetNames.value.attacks[i];
    const offset = entry?.offsets[n];
    if (!entry?.atk || offset === undefined) {
        rollStatus.value = `${name} has no attack bonus to roll.`;
        return;
    }
    const which = entry.offsets.length > 1 ? ` (${ordinal(n + 1)} attack)` : "";
    void doRoll(`Attack: ${name}${which}`, attackFormula(entry.atk, offset));
}

/** The button text for one iterative attack: its bonus, "+13". */
function attackBonusLabel(i: number, n: number): string {
    const bonus = iterativeBonuses(view.value.combat.attacks[i]?.bonus ?? "")[n];
    if (bonus === undefined) return "Atk";
    return bonus < 0 ? `${bonus}` : `+${bonus}`;
}

function rollDamage(i: number): void {
    const name = data.value.combat.attacks[i]?.name ?? "attack";
    const entry = sheetNames.value.attacks[i];
    if (!entry?.damage) {
        rollStatus.value = `${name} has no dice to roll for damage.`;
        return;
    }
    // The damage macro when the attack is in the macros (so a Custom Data edit applies), else the formula.
    void doRoll(`Damage: ${name}`, entry.dmg ? field(entry.dmg) : entry.damage);
}

function spellsByLevel(spells: PF1Character["spellcasting"][number]["spells"]) {
    const byLevel = new Map<number, typeof spells>();
    for (const spell of spells) {
        const bucket = byLevel.get(spell.level);
        if (bucket) bucket.push(spell);
        else byLevel.set(spell.level, [spell]);
    }
    return [...byLevel.entries()]
        .sort(([a], [b]) => a - b)
        .map(([level, levelSpells]) => ({
            level,
            spells: [...levelSpells].sort((a, b) => a.name.localeCompare(b.name)),
        }));
}

// --- Sheet tab: the paper-style front page ---------------------------------------------------------
// The breakdowns are Hero Lab's own numbers (stored on import). What the Adjustments tab adds on top
// is shown as the paper sheet's "temp" column: the adjusted total minus the imported one.

const ABILITY_KEYS: readonly AbilityKey[] = ["str", "dex", "con", "int", "wis", "cha"];
const ABILITY_NAMES: Record<AbilityKey, string> = {
    str: "Strength",
    dex: "Dexterity",
    con: "Constitution",
    int: "Intelligence",
    wis: "Wisdom",
    cha: "Charisma",
};

const abilityRows = computed(() =>
    ABILITY_KEYS.map((key) => {
        const score = data.value.abilities[key];
        const adjusted = view.value.abilities[key];
        return {
            key,
            label: key.toUpperCase(),
            name: ABILITY_NAMES[key],
            score,
            base: data.value.abilityBase?.[key] ?? score,
            mod: abilityModifier(score),
            /** Adjustments' change to the score, and the modifier it gives; undefined when unadjusted. */
            tempScore: adjusted !== score ? adjusted - score : undefined,
            tempMod: adjusted !== score ? abilityModifier(adjusted) : undefined,
        };
    }),
);

/** The class line under the name: "Oracle (Dual-Cursed Oracle) 4 / Paladin (Hospitaler) 3 / Hierophant 1". */
const classLine = computed(() => {
    const parts = data.value.classes.map((c) => `${c.name} ${c.level}`);
    if (data.value.mythic) parts.push(`${data.value.mythic.path} ${data.value.mythic.tier} (mythic)`);
    return parts.join(" / ");
});

const temp = (adjusted: number, imported: number): number | undefined =>
    adjusted !== imported ? adjusted - imported : undefined;

const acRow = computed(() => {
    const p = data.value.combat.acParts;
    const parts = p
        ? [
              { cap: "Armor", value: p.armor },
              { cap: "Shield", value: p.shield },
              { cap: "Dex", value: p.dex },
              { cap: "Size", value: p.size },
              { cap: "Natural", value: p.natural },
              { cap: "Deflect", value: p.deflect },
              { cap: "Dodge", value: p.dodge },
              { cap: "Misc", value: p.misc },
          ]
        : undefined;
    return { parts, temp: temp(view.value.combat.ac.normal, data.value.combat.ac.normal) };
});

const SAVE_ROWS = [
    { key: "fort", label: "Fortitude", ability: "Constitution", roll: "Fortitude" },
    { key: "ref", label: "Reflex", ability: "Dexterity", roll: "Reflex" },
    { key: "will", label: "Will", ability: "Wisdom", roll: "Will" },
] as const;

const saveRows = computed(() =>
    SAVE_ROWS.map((r) => {
        const s = data.value.combat.saves[r.key];
        return {
            ...r,
            total: view.value.combat.saves[r.key].total,
            field: sheetNames.value[r.key],
            parts:
                s.ability === undefined
                    ? undefined
                    : [
                          { cap: "Base", value: s.base },
                          { cap: "Ability", value: s.ability },
                          { cap: "Magic", value: s.resist ?? 0 },
                          { cap: "Misc", value: s.misc ?? 0 },
                      ],
            temp: temp(view.value.combat.saves[r.key].total, s.total),
        };
    }),
);

/** CMB = BAB + Str + size/misc; CMD = 10 + BAB + Str + Dex + size/misc (from the imported numbers). */
const maneuverRows = computed(() => {
    const c = data.value.combat;
    const str = abilityModifier(data.value.abilities.str);
    const dex = abilityModifier(data.value.abilities.dex);
    return {
        cmb: [
            { cap: "BAB", value: c.bab },
            { cap: "Str", value: str },
            { cap: "Size/misc", value: c.cmb - c.bab - str },
        ],
        cmbTemp: temp(view.value.combat.cmb, c.cmb),
        cmd: [
            { cap: "BAB", value: c.bab },
            { cap: "Str", value: str },
            { cap: "Dex", value: dex },
            { cap: "Size/misc", value: c.cmd - 10 - c.bab - str - dex },
        ],
        cmdTemp: temp(view.value.combat.cmd, c.cmd),
    };
});

const initiativeRow = computed(() => {
    const p = data.value.combat.initiativeParts;
    return {
        parts: p
            ? [
                  { cap: "Dex", value: p.ability },
                  { cap: "Misc", value: p.misc },
              ]
            : undefined,
        temp: temp(view.value.combat.initiative, data.value.combat.initiative),
    };
});

/** A skill's paper row: total = ability + ranks + misc (misc includes class skill +3 and armor check). */
const skillRows = computed(() =>
    view.value.skills.map((skill, i) => {
        const imported = data.value.skills[i];
        const abilityMod = imported?.abilityMod ?? abilityModifier(data.value.abilities[skill.ability]);
        const ranks = skill.ranks;
        return {
            skill,
            i,
            abilityMod,
            ranks,
            misc: (imported?.total ?? skill.total) - abilityMod - ranks,
            temp: imported ? temp(skill.total, imported.total) : undefined,
        };
    }),
);

// A sheet imported before the compendium (or on a server without one) still carries its feat, spell and
// skill rules text. On a server with the compendium, move that text there the first time the sheet is
// opened, as a re-import would - so older sheets shrink and their rules get compendium pages too.
watch(
    () => [rulesReady.value, data.value] as const,
    ([ready, c]) => {
        if (!ready || currentLocalId.value === undefined || !c.importedAt) return;
        const hasText =
            c.feats.some((f) => f.fullText) ||
            c.skills.some((s) => s.description) ||
            c.spellcasting.some((sc) => sc.spells.some((sp) => sp.fullText));
        if (!hasText) return;
        try {
            const copy = JSON.parse(JSON.stringify(c)) as PF1Character;
            const added = moveRulesToCompendium(api, copy);
            write(copy);
            save();
            console.info(`[pf1e-sheet] moved this sheet's rules text to the compendium (${added} new entries)`);
        } catch (e) {
            console.error("[pf1e-sheet] moving rules text to the compendium failed", e);
        }
    },
    { immediate: true },
);

// --- Rule cards: the styled hover / click popover for skills, feats, spells and specials -----------
// A card of the sheet's own (rather than the browser's plain title tooltip): the name, a details line
// or two, and the rules text in paragraphs with "Benefit:"-style labels in bold. It follows the mouse
// on hover; a click pins it, so long text can be scrolled, and offers PlanarAlly's compendium page
// when the rule is registered there.

interface RuleCard {
    title: string;
    meta: string[];
    body: string;
    rule?: { kind: RuleKind; name: string };
}

function skillCard(row: (typeof skillRows.value)[number]): RuleCard {
    const s = row.skill;
    const parts = [`ability ${fmt(row.abilityMod)}`, `ranks ${row.ranks}`, `misc ${fmt(row.misc)}`];
    if (row.temp !== undefined) parts.push(`temp ${fmt(row.temp)}`);
    const flags = [
        s.classSkill ? "Class skill" : "",
        s.trainedOnly ? "Trained only" : "",
        s.armorCheck ? "Armor check penalty applies" : "",
    ].filter(Boolean);
    return {
        title: `${s.name} (${s.ability.toUpperCase()}) ${fmt(s.total)}`,
        meta: [`= ${parts.join(", ")}`, flags.join(" · "), s.situational ? `Situational: ${s.situational}` : ""].filter(
            Boolean,
        ),
        body: s.description || ruleText("skill", s.name),
        rule: { kind: "skill", name: s.name },
    };
}

function featCard(feat: FeatEntry): RuleCard {
    return {
        title: feat.name,
        meta: feat.category ? [feat.category] : [],
        body: feat.fullText || ruleText("feat", feat.name) || feat.description,
        rule: { kind: "feat", name: feat.name },
    };
}

function specialCard(sp: SpecialEntry): RuleCard {
    const resource = resourceForSpecial(sp);
    const meta = [sp.type, sp.source ? `from ${sp.source}` : "", resource ? resourceLabel(resource) : ""].filter(
        Boolean,
    );
    return { title: sp.name, meta: meta.length ? [meta.join(" · ")] : [], body: sp.fullText || sp.description };
}

function spellCard(spell: SpellEntry): RuleCard {
    const meta = [
        [`Level ${spell.level}`, spell.school ?? ""].filter(Boolean).join(" · "),
        [spell.castTime, spell.range, spell.duration].filter(Boolean).join(" · "),
        spell.dc ? `DC ${spell.dc}${spell.save ? ` (${spell.save})` : ""}` : "",
    ].filter(Boolean);
    return {
        title: spell.name,
        meta,
        body: spellText(spell) || spell.description,
        rule: { kind: "spell", name: spell.name },
    };
}

/** A spell's full rules text: on the sheet (older imports or no compendium), else from the compendium. */
function spellText(spell: SpellEntry): string {
    return spell.fullText || ruleText("spell", spell.name);
}

const card = ref<(RuleCard & { x: number; y: number; pinned: boolean; note?: string }) | null>(null);
let cardHideTimer: ReturnType<typeof setTimeout> | undefined;

function showCard(c: RuleCard, event: MouseEvent): void {
    if (card.value?.pinned) return;
    clearTimeout(cardHideTimer);
    card.value = { ...c, x: event.clientX, y: event.clientY, pinned: false };
}

function hideCard(): void {
    if (!card.value || card.value.pinned) return;
    clearTimeout(cardHideTimer);
    // A short delay, so the mouse can move onto the card itself (to scroll it) without it vanishing.
    cardHideTimer = setTimeout(() => {
        if (card.value && !card.value.pinned) card.value = null;
    }, 150);
}

function keepCard(): void {
    clearTimeout(cardHideTimer);
}

/** A click pins the card - unless it was on a control (a Track checkbox, a button) inside the row. */
function pinCard(c: RuleCard, event: MouseEvent): void {
    if ((event.target as HTMLElement | null)?.closest("input, label, button")) return;
    clearTimeout(cardHideTimer);
    card.value = { ...c, x: event.clientX, y: event.clientY, pinned: true };
}

function closeCard(): void {
    card.value = null;
}

const cardStyle = computed(() => {
    const c = card.value;
    if (!c) return {};
    const width = Math.min(380, window.innerWidth - 16);
    return {
        width: `${width}px`,
        left: `${Math.max(8, Math.min(c.x + 14, window.innerWidth - width - 8))}px`,
        top: `${Math.max(8, Math.min(c.y + 14, window.innerHeight - 340))}px`,
    };
});

const cardInCompendium = computed(() => {
    const r = card.value?.rule;
    return r !== undefined && ruleRegistered(r.kind, r.name);
});

async function openCardInCompendium(event: MouseEvent): Promise<void> {
    const r = card.value?.rule;
    if (!r) return;
    const result = await openRule(api, r.kind, r.name, event);
    if (result.ok) card.value = null;
    else if (card.value) card.value.note = `Couldn't open it: ${result.reason}.`;
}

/** The card's paragraphs: split on blank lines (and before "Benefit:"-style lines), labels pulled out. */
function cardParagraphs(text: string): { label: string; text: string }[] {
    return text
        .split(/\n\s*\n|\n(?=[A-Z][\w ()'/,-]{1,40}:\s)/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
            const m = /^([A-Z][\w ()'/,-]{1,40}):\s+/.exec(p);
            return m ? { label: m[1]!, text: p.slice(m[0].length) } : { label: "", text: p };
        });
}

const shownSkillRows = computed(() => {
    const hidden = new Set(data.value.sheetConfig?.hiddenSkills ?? []);
    return skillRows.value.filter((r) => !hidden.has(r.skill.name));
});

const gearMoney = computed(() => {
    const m = data.value.currency;
    return [
        ["pp", m.pp],
        ["gp", m.gp],
        ["sp", m.sp],
        ["cp", m.cp],
    ]
        .filter(([, v]) => typeof v === "number" && v > 0)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
});

function fmt(n: number): string {
    return n >= 0 ? `+${n}` : `${n}`;
}
</script>

<template>
    <div id="pf1e-sheet" :style="widthStyle">
        <div v-if="availableUpdate" class="update-banner">
            PF1e sheet {{ availableUpdate }} is available (you have {{ modVersion }}).
            <a :href="RELEASES_URL" target="_blank" rel="noopener noreferrer">Download it from GitHub Releases</a>
            <button type="button" title="Hide until the next version" @click="dismissUpdate">✕</button>
        </div>
        <div class="pf1e-header">
            <div class="char-name">
                {{ data.identity.name || (isCharacter ? "Unnamed character" : "Unnamed creature") }}
                <span v-if="!isCharacter" class="sheet-kind">Monster / NPC</span>
            </div>
            <button
                v-if="!isCharacter"
                type="button"
                :disabled="duplicating"
                title="Make a copy of this token with the same sheet"
                @click="duplicate"
            >
                Duplicate token
            </button>
            <button type="button" @click="triggerImport">Import from Hero Lab…</button>
            <input ref="fileInput" type="file" accept=".xml" style="display: none" @change="onFileSelected" />
        </div>
        <div v-if="duplicateStatus" class="imported-at">{{ duplicateStatus }}</div>
        <div v-if="importError" class="error">{{ importError }}</div>
        <div v-if="data.importedAt" class="imported-at">
            Last imported: {{ new Date(data.importedAt).toLocaleString() }}
        </div>
        <div v-if="importNotes" class="imported-at dismissable">
            <span>{{ importNotes }}</span>
            <button type="button" title="Dismiss" @click="importNotes = ''">✕</button>
        </div>
        <div class="readonly-note">
            All fields except current HP are read-only - update the character in Hero Lab and re-import to change them.
        </div>
        <div v-if="activeAdjustmentNames.length" class="adjusted-note">
            Adjusted: {{ activeAdjustmentNames.join(", ") }} - the numbers and rolls below include them.
        </div>
        <div class="roll-bar">
            <span class="roll-mode">
                <label><input v-model="rollMode" type="radio" value="panel" /> PA dice panel (everyone sees it)</label>
                <label><input v-model="rollMode" type="radio" value="quick" /> Quick roll (only you)</label>
            </span>
            <label v-if="rollMode === 'quick'" class="roll-toggle">
                <input v-model="showResultCard" type="checkbox" /> Result popup
            </label>
            <span v-if="rollStatus" class="roll-status">{{ rollStatus }}</span>
        </div>

        <div class="pf1e-tabs">
            <button
                v-for="tab of visibleTabs"
                :key="tab"
                type="button"
                :class="{ active: activeTab === tab }"
                @click="activeTab = tab"
            >
                {{ tab }}
            </button>
            <span class="size-toggle" title="Sheet width">
                <button
                    v-for="w of WIDTH_KEYS"
                    :key="w"
                    type="button"
                    :class="{ active: sheetWidth === w }"
                    @click="setWidth(w)"
                >
                    {{ w }}
                </button>
            </span>
        </div>

        <div v-if="activeTab === 'Sheet'" class="pf1e-panel paper">
            <div class="id-grid">
                <div class="id-field wide">
                    <span class="id-val">{{ classLine || "-" }}</span>
                    <span class="cap">Character level (class)</span>
                </div>
                <div class="id-field">
                    <span class="id-val">{{ data.identity.race || "-" }}</span>
                    <span class="cap">Race</span>
                </div>
                <div class="id-field">
                    <span class="id-val">{{ data.identity.size }}</span>
                    <span class="cap">Size</span>
                </div>
                <div class="id-field">
                    <span class="id-val">{{ data.identity.gender || "-" }}</span>
                    <span class="cap">Gender</span>
                </div>
                <div class="id-field">
                    <span class="id-val">{{ data.identity.age || "-" }}</span>
                    <span class="cap">Age</span>
                </div>
                <div class="id-field">
                    <span class="id-val">{{ data.identity.alignment || "-" }}</span>
                    <span class="cap">Alignment</span>
                </div>
                <div class="id-field">
                    <span class="id-val">{{ data.identity.deity || "-" }}</span>
                    <span class="cap">Deity</span>
                </div>
            </div>
            <div class="paper-hint">
                Click a highlighted total to roll it. The <strong>M</strong> boxes put a roll in PlanarAlly's dice
                macros.
                <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
            </div>

            <div class="paper-grid">
                <section class="block" v-if="!isHidden('hiddenSections', 'abilities')">
                    <div class="bar">Abilities</div>
                    <div class="ability-head">
                        <span></span>
                        <span class="cap">Score</span>
                        <span class="cap">Mod</span>
                        <span class="cap">Temp adj</span>
                        <span class="cap">Temp mod</span>
                    </div>
                    <div v-for="row of abilityRows" :key="row.key" class="ability-line">
                        <span class="tag"
                            >{{ row.label }}<small>{{ row.name }}</small></span
                        >
                        <span class="box" :title="row.base !== row.score ? `Base ${row.base}` : undefined">{{
                            row.score
                        }}</span>
                        <button
                            v-if="row.tempMod === undefined"
                            type="button"
                            class="box total"
                            :disabled="rolling"
                            :title="`Roll a ${row.name} check`"
                            @click="rollMod(row.label + ' check', sheetNames.abilityMod[row.key])"
                        >
                            {{ fmt(row.mod) }}
                        </button>
                        <span v-else class="box">{{ fmt(row.mod) }}</span>
                        <span class="box">{{ row.tempScore === undefined ? "" : fmt(row.tempScore) }}</span>
                        <button
                            v-if="row.tempMod !== undefined"
                            type="button"
                            class="box total"
                            :disabled="rolling"
                            :title="`Roll a ${row.name} check`"
                            @click="rollMod(row.label + ' check', sheetNames.abilityMod[row.key])"
                        >
                            {{ fmt(row.tempMod) }}
                        </button>
                        <span v-else class="box"></span>
                    </div>
                </section>

                <section class="block" v-if="!isHidden('hiddenSections', 'hp')">
                    <div class="stat-line">
                        <span class="tag">HP<small>Hit points</small></span>
                        <span class="cell">
                            <span class="box">{{ view.combat.hp.max }}</span>
                            <span class="cap">Total</span>
                        </span>
                        <span class="cell">
                            <input
                                v-model.number="data.combat.hp.current"
                                class="box hp-current"
                                type="number"
                                title="Current HP - kept in step with the token's HP tracker"
                                @change="onHpCommitted"
                            />
                            <span class="cap">Current</span>
                        </span>
                        <span class="cell">
                            <span class="box">{{ view.combat.hp.nonlethal || "" }}</span>
                            <span class="cap">Nonlethal</span>
                        </span>
                    </div>
                    <div v-if="data.identity.hitDice" class="small-note">{{ data.identity.hitDice }}</div>

                    <div class="stat-line">
                        <span class="tag">Init<small>Initiative</small></span>
                        <span class="cell">
                            <button
                                type="button"
                                class="box total"
                                :disabled="rolling"
                                title="Roll initiative"
                                @click="rollMod('Initiative', sheetNames.init)"
                            >
                                {{ fmt(view.combat.initiative) }}
                            </button>
                            <span class="cap">Total</span>
                        </span>
                        <template v-if="initiativeRow.parts">
                            <span class="op">=</span>
                            <template v-for="(p, n) of initiativeRow.parts" :key="p.cap">
                                <span v-if="n" class="op">+</span>
                                <span class="cell">
                                    <span class="box">{{ fmt(p.value) }}</span>
                                    <span class="cap">{{ p.cap }}</span>
                                </span>
                            </template>
                        </template>
                        <template v-if="initiativeRow.temp !== undefined">
                            <span class="op">+</span>
                            <span class="cell">
                                <span class="box temp">{{ fmt(initiativeRow.temp) }}</span>
                                <span class="cap">Temp</span>
                            </span>
                        </template>
                        <label class="macro-box" title="Roll Initiative in PlanarAlly's dice macros">
                            <input
                                type="checkbox"
                                :checked="isRollMacro('Initiative')"
                                @change="toggleRollMacro('Initiative', ($event.target as HTMLInputElement).checked)"
                            />M
                        </label>
                    </div>

                    <div class="stat-line">
                        <span class="tag">Speed<small>Land</small></span>
                        <span class="cell">
                            <span class="box">{{ view.combat.speed }}</span>
                            <span class="cap">{{ data.combat.armorCheckPenalty ? "With armor" : "Feet" }}</span>
                        </span>
                        <span v-if="data.combat.baseSpeed && data.combat.baseSpeed !== data.combat.speed" class="cell">
                            <span class="box">{{ data.combat.baseSpeed }}</span>
                            <span class="cap">Base speed</span>
                        </span>
                    </div>
                    <div v-if="data.combat.armorCheckPenalty || data.combat.maxDex" class="small-note">
                        <span v-if="data.combat.armorCheckPenalty"
                            >Armor check penalty {{ data.combat.armorCheckPenalty }}</span
                        >
                        <span v-if="data.combat.maxDex"> · Max Dex {{ fmt(data.combat.maxDex) }}</span>
                    </div>
                </section>

                <section class="block full" v-if="!isHidden('hiddenSections', 'ac')">
                    <div class="stat-line">
                        <span class="tag">AC<small>Armor class</small></span>
                        <span class="cell">
                            <span class="box total">{{ view.combat.ac.normal }}</span>
                            <span class="cap">Total</span>
                        </span>
                        <template v-if="acRow.parts">
                            <span class="op">= 10 +</span>
                            <template v-for="(p, n) of acRow.parts" :key="p.cap">
                                <span v-if="n" class="op">+</span>
                                <span class="cell">
                                    <span class="box">{{ p.value ? fmt(p.value) : "" }}</span>
                                    <span class="cap">{{ p.cap }}</span>
                                </span>
                            </template>
                        </template>
                        <template v-if="acRow.temp !== undefined">
                            <span class="op">+</span>
                            <span class="cell">
                                <span class="box temp">{{ fmt(acRow.temp) }}</span>
                                <span class="cap">Temp</span>
                            </span>
                        </template>
                    </div>
                    <div class="stat-line">
                        <span class="tag">Touch</span>
                        <span class="box total">{{ view.combat.ac.touch }}</span>
                        <span class="tag">Flat-<br />footed</span>
                        <span class="box total">{{ view.combat.ac.flatFooted }}</span>
                    </div>
                </section>

                <section class="block full" v-if="!isHidden('hiddenSections', 'saves')">
                    <div class="bar">Saving throws</div>
                    <div v-for="row of saveRows" :key="row.key" class="stat-line">
                        <span class="tag wide"
                            >{{ row.label }}<small>{{ row.ability }}</small></span
                        >
                        <span class="cell">
                            <button
                                type="button"
                                class="box total"
                                :disabled="rolling"
                                :title="`Roll a ${row.label} save`"
                                @click="rollMod(`${row.label} save`, row.field)"
                            >
                                {{ fmt(row.total) }}
                            </button>
                            <span class="cap">Total</span>
                        </span>
                        <template v-if="row.parts">
                            <span class="op">=</span>
                            <template v-for="(p, n) of row.parts" :key="p.cap">
                                <span v-if="n" class="op">+</span>
                                <span class="cell">
                                    <span class="box">{{ fmt(p.value) }}</span>
                                    <span class="cap">{{ p.cap }}</span>
                                </span>
                            </template>
                        </template>
                        <template v-if="row.temp !== undefined">
                            <span class="op">+</span>
                            <span class="cell">
                                <span class="box temp">{{ fmt(row.temp) }}</span>
                                <span class="cap">Temp</span>
                            </span>
                        </template>
                        <label class="macro-box" :title="`Roll ${row.roll} in PlanarAlly's dice macros`">
                            <input
                                type="checkbox"
                                :checked="isRollMacro(row.roll)"
                                @change="toggleRollMacro(row.roll, ($event.target as HTMLInputElement).checked)"
                            />M
                        </label>
                    </div>
                    <div v-if="data.combat.saveNotes" class="small-note">
                        <strong>Situational:</strong> {{ data.combat.saveNotes }}
                    </div>
                </section>

                <section class="block full" v-if="!isHidden('hiddenSections', 'attack')">
                    <div class="stat-line">
                        <span class="tag wide">Base attack<small>bonus</small></span>
                        <span class="box">{{ fmt(view.combat.bab) }}</span>
                        <span v-if="data.combat.meleeAttack" class="small-note inline">
                            Melee {{ data.combat.meleeAttack }}
                        </span>
                        <span v-if="data.combat.rangedAttack" class="small-note inline">
                            Ranged {{ data.combat.rangedAttack }}
                        </span>
                    </div>
                    <div class="stat-line">
                        <span class="tag">CMB</span>
                        <span class="cell">
                            <button
                                type="button"
                                class="box total"
                                :disabled="rolling"
                                title="Roll a combat maneuver"
                                @click="rollMod('CMB', sheetNames.cmb)"
                            >
                                {{ fmt(view.combat.cmb) }}
                            </button>
                            <span class="cap">Total</span>
                        </span>
                        <span class="op">=</span>
                        <template v-for="(p, n) of maneuverRows.cmb" :key="p.cap">
                            <span v-if="n" class="op">+</span>
                            <span class="cell">
                                <span class="box">{{ fmt(p.value) }}</span>
                                <span class="cap">{{ p.cap }}</span>
                            </span>
                        </template>
                        <template v-if="maneuverRows.cmbTemp !== undefined">
                            <span class="op">+</span>
                            <span class="cell">
                                <span class="box temp">{{ fmt(maneuverRows.cmbTemp) }}</span>
                                <span class="cap">Temp</span>
                            </span>
                        </template>
                    </div>
                    <div class="stat-line">
                        <span class="tag">CMD</span>
                        <span class="cell">
                            <span class="box total">{{ view.combat.cmd }}</span>
                            <span class="cap">Total</span>
                        </span>
                        <span class="op">= 10 +</span>
                        <template v-for="(p, n) of maneuverRows.cmd" :key="p.cap">
                            <span v-if="n" class="op">+</span>
                            <span class="cell">
                                <span class="box">{{ fmt(p.value) }}</span>
                                <span class="cap">{{ p.cap }}</span>
                            </span>
                        </template>
                        <template v-if="maneuverRows.cmdTemp !== undefined">
                            <span class="op">+</span>
                            <span class="cell">
                                <span class="box temp">{{ fmt(maneuverRows.cmdTemp) }}</span>
                                <span class="cap">Temp</span>
                            </span>
                        </template>
                        <span
                            v-if="data.combat.cmdFlatFooted && data.combat.cmdFlatFooted !== data.combat.cmd"
                            class="cell"
                        >
                            <span class="box">{{ data.combat.cmdFlatFooted }}</span>
                            <span class="cap">Flat-footed</span>
                        </span>
                    </div>
                </section>

                <template v-for="(atk, i) of view.combat.attacks" :key="`atk-${i}`">
                    <section
                        v-if="!isHidden('hiddenSections', 'weapons') && !isHidden('hiddenWeapons', atk.name)"
                        class="block weapon"
                    >
                        <div class="bar">
                            Weapon
                            <label
                                class="macro-box on-bar"
                                :title="`${atk.name}'s attack and damage in PlanarAlly's dice macros`"
                            >
                                <input
                                    type="checkbox"
                                    :checked="isMacroAttack(atk.name)"
                                    @change="toggleMacroAttack(atk.name, ($event.target as HTMLInputElement).checked)"
                                />M
                            </label>
                        </div>
                        <table class="weapon-table">
                            <tr class="caps">
                                <td class="w-name"></td>
                                <td>Attack bonus</td>
                                <td>Critical</td>
                            </tr>
                            <tr>
                                <td class="w-name">{{ atk.name }}</td>
                                <td class="w-attack">
                                    <span v-if="!sheetNames.attacks[i]?.atk">{{ atk.bonus }}</span>
                                    <button
                                        v-for="(_, n) of sheetNames.attacks[i]?.atk
                                            ? sheetNames.attacks[i]!.offsets
                                            : []"
                                        :key="n"
                                        type="button"
                                        class="box total"
                                        :disabled="rolling"
                                        :title="`Roll ${ordinal(n + 1)} attack`"
                                        @click="rollAttack(i, n)"
                                    >
                                        {{ attackBonusLabel(i, n) }}
                                    </button>
                                </td>
                                <td>{{ atk.critical }}</td>
                            </tr>
                            <tr class="caps">
                                <td>Type</td>
                                <td>Range</td>
                                <td>Damage</td>
                            </tr>
                            <tr>
                                <td>{{ atk.damageType }}</td>
                                <td>{{ atk.range || "" }}</td>
                                <td>
                                    <button
                                        v-if="sheetNames.attacks[i]?.damage"
                                        type="button"
                                        class="box total dmg"
                                        :disabled="rolling"
                                        title="Roll damage"
                                        @click="rollDamage(i)"
                                    >
                                        {{ atk.damage }}
                                    </button>
                                    <span v-else>{{ atk.damage }}</span>
                                </td>
                            </tr>
                        </table>
                    </section>
                </template>

                <section v-if="!isHidden('hiddenSections', 'skills')" class="block full">
                    <div class="bar">Skills</div>
                    <div class="table-wrap">
                        <table class="paper-table skills-table">
                            <thead>
                                <tr>
                                    <th></th>
                                    <th>Skill name</th>
                                    <th class="num">Total</th>
                                    <th class="num" title="Ability modifier">Abil</th>
                                    <th class="num">Ranks</th>
                                    <th class="num">Misc</th>
                                    <th v-if="shownSkillRows.some((r) => r.temp !== undefined)" class="num">Temp</th>
                                    <th title="Put Roll <skill> in PlanarAlly's dice macros">M</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="row of shownSkillRows" :key="row.i">
                                    <td class="flags">
                                        <span v-if="row.skill.classSkill" title="Class skill">✓</span>
                                    </td>
                                    <td
                                        class="skill-name"
                                        @mouseenter="showCard(skillCard(row), $event)"
                                        @mouseleave="hideCard"
                                        @click="pinCard(skillCard(row), $event)"
                                    >
                                        {{ row.skill.name }}
                                        <span v-if="row.skill.situational" class="flag" title="Situational modifier"
                                            >*</span
                                        >
                                        <span class="skill-ability">{{ row.skill.ability.toUpperCase() }}</span>
                                        <span v-if="row.skill.trainedOnly" class="flag" title="Trained only">T</span>
                                        <span
                                            v-if="row.skill.armorCheck"
                                            class="flag"
                                            title="Armor check penalty applies"
                                            >A</span
                                        >
                                    </td>
                                    <td class="num">
                                        <button
                                            type="button"
                                            class="box total"
                                            :disabled="rolling"
                                            :title="`Roll ${row.skill.name}`"
                                            @click="rollMod(row.skill.name, sheetNames.skills[row.i])"
                                        >
                                            {{ fmt(row.skill.total) }}
                                        </button>
                                    </td>
                                    <td class="num">{{ fmt(row.abilityMod) }}</td>
                                    <td class="num">{{ row.ranks || "" }}</td>
                                    <td class="num">{{ row.misc ? fmt(row.misc) : "" }}</td>
                                    <td v-if="shownSkillRows.some((r) => r.temp !== undefined)" class="num temp-inline">
                                        {{ row.temp === undefined ? "" : fmt(row.temp) }}
                                    </td>
                                    <td>
                                        <input
                                            type="checkbox"
                                            :checked="isMacroSkill(row.skill.name)"
                                            :title="`Show Roll ${row.skill.name} in PlanarAlly's dice macros`"
                                            @change="
                                                toggleMacroSkill(
                                                    row.skill.name,
                                                    ($event.target as HTMLInputElement).checked,
                                                )
                                            "
                                        />
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="small-note">
                        Hover a skill for its rules text. ✓ class skill · T trained only · A armor check penalty applies
                        · * situational modifier · misc includes the class-skill +3 and armor check penalty
                    </div>
                </section>

                <section
                    v-if="(data.combat.maneuvers ?? []).length && !isHidden('hiddenSections', 'maneuvers')"
                    class="block"
                >
                    <div class="bar">Combat maneuvers</div>
                    <table class="paper-table">
                        <thead>
                            <tr>
                                <th>Maneuver</th>
                                <th class="num">CMB</th>
                                <th class="num">CMD</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="m of data.combat.maneuvers ?? []" :key="m.name">
                                <td>{{ m.name }}</td>
                                <td class="num">{{ fmt(m.cmb) }}</td>
                                <td class="num">{{ m.cmd }}</td>
                            </tr>
                        </tbody>
                    </table>
                </section>

                <section class="block">
                    <template v-if="(data.identity.languages ?? []).length && !isHidden('hiddenSections', 'languages')">
                        <div class="bar">Languages</div>
                        <div class="block-text">{{ (data.identity.languages ?? []).join(" • ") }}</div>
                    </template>
                    <template v-if="!isHidden('hiddenSections', 'money')">
                        <div class="bar">Money &amp; experience</div>
                        <div class="block-text">
                            <div>{{ gearMoney || "0 gp" }}</div>
                            <div v-if="data.xp">XP {{ data.xp.toLocaleString() }}</div>
                        </div>
                    </template>
                </section>
            </div>
        </div>

        <div v-else-if="activeTab === 'Token'" class="pf1e-panel">
            <h4>HP tracker</h4>
            <div class="readonly-note">
                Current HP on the Sheet tab and the token's tracker named "HP" are kept in step both ways.
            </div>
            <div class="hp-push-row">
                <button type="button" @click="manualPushHp">Push HP to tracker</button>
                <span v-if="pushStatus" class="hp-push-status">{{ pushStatus }}</span>
            </div>

            <h4>Auras (from the Hero Lab specials)</h4>
            <div v-if="(data.auras ?? []).length" class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Aura</th>
                            <th>Type</th>
                            <th>Radius</th>
                            <th>On token</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="aura of data.auras ?? []" :key="aura.key">
                            <td>{{ aura.name }}</td>
                            <td>{{ aura.kind === "vision" ? "Vision" : "Radius" }}</td>
                            <td>{{ aura.radius }} ft</td>
                            <td>{{ aura.uuid ? "yes" : "no" }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div v-else class="readonly-note">
                No Darkvision, Blindsight or ranged aura found in the Hero Lab specials.
            </div>
            <div class="hp-push-row">
                <button type="button" @click="resyncAuras">Create / update auras on the token</button>
                <span v-if="auraStatus" class="hp-push-status">{{ auraStatus }}</span>
            </div>

            <h4>Custom Data (for PlanarAlly's dice panel)</h4>
            <div class="readonly-note">
                Every import writes the sheet's numbers and roll macros into this token's Custom Data (source
                "pf1e-sheet"). The macros - initiative, saves, attacks, damage and the skills and spells ticked
                <strong>M</strong> - appear on PlanarAlly's dice prompt. You can also type formulas like 1d20 +
                {Spellcraft} or 1d20 + {STR mod} there. The roll buttons on this sheet use these same fields, so a value
                changed there (a buff, a penalty) changes every roll that uses it.
            </div>
            <div class="hp-push-row">
                <button type="button" @click="exportCustomData">Export to Custom Data</button>
                <button type="button" @click="clearCustomData">Remove sheet data from Custom Data</button>
                <span v-if="cdStatus" class="hp-push-status">{{ cdStatus }}</span>
            </div>
        </div>

        <div v-else-if="activeTab === 'Adjustments'" class="pf1e-panel">
            <div class="readonly-note">
                Ticked adjustments are added to this sheet's numbers, its roll buttons and the token's dice macros,
                following PF1 stacking (same-type bonuses don't stack; dodge, circumstance and untyped do). Export from
                Hero Lab with its own adjustments switched <strong>off</strong>, or they count twice.
                <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
            </div>

            <template v-for="g of adjustmentGroups" :key="g.group">
                <h4>{{ g.group }}</h4>
                <div class="adjustment-list">
                    <label v-for="adj of g.items" :key="adj.key" class="adjustment">
                        <input
                            type="checkbox"
                            :checked="isAdjustmentOn(adj.key)"
                            @change="toggleAdjustment(adj.key, adj.name, ($event.target as HTMLInputElement).checked)"
                        />
                        <span class="adj-name">{{ adj.name }}</span>
                        <span class="adj-effects">{{ describeEffects(adj.effects, adj.extraAttack) }}</span>
                    </label>
                </div>
            </template>

            <h4>Custom</h4>
            <div v-if="data.adjustments?.custom.length" class="adjustment-list">
                <div v-for="adj of data.adjustments.custom" :key="adj.id" class="adjustment">
                    <input
                        type="checkbox"
                        :checked="isAdjustmentOn(adj.id)"
                        @change="toggleAdjustment(adj.id, adj.name, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="adj-name">{{ adj.name }}</span>
                    <span class="adj-effects">{{ describeEffects(adj.effects) }}</span>
                    <button type="button" @click="removeCustomAdjustment(adj.id, adj.name)">Remove</button>
                </div>
            </div>
            <div class="custom-adjustment-form">
                <input v-model="newAdjName" type="text" placeholder="Name, e.g. Aid or Weapon Focus" />
                <div v-for="(eff, i) of newAdjEffects" :key="i" class="effect-row">
                    <input v-model.number="eff.value" type="number" class="effect-value" />
                    <select v-model="eff.type">
                        <option v-for="t of BONUS_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                    <select v-model="eff.target">
                        <option v-for="t of ADJUSTMENT_TARGETS" :key="t" :value="t">{{ TARGET_LABELS[t] }}</option>
                    </select>
                    <button v-if="newAdjEffects.length > 1" type="button" @click="newAdjEffects.splice(i, 1)">✕</button>
                </div>
                <div class="hp-push-row">
                    <button type="button" @click="addNewEffectRow">Add effect</button>
                    <button type="button" @click="addCustomAdjustment">Add adjustment</button>
                </div>
            </div>
        </div>

        <div v-else-if="activeTab === 'Feats'" class="pf1e-panel">
            <ul class="feat-list">
                <li
                    v-for="(feat, i) of data.feats"
                    :key="i"
                    class="hover-info"
                    @mouseenter="showCard(featCard(feat), $event)"
                    @mouseleave="hideCard"
                    @click="pinCard(featCard(feat), $event)"
                >
                    <strong>{{ feat.name }}</strong>
                    <span v-if="feat.category" class="special-source">{{ feat.category }}</span>
                    <div class="hint">{{ feat.description }}</div>
                </li>
            </ul>
        </div>

        <div v-else-if="activeTab === 'Spells'" class="pf1e-panel">
            <div class="readonly-note">
                Tick <strong>Macro</strong> to add a spell to PlanarAlly's dice macros as "Cast &lt;spell&gt;". Its
                formula is guessed from the spell's text at its caster level - edit it if needed (clear it to go back to
                the guess). Spells without dice start empty.
                <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
            </div>
            <div v-for="(sc, i) of data.spellcasting" :key="i" class="spell-class">
                <div class="spell-class-header">
                    <strong>{{ sc.className }}</strong>
                    CL {{ sc.casterLevel
                    }}<template v-if="sc.concentration"> · Concentration {{ fmt(sc.concentration) }}</template>
                </div>
                <div v-if="Object.keys(sc.spellsPerDay).length" class="spells-per-day">
                    <span v-for="(slots, level) of sc.spellsPerDay" :key="level">
                        Lv{{ level }}: {{ slots === -1 ? "at will" : `${slots}/day` }}
                    </span>
                </div>
                <div v-for="group of spellsByLevel(sc.spells)" :key="group.level" class="spell-level-group">
                    <h5>Level {{ group.level }}</h5>
                    <ul class="spell-rows">
                        <li v-for="spell of group.spells" :key="spell.name" class="spell-row">
                            <div class="spell-main">
                                <strong
                                    class="hover-info"
                                    @mouseenter="showCard(spellCard(spell), $event)"
                                    @mouseleave="hideCard"
                                    @click="pinCard(spellCard(spell), $event)"
                                    >{{ spell.name }}</strong
                                >
                                <div class="spell-meta">
                                    <span v-if="spell.dc" :title="spell.save">DC {{ spell.dc }}</span>
                                    <span v-if="spell.range">{{ spell.range }}</span>
                                    <span v-if="spell.duration">{{ spell.duration }}</span>
                                </div>
                                <div class="hint">{{ spell.description }}</div>
                            </div>
                            <div class="spell-controls">
                                <label :title="`Show Cast ${spell.name} in PlanarAlly's dice macros`">
                                    <input
                                        type="checkbox"
                                        :checked="isSpellMacro(sc, spell)"
                                        @change="
                                            toggleSpellMacro(sc, spell, ($event.target as HTMLInputElement).checked)
                                        "
                                    />
                                    Macro
                                </label>
                                <input
                                    class="spell-formula"
                                    type="text"
                                    :value="spellFormula(data, sc, spell)"
                                    placeholder="formula"
                                    @change="setSpellFormula(sc, spell, ($event.target as HTMLInputElement).value)"
                                />
                                <button
                                    type="button"
                                    :disabled="rolling || !spellFormula(data, sc, spell).trim()"
                                    @click="rollSpell(sc, spell)"
                                >
                                    Roll
                                </button>
                            </div>
                        </li>
                    </ul>
                </div>
            </div>
        </div>

        <div v-else-if="activeTab === 'Resources'" class="pf1e-panel">
            <div class="readonly-note">
                Uses left are kept on the sheet for every resource. Tick <strong>Track</strong> to also put a resource
                on the token as a tracker; the two then stay in step both ways. Nothing refills on its own:
                <strong>New day</strong> refills the daily ones (x/day, rounds/day, spell slots) but not charges.
                <span v-if="resourceStatus" class="hp-push-status">{{ resourceStatus }}</span>
            </div>
            <h4>Tracked resources</h4>
            <div class="hp-push-row">
                <button type="button" @click="newDay">New day</button>
                <button type="button" @click="resyncResources">Create / update trackers on the token</button>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Resource</th>
                            <th>Uses</th>
                            <th>Left</th>
                            <th>Track</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="res of data.resources ?? []" :key="res.key">
                            <td>{{ res.name }}</td>
                            <td>{{ resourceLabel(res) }}</td>
                            <td class="uses-left">
                                <button
                                    type="button"
                                    :disabled="usesLeft(res) <= 0"
                                    title="Use one"
                                    @click="setUsesLeft(res, usesLeft(res) - 1)"
                                >
                                    −
                                </button>
                                <input
                                    type="number"
                                    min="0"
                                    :max="res.max"
                                    :value="usesLeft(res)"
                                    @change="onUsesInput(res, $event)"
                                />
                                <button
                                    type="button"
                                    :disabled="usesLeft(res) >= res.max"
                                    title="Get one back"
                                    @click="setUsesLeft(res, usesLeft(res) + 1)"
                                >
                                    +
                                </button>
                                / {{ res.max }}
                            </td>
                            <td>
                                <label class="track-toggle" title="Keep a tracker on the token">
                                    <input
                                        type="checkbox"
                                        :checked="isTracked(res)"
                                        @change="toggleTracked(res, ($event.target as HTMLInputElement).checked)"
                                    />
                                    {{ !isTracked(res) ? "" : res.uuid ? "on token" : "missing" }}
                                </label>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-else-if="activeTab === 'Specials'" class="pf1e-panel">
            <div v-if="!(data.specials ?? []).length" class="readonly-note">
                No specials found - import the character from Hero Lab to fill this in.
            </div>
            <div v-if="(data.resources ?? []).length" class="readonly-note">
                Tick <strong>Track</strong> on an ability to put a tracker for it on the token (uses per day, rounds or
                charges); untick it to remove the tracker. The Resources tab counts uses either way and has a
                <strong>New day</strong> button.
                <span v-if="resourceStatus" class="hp-push-status">{{ resourceStatus }}</span>
            </div>
            <div v-for="group of groupSpecials(data.specials ?? [])" :key="group.category" class="special-group">
                <h5>{{ group.category }}</h5>
                <ul class="feat-list">
                    <li
                        v-for="sp of group.entries"
                        :key="sp.name"
                        class="hover-info"
                        @mouseenter="showCard(specialCard(sp), $event)"
                        @mouseleave="hideCard"
                        @click="pinCard(specialCard(sp), $event)"
                    >
                        <label v-if="resourceForSpecial(sp)" class="track-toggle" title="Keep a tracker on the token">
                            <input
                                type="checkbox"
                                :checked="isTracked(resourceForSpecial(sp)!)"
                                @change="
                                    toggleTracked(resourceForSpecial(sp)!, ($event.target as HTMLInputElement).checked)
                                "
                            />
                            Track
                        </label>
                        <strong>{{ sp.name }}</strong>
                        <span v-if="sp.source" class="special-source">{{ sp.source }}</span>
                        <div class="hint">{{ sp.description }}</div>
                    </li>
                </ul>
            </div>
            <div v-if="otherResources.length" class="special-group">
                <h5>Other trackers</h5>
                <ul class="feat-list">
                    <li v-for="r of otherResources" :key="r.key">
                        <label class="track-toggle" title="Keep a tracker on the token">
                            <input
                                type="checkbox"
                                :checked="isTracked(r)"
                                @change="toggleTracked(r, ($event.target as HTMLInputElement).checked)"
                            />
                            Track
                        </label>
                        <strong>{{ r.name }}</strong>
                        <div class="hint">{{ resourceLabel(r) }}</div>
                    </li>
                </ul>
            </div>
        </div>

        <div v-else-if="activeTab === 'Inventory'" class="pf1e-panel">
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Item</th>
                            <th>Qty</th>
                            <th>Weight</th>
                            <th>Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(item, i) of data.inventory" :key="i">
                            <td>{{ item.name }}</td>
                            <td>{{ item.quantity }}</td>
                            <td>{{ item.weight }}</td>
                            <td>{{ item.notes }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-else-if="activeTab === 'Config'" class="pf1e-panel">
            <div class="readonly-note">
                Choose what this sheet shows; the choices are saved with the character and kept when you re-import. A
                hidden weapon or skill is also left out of PlanarAlly's dice macros.
                <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
            </div>

            <h4>Sheet sections</h4>
            <div class="config-list">
                <label v-for="[key, label] of SHEET_SECTIONS" :key="key">
                    <input
                        type="checkbox"
                        :checked="!isHidden('hiddenSections', key)"
                        @change="setShown('hiddenSections', key, ($event.target as HTMLInputElement).checked, label)"
                    />
                    {{ label }}
                </label>
            </div>

            <h4>Weapons</h4>
            <div v-if="data.combat.attacks.length" class="config-list">
                <label v-for="(atk, i) of data.combat.attacks" :key="i">
                    <input
                        type="checkbox"
                        :checked="!isHidden('hiddenWeapons', atk.name)"
                        @change="setShown('hiddenWeapons', atk.name, ($event.target as HTMLInputElement).checked)"
                    />
                    {{ atk.name }} <span class="hint">{{ atk.bonus }} · {{ atk.damage }}</span>
                </label>
            </div>
            <div v-else class="readonly-note">No weapons in the Hero Lab export.</div>

            <h4>Skills</h4>
            <div class="hp-push-row">
                <button type="button" @click="hideSkillsWithoutRanks(true)">Hide skills without ranks</button>
                <button type="button" @click="hideSkillsWithoutRanks(false)">Show all skills</button>
            </div>
            <div class="config-list columns">
                <label v-for="skill of data.skills" :key="skill.name">
                    <input
                        type="checkbox"
                        :checked="!isHidden('hiddenSkills', skill.name)"
                        @change="setShown('hiddenSkills', skill.name, ($event.target as HTMLInputElement).checked)"
                    />
                    {{ skill.name }}
                </label>
            </div>

            <h4>Tabs</h4>
            <div class="config-list">
                <label v-for="tab of configTabs" :key="tab">
                    <input
                        type="checkbox"
                        :checked="!isHidden('hiddenTabs', tab)"
                        @change="setShown('hiddenTabs', tab, ($event.target as HTMLInputElement).checked, `${tab} tab`)"
                    />
                    {{ tab }}
                </label>
            </div>
        </div>

        <div v-else-if="activeTab === 'Diagnostics' && isDm" class="pf1e-panel">
            <div class="readonly-note">Both reports are read-only. Copy the output into a bug report.</div>

            <div class="diag-buttons">
                <button
                    type="button"
                    :disabled="diagBusy"
                    title="Checks the API functions the sheet uses, this token's HP tracker, Custom Data, roll formulas and auras"
                    @click="runDiag(() => buildHealthCheck(api, currentLocalId, data))"
                >
                    Health check
                </button>
                <button
                    type="button"
                    :disabled="diagBusy"
                    title="Everything PlanarAlly's mod API exposes, plus a scan of PlanarAlly's code. Large; for when an update breaks something"
                    @click="runDiag(() => buildApiDump(api, currentLocalId))"
                >
                    Full API dump
                </button>
            </div>

            <div class="diag-buttons">
                <button type="button" :disabled="!diagOutput" @click="copyDiag">Copy</button>
                <button type="button" @click="diagOutput = ''">Clear</button>
                <span v-if="diagBusy" class="hp-push-status">working...</span>
                <span v-if="diagCopyStatus" class="hp-push-status">{{ diagCopyStatus }}</span>
            </div>
            <textarea ref="diagTextarea" class="diag-output" readonly :value="diagOutput"></textarea>
        </div>

        <Teleport to="body">
            <div
                v-if="card"
                class="pf1e-rule-card"
                :class="{ pinned: card.pinned }"
                :style="cardStyle"
                @mouseenter="keepCard"
                @mouseleave="hideCard"
            >
                <div class="rc-head">
                    <strong>{{ card.title }}</strong>
                    <button v-if="card.pinned" type="button" title="Close" @click="closeCard">✕</button>
                </div>
                <div v-for="(m, i) of card.meta" :key="i" class="rc-meta">{{ m }}</div>
                <div class="rc-body">
                    <p v-for="(p, i) of cardParagraphs(card.body)" :key="i">
                        <strong v-if="p.label">{{ p.label }}:</strong> {{ p.text }}
                    </p>
                    <p v-if="!card.body" class="rc-empty">No rules text in this import.</p>
                </div>
                <div class="rc-foot">
                    <span v-if="card.note" class="rc-note">{{ card.note }}</span>
                    <button
                        v-if="card.pinned && card.rule && rulesReady"
                        type="button"
                        :title="
                            cardInCompendium
                                ? 'Open this rule\'s page in the compendium'
                                : 'Not found in the compendium yet'
                        "
                        @click="openCardInCompendium"
                    >
                        Open in compendium
                    </button>
                    <span v-if="!card.pinned">Click to pin</span>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<style scoped lang="scss">
#pf1e-sheet {
    box-sizing: border-box;
    // An explicit width (S/M/L, set from the tab row). PlanarAlly sizes the dialog to its content, so
    // a percentage width would not stop a long line of text from stretching it to the screen edge.
    width: var(--pf1e-width, 40rem);
    // ...but never wider than the screen, leaving room for the dialog's own left-hand tab list.
    max-width: calc(100vw - 12rem);
    height: 100%;
    // Cap to the viewport so the sheet scrolls internally instead of overflowing the dialog.
    max-height: calc(100vh - 8rem);
    overflow-x: hidden;
    overflow-y: auto;
    padding: 1rem;
    background-color: white;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
    // Paper-sheet colours: ink for bars, labels and box borders; a light fill for the totals.
    --pf1e-ink: #111;
    --pf1e-total: #fff6c8;
    --pf1e-total-hover: #ffe58a;

    *,
    *::before,
    *::after {
        box-sizing: border-box;
    }

    input {
        min-width: 0;
        max-width: 100%;
    }

    // Read-only values are plain text (not disabled inputs): a form control has an intrinsic width of
    // ~170px, which is what used to stretch the tables, and text simply wraps.
    .val {
        display: block;
        font-size: 0.9rem;
        color: #222;
        min-height: 1.2em;
    }

    // PA has global styles that can leak in; force plain block flow for content containers.
    .pf1e-panel {
        display: block;
        width: 100%;
    }

    // Section headings are the paper sheet's black bars, on every tab.
    h4,
    .bar {
        display: block;
        margin: 0.75rem 0 0.35rem;
        padding: 0.1rem 0.6rem;
        border-radius: 0.6rem 0.6rem 0 0;
        background: var(--pf1e-ink);
        color: #fff;
        font-size: 0.8rem;
        font-weight: 800;
        letter-spacing: 0.05em;
        text-align: center;
        text-transform: uppercase;
    }

    .bar {
        position: relative;
        margin: 0 0 0.3rem;
    }

    // --- Sheet tab: the paper front page -----------------------------------------------------------
    .paper {
        .id-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
            gap: 0.3rem 0.8rem;
            margin-bottom: 0.4rem;
        }

        .id-field {
            display: flex;
            flex-direction: column;
            min-width: 0;

            &.wide {
                grid-column: 1 / -1;
            }

            .id-val {
                border-bottom: 1px solid var(--pf1e-ink);
                font-size: 0.85rem;
                min-height: 1.2em;
            }

            .cap {
                max-width: none;
                text-align: left;
            }
        }

        .paper-hint {
            margin-bottom: 0.6rem;
            color: #666;
            font-size: 0.72rem;
            font-style: italic;
        }

        .paper-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
            gap: 0.8rem 1rem;
            align-items: start;
        }

        .block {
            min-width: 0;

            &.full {
                grid-column: 1 / -1;
            }
        }

        .block-text {
            margin-bottom: 0.5rem;
            font-size: 0.82rem;
        }

        .small-note {
            margin: 0 0 0.35rem;
            color: #444;
            font-size: 0.7rem;

            &.inline {
                margin: 0 0 0 0.4rem;
            }
        }

        .cap {
            display: block;
            max-width: 4rem;
            margin-top: 0.05rem;
            color: #444;
            font-size: 0.5rem;
            font-weight: 600;
            line-height: 1;
            text-align: center;
            text-transform: uppercase;
        }

        // A black label: "STR" over a tiny "Strength".
        .tag {
            display: inline-flex;
            flex: 0 0 auto;
            flex-direction: column;
            justify-content: center;
            min-width: 3.4rem;
            min-height: 1.7rem;
            padding: 0.1rem 0.3rem;
            background: var(--pf1e-ink);
            color: #fff;
            font-size: 0.85rem;
            font-weight: 800;
            line-height: 1;
            text-align: center;
            text-transform: uppercase;

            &.wide {
                min-width: 5.6rem;
            }

            small {
                margin-top: 0.1rem;
                font-size: 0.45rem;
                font-weight: 600;
                letter-spacing: 0.02em;
            }
        }

        // A boxed number, as on the paper sheet; highlighted when it is a total (and clickable to roll).
        .box {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 2.2rem;
            height: 1.6rem;
            padding: 0 0.25rem;
            border: 1.5px solid var(--pf1e-ink);
            background: #fff;
            color: var(--pf1e-ink);
            font: inherit;
            font-size: 0.9rem;
            font-weight: 700;
            white-space: nowrap;

            &.total {
                background: var(--pf1e-total);
            }

            &.temp {
                background: #fde7c7;
            }
        }

        button.box {
            cursor: pointer;

            &:hover:not(:disabled) {
                background: var(--pf1e-total-hover);
            }
        }

        input.box.hp-current {
            width: 3.6rem;
            text-align: center;
        }

        .cell {
            display: inline-flex;
            flex-direction: column;
            align-items: center;
        }

        .op {
            align-self: flex-start;
            padding: 0.25rem 0.05rem 0;
            font-size: 0.8rem;
            font-weight: 700;
            white-space: nowrap;
        }

        .stat-line {
            display: flex;
            flex-wrap: wrap;
            align-items: flex-start;
            gap: 0.25rem 0.3rem;
            margin-bottom: 0.45rem;
        }

        .macro-box {
            display: inline-flex;
            align-items: center;
            gap: 0.1rem;
            align-self: center;
            margin-left: auto;
            font-size: 0.65rem;
            font-weight: 700;

            &.on-bar {
                position: absolute;
                top: 50%;
                right: 0.5rem;
                transform: translateY(-50%);
                color: #fff;
            }
        }

        .ability-head,
        .ability-line {
            display: grid;
            grid-template-columns: 4.6rem repeat(4, 2.6rem);
            gap: 0.25rem;
            align-items: center;
            margin-bottom: 0.2rem;
        }

        .ability-line .tag {
            min-width: 0;
        }

        .weapon-table {
            width: 100%;
            border: 1.5px solid var(--pf1e-ink);
            border-collapse: collapse;

            td {
                padding: 0.1rem 0.3rem;
                border: 1px solid var(--pf1e-ink);
                font-size: 0.82rem;
                vertical-align: middle;
            }

            tr.caps td {
                padding: 0 0.3rem;
                background: var(--pf1e-ink);
                color: #fff;
                font-size: 0.5rem;
                font-weight: 700;
                text-align: center;
                text-transform: uppercase;
            }

            .w-name {
                width: 45%;
                font-weight: 700;
            }

            .w-attack .box {
                margin-right: 0.2rem;
            }

            .box.dmg {
                min-width: 3rem;
            }
        }

        .paper-table {
            th {
                border-bottom: 1.5px solid var(--pf1e-ink);
                font-size: 0.6rem;
                text-transform: uppercase;
            }

            th,
            td {
                padding: 0.15rem 0.25rem;
                overflow-wrap: normal;
            }

            td {
                border-bottom: 1px dotted #999;
                font-size: 0.82rem;
                vertical-align: middle;
            }

            .num {
                text-align: center;
            }

            .flags {
                width: 1rem;
                min-width: 0;
                text-align: center;
            }

            .flag {
                margin-left: 0.2rem;
                padding: 0 0.15rem;
                border: 1px solid #999;
                color: #555;
                font-size: 0.55rem;
                font-weight: 700;
            }

            .box {
                min-width: 2rem;
                height: 1.3rem;
                font-size: 0.8rem;
            }

            .temp-inline {
                color: #a35a00;
                font-weight: 700;
            }

            .skill-name {
                cursor: help;
            }

            .skill-ability {
                margin-left: 0.2rem;
                color: #666;
                font-size: 0.6rem;
            }

            th {
                white-space: nowrap;
            }
        }
    }

    ul,
    li {
        display: block;
        width: 100%;
    }

    .pf1e-header {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
        margin-bottom: 0.5rem;

        .char-name {
            flex: 1 1 10rem;
            min-width: 0;
            font-size: 1.05rem;
            font-weight: bold;
        }

        .sheet-kind {
            margin-left: 0.4rem;
            font-size: 0.7rem;
            font-weight: normal;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }

        button {
            flex: 0 0 auto;
        }
    }

    .error {
        color: #b00020;
        margin-bottom: 0.5rem;
    }

    .imported-at {
        color: #666;
        font-size: 0.8rem;
        margin-bottom: 0.5rem;
    }

    .diag-buttons {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
        margin-bottom: 0.5rem;
    }

    .diag-output {
        display: block;
        width: 100%;
        height: 22rem;
        font-family: monospace;
        font-size: 0.7rem;
        white-space: pre-wrap;
        overflow: auto;
        resize: vertical;
    }

    .dismissable {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;

        span {
            flex: 1 1 auto;
        }

        button {
            flex: 0 0 auto;
        }
    }

    .update-banner {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 0.5rem;
        margin-bottom: 0.5rem;
        border: 1px solid #3b82f6;
        border-radius: 4px;
        background: #eff6ff;
        font-size: 0.8rem;

        button {
            margin-left: auto;
        }
    }

    .adjusted-note {
        color: #8a4b00;
        font-size: 0.8rem;
        margin-bottom: 0.5rem;
    }

    .adjustment-list {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        margin-bottom: 0.4rem;
    }

    .adjustment {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
        font-size: 0.85rem;

        .adj-name {
            flex: 0 0 auto;
            font-weight: bold;
        }

        .adj-effects {
            flex: 1 1 auto;
            color: #555;
            font-size: 0.75rem;
        }
    }

    .spell-rows {
        list-style: none;
        margin: 0;
        padding: 0;
    }

    .spell-row {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 0.25rem 0.75rem;
        padding: 0.35rem 0;
        border-bottom: 1px solid #ddd;

        .spell-main {
            flex: 1 1 14rem;
            min-width: 0;
        }

        .spell-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 0 0.6rem;
            color: #555;
            font-size: 0.75rem;
        }

        .spell-controls {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            gap: 0.35rem;
            white-space: nowrap;
            font-size: 0.8rem;
        }

        .spell-formula {
            width: 5.5rem;
        }
    }

    .track-toggle {
        margin-right: 0.35rem;
        font-size: 0.75rem;
        white-space: nowrap;
    }

    .uses-left {
        white-space: nowrap;

        input {
            width: 3.5rem;
            text-align: center;
        }

        button {
            padding: 0 0.4rem;
        }
    }

    .config-list {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        margin-bottom: 0.5rem;
        font-size: 0.85rem;

        &.columns {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
        }

        .hint {
            color: #666;
            font-size: 0.75rem;
        }
    }

    .custom-adjustment-form {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        margin-top: 0.3rem;

        .effect-row {
            display: flex;
            flex-wrap: wrap;
            gap: 0.3rem;
        }

        .effect-value {
            width: 4rem;
        }
    }

    .readonly-note {
        color: #666;
        font-size: 0.75rem;
        font-style: italic;
        margin-bottom: 0.75rem;
    }

    .pf1e-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
        border-bottom: 1px solid #ccc;
        margin-bottom: 0.75rem;

        button {
            background: none;
            border: none;
            padding: 0.4rem 0.75rem;
            cursor: pointer;

            &.active {
                border-bottom: 2px solid #333;
                font-weight: bold;
            }
        }
    }

    .size-toggle {
        margin-left: auto;
        display: flex;
        gap: 0.1rem;
        align-self: center;

        button {
            padding: 0.2rem 0.45rem;
            font-size: 0.7rem;
            border: 1px solid #ccc;
            border-radius: 3px;
            background: #f4f4f4;

            &.active {
                background: #333;
                color: #fff;
                border-color: #333;
                border-bottom-width: 1px; // the tab buttons' 2px underline must not leak in
                font-weight: bold;
            }
        }
    }

    .roll-mode {
        display: flex;
        gap: 0.7rem;
    }

    .roll-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.6rem;
        margin-bottom: 0.6rem;
        font-size: 0.8rem;

        .roll-toggle {
            display: flex;
            align-items: center;
            gap: 0.3rem;
            color: #555;
        }

        .roll-status {
            font-weight: bold;
        }
    }

    .roll-cell {
        white-space: nowrap;

        button {
            margin-right: 0.25rem;
        }
    }

    .hp-push-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin-bottom: 0.75rem;

        .hp-push-status {
            font-size: 0.8rem;
            color: #555;
        }
    }

    // Tables scroll sideways inside their own container rather than widening the whole sheet.
    .table-wrap {
        max-width: 100%;
        overflow-x: auto;
        margin-bottom: 1rem;
    }

    table {
        width: 100%;
        border-collapse: collapse;

        th,
        td {
            text-align: left;
            padding: 0.2rem 0.4rem;
            border-bottom: 1px dotted #999;
            vertical-align: top;
        }

        // Paper-sheet column headings: small capitals over an ink rule.
        th {
            border-bottom: 1.5px solid var(--pf1e-ink);
            font-size: 0.6rem;
            text-transform: uppercase;
            white-space: nowrap;
        }

        // The first column is usually a name; let it wrap rather than force a wide table.
        td:first-child {
            min-width: 5rem;
        }
    }

    // Native title-attribute tooltip trigger. Deliberately not a custom CSS popup: this
    // server has already shown global styles can leak into our elements in surprising ways
    // (see the earlier feats-as-columns bug), and the browser's own tooltip is immune to that.
    .hover-info {
        cursor: help;
    }

    .info-icon {
        display: inline-block;
        margin-left: 0.3rem;
        color: #888;
        cursor: help;
        font-size: 0.85em;
    }

    .feat-list,
    .spell-list {
        list-style: none;
        padding: 0;
        margin: 0 0 0.75rem;

        li {
            margin-bottom: 0.4rem;
        }

        .hint {
            color: #666;
            font-size: 0.8rem;
        }
    }

    .spell-class {
        margin-bottom: 1rem;

        .spell-class-header {
            margin-bottom: 0.2rem;
        }

        .spells-per-day {
            display: flex;
            flex-wrap: wrap;
            gap: 0.75rem;
            color: #555;
            font-size: 0.8rem;
            margin-bottom: 0.4rem;
        }
    }

    .special-group {
        margin-bottom: 0.9rem;

        h5 {
            display: block;
            margin: 0 0 0.25rem;
            font-size: 0.8rem;
            font-weight: bold;
            color: #444;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }
    }

    .special-source {
        margin-left: 0.4rem;
        font-size: 0.75rem;
        color: #777;
        font-style: italic;
    }

    .spell-level-group {
        margin-bottom: 0.5rem;

        h5 {
            display: block;
            margin: 0 0 0.2rem;
            font-size: 0.8rem;
            font-weight: bold;
            color: #444;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }
    }
}

// The rule card is teleported to <body> (a dialog's transform would otherwise offset a fixed
// position), so it is styled here, outside #pf1e-sheet, with every property it relies on set
// explicitly against PlanarAlly's global styles.
.pf1e-rule-card {
    position: fixed;
    z-index: 10000;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    max-height: 320px;
    border: 2px solid #111;
    border-radius: 0.6rem 0.6rem 0.2rem 0.2rem;
    background: #fffdf5;
    color: #111;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
    font-family: inherit;
    font-size: 0.82rem;
    line-height: 1.35;
    text-align: left;
    pointer-events: auto;

    .rc-head {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.2rem 0.6rem;
        border-radius: 0.45rem 0.45rem 0 0;
        background: #111;
        color: #fff;
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.03em;

        strong {
            flex: 1 1 auto;
        }

        button {
            border: none;
            background: none;
            color: #fff;
            cursor: pointer;
            font-size: 0.85rem;
        }
    }

    .rc-meta {
        padding: 0.15rem 0.6rem 0;
        color: #444;
        font-size: 0.72rem;
        font-style: italic;
    }

    .rc-body {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 0.3rem 0.6rem;

        p {
            margin: 0 0 0.4rem;
            white-space: pre-line;
        }

        .rc-empty {
            color: #777;
            font-style: italic;
        }
    }

    .rc-foot {
        display: flex;
        justify-content: flex-end;
        gap: 0.4rem;
        padding: 0.2rem 0.6rem 0.3rem;
        border-top: 1px solid #ddd;
        color: #777;
        font-size: 0.68rem;

        &:empty {
            display: none;
        }

        .rc-note {
            flex: 1 1 auto;
            color: #a00;
        }
    }

    &.pinned {
        border-color: #7a2940;
    }
}
</style>
