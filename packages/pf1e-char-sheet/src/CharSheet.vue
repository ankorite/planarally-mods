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
    syncCustomData,
} from "./customdata";
import {
    abilityModifier,
    emptyCharacter,
    DATA_BLOCK_NAME,
    groupSpecials,
    type AdjustmentEffect,
    type AdjustmentState,
    type AdjustmentTarget,
    type PF1Character,
    type SpellcastingClass,
    type SpellEntry,
} from "./data";
import { buildApiDump, buildHealthCheck } from "./diagnostics";
import { duplicateToken } from "./duplicate";
import { parseHeroLabXml, HeroLabImportError } from "./herolab/parser";
import { api, modVersion } from "./main";
import { syncResources } from "./resources";
import { MissingFieldsError, RollError, openInDicePanel, rollFormula } from "./roll";
import { guessSpellFormula, spellFormula, spellKey } from "./spells";
import { pushHp, type HpPushResult } from "./trackers";
import { newerVersion, REPO_URL } from "./updates";

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
// gets the limited one: core, combat, skills and specials.
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

const BASE_TABS = ["Core", "Combat", "Skills", "Adjustments", "Feats", "Spells", "Specials", "Inventory"] as const;
const LIMITED_TABS = ["Core", "Combat", "Skills", "Adjustments", "Spells", "Specials"] as const;
type TabName = (typeof BASE_TABS)[number] | "Diagnostics";
const activeTab = ref<TabName>("Core");

// The Diagnostics tab (read-only reports on the sheet and PlanarAlly's mod API) is for the DM only.
// A DM who has switched to "fake player" (to preview what players see) gets the player view, i.e.
// no Diagnostics tab either.
const isDm = computed(() => viewerIsDm(api));
// The Spells tab only appears for a character or creature that has spells.
const hasSpells = computed(() => data.value.spellcasting.some((sc) => sc.spells.length > 0));
const visibleTabs = computed<readonly TabName[]>(() => {
    const all: readonly TabName[] = isCharacter.value ? BASE_TABS : LIMITED_TABS;
    const tabs = hasSpells.value ? all : all.filter((t) => t !== "Spells");
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
        if (version && version !== dismissed && viewerIsDm(api)) availableUpdate.value = version;
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
        if (!tabs.includes(activeTab.value)) activeTab.value = tabs[0] ?? "Combat";
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
                const result = syncResources(
                    api,
                    id,
                    character.resources ?? [],
                    data.value.resources ?? [],
                    isCharacter.value,
                );
                character.resources = result.resources;
                if (result.summary) notes.push(result.summary);
            } catch (e) {
                console.error("[pf1e-sheet] tracker sync after import failed", e);
                notes.push("Tracker sync failed - see the console.");
            }
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

/** The Skills tab's Macro checkbox (skills are out of the macros unless ticked). */
function toggleMacroSkill(name: string, on: boolean): void {
    const current = (data.value.macroSkills ?? []).filter((n) => n !== name);
    data.value.macroSkills = on ? [...current, name] : current;
    applyMacroChange(name, on);
}

function isMacroAttack(name: string): boolean {
    return !(data.value.macroExcludedAttacks ?? []).includes(name);
}

/** The Combat tab's Macro checkbox (attacks are in the macros unless unticked). */
function toggleMacroAttack(name: string, on: boolean): void {
    const current = (data.value.macroExcludedAttacks ?? []).filter((n) => n !== name);
    data.value.macroExcludedAttacks = on ? current : [...current, name];
    applyMacroChange(name, on);
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
    const guess = guessSpellFormula(spell.fullText || spell.description, sc.casterLevel);
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

/** The Core tab's button: (re)create missing x/day, x/round and slot trackers, without a re-import. */
function resyncResources(): void {
    const id = currentLocalId.value;
    let text: string;
    if (id === undefined) {
        text = "No token selected.";
    } else {
        try {
            const current = data.value.resources ?? [];
            const result = syncResources(api, id, current, current, isCharacter.value);
            data.value.resources = result.resources;
            save();
            text = result.summary || (current.length ? "Trackers are already up to date." : "No trackers to create.");
        } catch (e) {
            console.error("[pf1e-sheet] tracker resync failed", e);
            text = "Tracker sync failed - see the console.";
        }
    }
    resourceStatus.value = text;
    clearTimeout(resourceStatusTimeout);
    resourceStatusTimeout = setTimeout(() => (resourceStatus.value = ""), 6000);
}

const auraStatus = ref("");
let auraStatusTimeout: ReturnType<typeof setTimeout> | undefined;

/** The Core tab's button: (re)create any missing auras and fix radii, without a re-import. */
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

const abilityRows = computed(() =>
    (["str", "dex", "con", "int", "wis", "cha"] as const).map((key) => ({
        key,
        label: key.toUpperCase(),
        score: view.value.abilities[key],
        mod: abilityModifier(view.value.abilities[key]),
    })),
);

function fmt(n: number): string {
    return n >= 0 ? `+${n}` : `${n}`;
}
</script>

<template>
    <div id="pf1e-sheet" :style="widthStyle">
        <div v-if="availableUpdate" class="update-banner">
            PF1e sheet {{ availableUpdate }} is available (you have {{ modVersion }}).
            <a :href="REPO_URL" target="_blank" rel="noopener noreferrer">Get it on GitHub</a>
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
        <div v-if="importNotes" class="imported-at">{{ importNotes }}</div>
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

        <div v-if="activeTab === 'Core'" class="pf1e-panel">
            <div class="grid-3">
                <label
                    >Race<span class="val">{{ data.identity.race }}</span></label
                >
                <label
                    >Alignment<span class="val">{{ data.identity.alignment }}</span></label
                >
                <label
                    >Deity<span class="val">{{ data.identity.deity }}</span></label
                >
                <label
                    >Size<span class="val">{{ data.identity.size }}</span></label
                >
                <label
                    >Gender<span class="val">{{ data.identity.gender }}</span></label
                >
                <label
                    >Gold
                    <span class="val">{{ data.currency.gp }}</span>
                </label>
            </div>

            <h4>Classes</h4>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Class</th>
                            <th>Level</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(cls, i) of data.classes" :key="i">
                            <td>
                                <span class="val">{{ cls.name }}</span>
                            </td>
                            <td>
                                <span class="val">{{ cls.level }}</span>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <h4>Ability Scores</h4>
            <div class="abilities">
                <div v-for="row of abilityRows" :key="row.key" class="ability">
                    <div class="label">{{ row.label }}</div>
                    <div class="score">{{ view.abilities[row.key] }}</div>
                    <div class="mod">{{ fmt(row.mod) }}</div>
                    <button
                        type="button"
                        class="ability-roll"
                        :disabled="rolling"
                        @click="rollMod(row.label + ' check', sheetNames.abilityMod[row.key])"
                    >
                        Roll
                    </button>
                </div>
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

            <h4>Trackers (x/day, x/round, spell slots)</h4>
            <div v-if="(data.resources ?? []).length" class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Tracker</th>
                            <th>Max</th>
                            <th>On token</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="res of data.resources ?? []" :key="res.key">
                            <td>{{ res.name }}</td>
                            <td>{{ res.max }}</td>
                            <td>{{ res.uuid ? "yes" : "no" }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div v-else class="readonly-note">No limited-use abilities or spell slots in the Hero Lab export.</div>
            <div class="hp-push-row">
                <button type="button" @click="resyncResources">Create / update trackers on the token</button>
                <span v-if="resourceStatus" class="hp-push-status">{{ resourceStatus }}</span>
            </div>

            <h4>Custom Data (for PlanarAlly's dice panel)</h4>
            <div class="readonly-note">
                Every import writes the sheet's numbers and roll macros into this token's Custom Data (source
                "pf1e-sheet"). The macros - initiative, saves, attacks, damage and the skills ticked on the Skills tab -
                appear on PlanarAlly's dice prompt. You can also type formulas like 1d20 + {Spellcraft} or 1d20 + {STR
                mod} there. The roll buttons on this sheet use these same fields, so a value changed there (a buff, a
                penalty) changes every roll that uses it.
            </div>
            <div class="hp-push-row">
                <button type="button" @click="exportCustomData">Export to Custom Data</button>
                <button type="button" @click="clearCustomData">Remove sheet data from Custom Data</button>
                <span v-if="cdStatus" class="hp-push-status">{{ cdStatus }}</span>
            </div>
        </div>

        <div v-else-if="activeTab === 'Combat'" class="pf1e-panel">
            <div class="hp-push-row">
                <button type="button" @click="manualPushHp">Push HP to tracker</button>
                <span v-if="pushStatus" class="hp-push-status">{{ pushStatus }}</span>
            </div>
            <div class="roll-row">
                <button type="button" :disabled="rolling" @click="rollMod('Initiative', sheetNames.init)">
                    Roll initiative
                </button>
                <button type="button" :disabled="rolling" @click="rollMod('Fortitude save', sheetNames.fort)">
                    Fort
                </button>
                <button type="button" :disabled="rolling" @click="rollMod('Reflex save', sheetNames.ref)">
                    Reflex
                </button>
                <button type="button" :disabled="rolling" @click="rollMod('Will save', sheetNames.will)">Will</button>
                <button type="button" :disabled="rolling" @click="rollMod('CMB', sheetNames.cmb)">CMB</button>
            </div>
            <div class="grid-3">
                <label
                    >HP
                    <input
                        v-model.number="data.combat.hp.current"
                        class="hp-current"
                        type="number"
                        @change="onHpCommitted"
                    />
                    /
                    <span class="val">{{ view.combat.hp.max }}</span>
                </label>
                <label
                    >Nonlethal
                    <span class="val">{{ view.combat.hp.nonlethal }}</span>
                </label>
                <label
                    >Speed
                    <span class="val">{{ view.combat.speed }}</span>
                </label>
                <label
                    >AC
                    <span class="val">{{ view.combat.ac.normal }}</span>
                </label>
                <label
                    >Touch
                    <span class="val">{{ view.combat.ac.touch }}</span>
                </label>
                <label
                    >Flat-Footed
                    <span class="val">{{ view.combat.ac.flatFooted }}</span>
                </label>
                <label
                    >BAB
                    <span class="val">{{ view.combat.bab }}</span>
                </label>
                <label
                    >CMB
                    <span class="val">{{ view.combat.cmb }}</span>
                </label>
                <label
                    >CMD
                    <span class="val">{{ view.combat.cmd }}</span>
                </label>
                <label
                    >Initiative
                    <span class="val">{{ view.combat.initiative }}</span>
                </label>
            </div>

            <h4>Saves</h4>
            <div class="grid-3">
                <label
                    >Fort
                    <span class="val">{{ view.combat.saves.fort.total }}</span>
                </label>
                <label
                    >Reflex
                    <span class="val">{{ view.combat.saves.ref.total }}</span>
                </label>
                <label
                    >Will
                    <span class="val">{{ view.combat.saves.will.total }}</span>
                </label>
            </div>

            <h4>Attacks</h4>
            <div class="readonly-note">
                Untick <strong>Macro</strong> to leave a weapon's attack and damage rolls out of PlanarAlly's dice
                macros; its buttons here still work.
                <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Bonus</th>
                            <th>Damage</th>
                            <th>Crit</th>
                            <th>Type</th>
                            <th>Roll</th>
                            <th>Macro</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(atk, i) of view.combat.attacks" :key="i">
                            <td>
                                <span class="val">{{ atk.name }}</span>
                            </td>
                            <td>
                                <span class="val">{{ atk.bonus }}</span>
                            </td>
                            <td>
                                <span class="val">{{ atk.damage }}</span>
                            </td>
                            <td>
                                <span class="val">{{ atk.critical }}</span>
                            </td>
                            <td>
                                <span class="val">{{ atk.damageType }}</span>
                            </td>
                            <td class="roll-cell">
                                <button v-if="!sheetNames.attacks[i]?.atk" type="button" disabled>Atk</button>
                                <button
                                    v-for="(_, n) of sheetNames.attacks[i]?.atk ? sheetNames.attacks[i]!.offsets : []"
                                    :key="n"
                                    type="button"
                                    :disabled="rolling"
                                    :title="`Roll ${ordinal(n + 1)} attack`"
                                    @click="rollAttack(i, n)"
                                >
                                    {{ attackBonusLabel(i, n) }}
                                </button>
                                <button
                                    v-if="sheetNames.attacks[i]?.damage"
                                    type="button"
                                    :disabled="rolling"
                                    @click="rollDamage(i)"
                                >
                                    Dmg
                                </button>
                            </td>
                            <td>
                                <input
                                    type="checkbox"
                                    :checked="isMacroAttack(atk.name)"
                                    :title="`Show ${atk.name}'s attack and damage rolls in PlanarAlly's dice macros`"
                                    @change="toggleMacroAttack(atk.name, ($event.target as HTMLInputElement).checked)"
                                />
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div v-else-if="activeTab === 'Skills'" class="pf1e-panel">
            <div class="readonly-note">
                Tick <strong>Macro</strong> to add a skill to PlanarAlly's dice macros for this token. Initiative and
                saves are always there; attacks are chosen on the Combat tab.
                <span v-if="macroStatus" class="hp-push-status">{{ macroStatus }}</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Skill</th>
                            <th>Ability</th>
                            <th>Ranks</th>
                            <th>Class</th>
                            <th>Total</th>
                            <th>Roll</th>
                            <th>Macro</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(skill, i) of view.skills" :key="i">
                            <td>{{ skill.name }}</td>
                            <td>{{ skill.ability.toUpperCase() }}</td>
                            <td>
                                <span class="val">{{ skill.ranks }}</span>
                            </td>
                            <td>
                                <span class="val">{{ skill.classSkill ? "✓" : "" }}</span>
                            </td>
                            <td>
                                <span class="val">{{ skill.total }}</span>
                            </td>
                            <td class="roll-cell">
                                <button
                                    type="button"
                                    :disabled="rolling"
                                    @click="rollMod(skill.name, sheetNames.skills[i])"
                                >
                                    Roll
                                </button>
                            </td>
                            <td>
                                <input
                                    type="checkbox"
                                    :checked="isMacroSkill(skill.name)"
                                    :title="`Show Roll ${skill.name} in PlanarAlly's dice macros`"
                                    @change="toggleMacroSkill(skill.name, ($event.target as HTMLInputElement).checked)"
                                />
                            </td>
                        </tr>
                    </tbody>
                </table>
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
                <li v-for="(feat, i) of data.feats" :key="i">
                    <strong>{{ feat.name }}</strong>
                    <span v-if="feat.fullText" class="info-icon" :title="feat.fullText" aria-label="Full text">ⓘ</span>
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
                    <div class="table-wrap">
                        <table class="spell-table">
                            <thead>
                                <tr>
                                    <th>Spell</th>
                                    <th>DC</th>
                                    <th>Range</th>
                                    <th>Duration</th>
                                    <th>Macro</th>
                                    <th>Formula</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="spell of group.spells" :key="spell.name">
                                    <td>
                                        <strong>{{ spell.name }}</strong>
                                        <span
                                            v-if="spell.fullText"
                                            class="info-icon"
                                            :title="spell.fullText"
                                            aria-label="Full text"
                                            >ⓘ</span
                                        >
                                        <div class="hint">{{ spell.description }}</div>
                                    </td>
                                    <td :title="spell.save">{{ spell.dc ?? "" }}</td>
                                    <td>{{ spell.range ?? "" }}</td>
                                    <td>{{ spell.duration ?? "" }}</td>
                                    <td>
                                        <input
                                            type="checkbox"
                                            :checked="isSpellMacro(sc, spell)"
                                            :title="`Show Cast ${spell.name} in PlanarAlly's dice macros`"
                                            @change="
                                                toggleSpellMacro(sc, spell, ($event.target as HTMLInputElement).checked)
                                            "
                                        />
                                    </td>
                                    <td>
                                        <input
                                            class="spell-formula"
                                            type="text"
                                            :value="spellFormula(data, sc, spell)"
                                            placeholder="e.g. 3d6"
                                            @change="
                                                setSpellFormula(sc, spell, ($event.target as HTMLInputElement).value)
                                            "
                                        />
                                    </td>
                                    <td class="roll-cell">
                                        <button
                                            type="button"
                                            :disabled="rolling || !spellFormula(data, sc, spell).trim()"
                                            @click="rollSpell(sc, spell)"
                                        >
                                            Roll
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <div v-else-if="activeTab === 'Specials'" class="pf1e-panel">
            <div v-if="!(data.specials ?? []).length" class="readonly-note">
                No specials found - import the character from Hero Lab to fill this in.
            </div>
            <div v-for="group of groupSpecials(data.specials ?? [])" :key="group.category" class="special-group">
                <h5>{{ group.category }}</h5>
                <ul class="feat-list">
                    <li v-for="sp of group.entries" :key="sp.name">
                        <strong>{{ sp.name }}</strong>
                        <span v-if="sp.source" class="special-source">{{ sp.source }}</span>
                        <span v-if="sp.fullText" class="info-icon" :title="sp.fullText" aria-label="Full text">ⓘ</span>
                        <div class="hint">{{ sp.description }}</div>
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

    h4 {
        display: block;
        margin: 0.75rem 0 0.4rem;
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

    .spell-table {
        .spell-formula {
            width: 6rem;
        }

        td {
            vertical-align: top;
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

    .roll-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-bottom: 0.75rem;
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

    .grid-3 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
        gap: 0.5rem 1rem;
        margin-bottom: 1rem;

        label {
            display: flex;
            flex-direction: column;
            min-width: 0;
            font-size: 0.75rem;
            color: #555;

            input {
                width: 100%;
                font-size: 0.9rem;
            }

            // Current HP is the one editable number; keep it small so it never widens the row.
            input.hp-current {
                width: 5rem;
            }
        }
    }

    .abilities {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;

        .ability {
            display: flex;
            flex-direction: column;
            align-items: center;

            .ability-roll {
                margin-top: 0.2rem;
                padding: 0.1rem 0.45rem;
                font-size: 0.7rem;
            }

            .score {
                min-width: 2.2rem;
                text-align: center;
                font-size: 1.15rem;
                font-weight: bold;
            }
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
            border-bottom: 1px solid #eee;
            vertical-align: top;
        }

        // The first column is usually a name; let it wrap rather than force a wide table.
        td:first-child {
            min-width: 5rem;
        }
    }

    // Native title-attribute tooltip trigger. Deliberately not a custom CSS popup: this
    // server has already shown global styles can leak into our elements in surprising ways
    // (see the earlier feats-as-columns bug), and the browser's own tooltip is immune to that.
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
</style>
