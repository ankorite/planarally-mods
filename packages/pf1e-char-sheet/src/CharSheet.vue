<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from "vue";
import type { LocalId } from "@planarally/mod-api";

import { api } from "./main";
import {
    abilityModifier,
    emptyCharacter,
    DATA_BLOCK_NAME,
    groupSpecials,
    type PF1Character,
} from "./data";
import { parseHeroLabXml, HeroLabImportError } from "./herolab/parser";
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
import { pushHp, type HpPushResult } from "./trackers";
import { MissingFieldsError, RollError, openInDicePanel, rollFormula } from "./roll";
import {
    buildDeepData,
    buildDeepDice,
    buildBundleScan,
    buildDeepHooks,
    buildNativeDiceScan,
    buildReport,
    runAllLocalTests,
    runAuraSelfTest,
    runCustomDataSelfTest,
    runDiceEngineTest,
    runDicePanelTest,
    runDicePrefill,
    runRenameTest,
    runTrackerSelfTest,
} from "./diagnostics";

const { data, load, save, write } = api.useShapeDataBlock<PF1Character>(DATA_BLOCK_NAME, {
    defaultData: () => emptyCharacter(),
});

// The shape currently shown in the sheet, tracked separately from the DataBlock above
// because the tracker API is keyed by LocalId, not by the GlobalId the DataBlock uses.
const currentLocalId = ref<LocalId>();

// --- HP tracker sync ----------------------------------------------------------------
//
// Built on what a live server really exposes (verified with the diagnostics build; the published
// mod-api types are stale): trackers have add / getAll / update / remove, and PA announces every
// change on api.eventBus. This file handles sheet -> tracker; main.ts handles tracker -> sheet by
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

watch(
    () => api.systemsState.characters.reactive.activeCharacterId,
    async (charId) => {
        if (charId !== undefined) {
            const shapeId = api.systems.characters.getShapeId(charId);
            if (shapeId) load(shapeId);
            currentLocalId.value = api.systems.characters.getShape(charId)?.id;
            refreshLease();
        }
    },
    { immediate: true },
);

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
        flashPushStatus("No character selected.");
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

const BASE_TABS = ["Core", "Combat", "Skills", "Feats & Spells", "Specials", "Inventory"] as const;
const ALL_TABS = [...BASE_TABS, "Diagnostics"] as const;
type TabName = (typeof ALL_TABS)[number];
const activeTab = ref<TabName>("Core");

// The Diagnostics tab (API probes and tests that write to the server) is for the DM
// only. `isDm` / `isFakePlayer` live on PlanarAlly's game state but aren't in the published types.
// A DM who has switched to "fake player" (to preview what players see) gets the player view, i.e.
// no Diagnostics tab either.
const isDm = computed(() => {
    const game = (
        api.systemsState as unknown as {
            game?: { reactive?: { isDm?: boolean; isFakePlayer?: boolean } };
        }
    ).game;
    return game?.reactive?.isDm === true && game.reactive.isFakePlayer !== true;
});
const visibleTabs = computed<readonly TabName[]>(() => (isDm.value ? ALL_TABS : BASE_TABS));

// If the DM role goes away while Diagnostics is open (e.g. switching to fake player), leave it.
watch(isDm, (dm) => {
    if (!dm && activeTab.value === "Diagnostics") activeTab.value = "Core";
});

// --- Diagnostics (DIAGNOSTIC BUILD ONLY - see diagnostics.ts) ---------------------------
// Output accumulates so several probes can be run and then copied out in one go.
const diagOutput = ref("");
const diagBusy = ref(false);
const diagTextarea = ref<HTMLTextAreaElement>();
const diagCopyStatus = ref("");

function appendDiag(text: string): void {
    diagOutput.value += (diagOutput.value ? "\n\n" : "") + text;
}

async function runDiagAsync(fn: () => Promise<string>): Promise<void> {
    diagBusy.value = true;
    try {
        appendDiag(await fn());
    } catch (e) {
        appendDiag(`probe failed: ${String(e)}`);
    } finally {
        diagBusy.value = false;
    }
}

function runDiagSync(fn: () => string | string[]): void {
    try {
        const out = fn();
        appendDiag(Array.isArray(out) ? out.join("\n") : out);
    } catch (e) {
        appendDiag(`probe failed: ${String(e)}`);
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
        }

        write(character);
        save();

        if (id === undefined) {
            notes.push("No token selected - skipped renaming it, the HP tracker and the auras.");
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
    if (id === undefined) return flashCd("No character selected.");
    try {
        const result = syncCustomData(api, id, buildElements(data.value));
        flashCd(result.summary || "Custom Data is already up to date.");
    } catch (e) {
        console.error("[pf1e-sheet] Custom Data export failed", e);
        flashCd("Custom Data export failed - see the console.");
    }
}

/** Removes every Custom Data element this sheet wrote; elements you made by hand are untouched. */
function clearCustomData(): void {
    const id = currentLocalId.value;
    if (id === undefined) return flashCd("No character selected.");
    try {
        const result = removeCustomData(api, id);
        flashCd(result.summary || "Nothing from the sheet to remove.");
    } catch (e) {
        console.error("[pf1e-sheet] Custom Data removal failed", e);
        flashCd("Custom Data removal failed - see the console.");
    }
}

const auraStatus = ref("");
let auraStatusTimeout: ReturnType<typeof setTimeout> | undefined;

/** The Core tab's button: (re)create any missing auras and fix radii, without a re-import. */
function resyncAuras(): void {
    const id = currentLocalId.value;
    let text: string;
    if (id === undefined) {
        text = "No character selected.";
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
    if (!props || typeof props.setName !== "function") return "Token not renamed (no properties.setName on this server).";
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
    const bonus = iterativeBonuses(data.value.combat.attacks[i]?.bonus ?? "")[n];
    if (bonus === undefined) return "Atk";
    return bonus < 0 ? `${bonus}` : `+${bonus}`;
}

function rollDamage(i: number): void {
    const name = data.value.combat.attacks[i]?.name ?? "attack";
    const fieldName = sheetNames.value.attacks[i]?.dmg;
    if (!fieldName) {
        rollStatus.value = `${name} has no dice to roll for damage.`;
        return;
    }
    void doRoll(`Damage: ${name}`, field(fieldName));
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
        score: data.value.abilities[key],
        mod: abilityModifier(data.value.abilities[key]),
    })),
);

function fmt(n: number): string {
    return n >= 0 ? `+${n}` : `${n}`;
}
</script>

<template>
    <div id="pf1e-sheet" :style="widthStyle">
        <div class="pf1e-header">
            <div class="char-name">{{ data.identity.name || "Unnamed character" }}</div>
            <button type="button" @click="triggerImport">Import from Hero Lab…</button>
            <input
                ref="fileInput"
                type="file"
                accept=".xml"
                style="display: none"
                @change="onFileSelected"
            />
        </div>
        <div v-if="importError" class="error">{{ importError }}</div>
        <div v-if="data.importedAt" class="imported-at">
            Last imported: {{ new Date(data.importedAt).toLocaleString() }}
        </div>
        <div v-if="importNotes" class="imported-at">{{ importNotes }}</div>
        <div class="readonly-note">
            All fields except current HP are read-only - update the character in Hero Lab and
            re-import to change them.
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
                <label>Race<span class="val">{{ data.identity.race }}</span></label>
                <label>Alignment<span class="val">{{ data.identity.alignment }}</span></label>
                <label>Deity<span class="val">{{ data.identity.deity }}</span></label>
                <label>Size<span class="val">{{ data.identity.size }}</span></label>
                <label>Gender<span class="val">{{ data.identity.gender }}</span></label>
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
                        <td><span class="val">{{ cls.name }}</span></td>
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
                    <div class="score">{{ data.abilities[row.key] }}</div>
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

            <h4>Custom Data (for PlanarAlly's dice panel)</h4>
            <div class="readonly-note">
                Every import writes the sheet's numbers and ready-made rolls into this token's Custom
                Data (source "pf1e-sheet"). In PlanarAlly's dice panel type formulas like
                1d20 + {Spellcraft} or 1d20 + {STR mod} (they use whichever token is selected), or open
                the token's Custom Data tab and click a "Roll ..." element - it fills the dice panel and
                you press Enter for a native roll, 3D dice and notification included. The roll buttons on
                this sheet use these same fields, so a value changed there (a buff, a penalty) changes
                every roll that uses it.
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
                <button type="button" :disabled="rolling" @click="rollMod('Initiative', sheetNames.init)">Roll initiative</button>
                <button type="button" :disabled="rolling" @click="rollMod('Fortitude save', sheetNames.fort)">Fort</button>
                <button type="button" :disabled="rolling" @click="rollMod('Reflex save', sheetNames.ref)">Reflex</button>
                <button type="button" :disabled="rolling" @click="rollMod('Will save', sheetNames.will)">Will</button>
                <button type="button" :disabled="rolling" @click="rollMod('CMB', sheetNames.cmb)">CMB</button>
            </div>
            <div class="grid-3">
                <label
                    >HP
                    <input v-model.number="data.combat.hp.current" class="hp-current" type="number" @change="onHpCommitted" />
                    /
                    <span class="val">{{ data.combat.hp.max }}</span>
                </label>
                <label
                    >Nonlethal
                    <span class="val">{{ data.combat.hp.nonlethal }}</span>
                </label>
                <label
                    >Speed
                    <span class="val">{{ data.combat.speed }}</span>
                </label>
                <label
                    >AC
                    <span class="val">{{ data.combat.ac.normal }}</span>
                </label>
                <label
                    >Touch
                    <span class="val">{{ data.combat.ac.touch }}</span>
                </label>
                <label
                    >Flat-Footed
                    <span class="val">{{ data.combat.ac.flatFooted }}</span>
                </label>
                <label
                    >BAB
                    <span class="val">{{ data.combat.bab }}</span>
                </label>
                <label
                    >CMB
                    <span class="val">{{ data.combat.cmb }}</span>
                </label>
                <label
                    >CMD
                    <span class="val">{{ data.combat.cmd }}</span>
                </label>
                <label
                    >Initiative
                    <span class="val">{{ data.combat.initiative }}</span>
                </label>
            </div>

            <h4>Saves</h4>
            <div class="grid-3">
                <label
                    >Fort
                    <span class="val">{{ data.combat.saves.fort.total }}</span>
                </label>
                <label
                    >Reflex
                    <span class="val">{{ data.combat.saves.ref.total }}</span>
                </label>
                <label
                    >Will
                    <span class="val">{{ data.combat.saves.will.total }}</span>
                </label>
            </div>

            <h4>Attacks</h4>
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
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(atk, i) of data.combat.attacks" :key="i">
                        <td><span class="val">{{ atk.name }}</span></td>
                        <td><span class="val">{{ atk.bonus }}</span></td>
                        <td><span class="val">{{ atk.damage }}</span></td>
                        <td><span class="val">{{ atk.critical }}</span></td>
                        <td><span class="val">{{ atk.damageType }}</span></td>
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
                            <button v-if="sheetNames.attacks[i]?.dmg" type="button" :disabled="rolling" @click="rollDamage(i)">Dmg</button>
                        </td>
                    </tr>
                </tbody>
            </table>
            </div>
        </div>

        <div v-else-if="activeTab === 'Skills'" class="pf1e-panel">
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
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(skill, i) of data.skills" :key="i">
                        <td>{{ skill.name }}</td>
                        <td>{{ skill.ability.toUpperCase() }}</td>
                        <td><span class="val">{{ skill.ranks }}</span></td>
                        <td><span class="val">{{ skill.classSkill ? "✓" : "" }}</span></td>
                        <td><span class="val">{{ skill.total }}</span></td>
                        <td class="roll-cell">
                            <button type="button" :disabled="rolling" @click="rollMod(skill.name, sheetNames.skills[i])">Roll</button>
                        </td>
                    </tr>
                </tbody>
            </table>
            </div>
        </div>

        <div v-else-if="activeTab === 'Feats & Spells'" class="pf1e-panel">
            <h4>Feats</h4>
            <ul class="feat-list">
                <li v-for="(feat, i) of data.feats" :key="i">
                    <strong>{{ feat.name }}</strong>
                    <span
                        v-if="feat.fullText"
                        class="info-icon"
                        :title="feat.fullText"
                        aria-label="Full text"
                        >ⓘ</span
                    >
                    <div class="hint">{{ feat.description }}</div>
                </li>
            </ul>

            <h4>Spellcasting</h4>
            <div v-for="(sc, i) of data.spellcasting" :key="i" class="spell-class">
                <div class="spell-class-header">
                    <strong>{{ sc.className }}</strong>
                    CL {{ sc.casterLevel }} · Concentration {{ fmt(sc.concentration) }}
                </div>
                <div class="spells-per-day">
                    <span v-for="(slots, level) of sc.spellsPerDay" :key="level">
                        Lv{{ level }}: {{ slots === -1 ? "at will" : slots }}
                    </span>
                </div>
                <div v-for="group of spellsByLevel(sc.spells)" :key="group.level" class="spell-level-group">
                    <h5>Level {{ group.level }}</h5>
                    <ul class="spell-list">
                        <li v-for="(spell, j) of group.spells" :key="j">
                            <strong>{{ spell.name }}</strong>
                            <span
                                v-if="spell.fullText"
                                class="info-icon"
                                :title="spell.fullText"
                                aria-label="Full text"
                                >ⓘ</span
                            >
                            <div class="hint">{{ spell.description }}</div>
                        </li>
                    </ul>
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
                        <span
                            v-if="sp.fullText"
                            class="info-icon"
                            :title="sp.fullText"
                            aria-label="Full text"
                            >ⓘ</span
                        >
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
            <div class="readonly-note">
                Diagnostic build, round 2. Run the three deep dives and the local tests, then Copy and
                paste everything back. Tip: add one aura to this token first (so the aura test has a
                real one to clone), and after the dice prefill press Enter to actually roll before
                re-running "dice &amp; chat".
            </div>

            <div class="diag-group">Read-only probes</div>
            <div class="diag-buttons">
                <button type="button" :disabled="diagBusy" @click="runDiagSync(() => buildDeepHooks(api))">
                    Deep dive: hooks &amp; events
                </button>
                <button type="button" :disabled="diagBusy" @click="runDiagAsync(() => buildDeepDice(api))">
                    Deep dive: dice &amp; chat
                </button>
                <button type="button" :disabled="diagBusy" @click="runDiagSync(() => buildDeepData(api, currentLocalId))">
                    Deep dive: data / auras / properties
                </button>
                <button type="button" :disabled="diagBusy" @click="runDiagAsync(() => buildReport(api, currentLocalId))">
                    Overview report
                </button>
                <button type="button" :disabled="diagBusy" @click="runDiagAsync(() => buildBundleScan())">
                    Scan PA bundles (hooks, kinds, roll flow)
                </button>
                <button type="button" :disabled="diagBusy" @click="runDiagAsync(() => buildNativeDiceScan())">
                    Scan: native dice &amp; variables
                </button>
            </div>

            <div class="diag-group">Safe tests (local to this browser, clean up after themselves)</div>
            <div class="diag-buttons">
                <button type="button" @click="runDiagSync(() => runAllLocalTests(api, currentLocalId))">
                    Run ALL local tests
                </button>
                <button type="button" @click="runDiagSync(() => runTrackerSelfTest(api, currentLocalId, false))">Tracker</button>
                <button type="button" @click="runDiagSync(() => runCustomDataSelfTest(api, currentLocalId, false))">Custom data</button>
                <button type="button" @click="runDiagSync(() => runAuraSelfTest(api, currentLocalId))">Aura (clone)</button>
                <button type="button" @click="runDiagSync(() => runDicePrefill(api, '1d20+5'))">Dice: prefill 1d20+5</button>
                <button type="button" :disabled="diagBusy" @click="runDiagAsync(async () => (await runDicePanelTest(api)).join('\n'))">
                    Dice: open 1d20+5 in PA panel
                </button>
                <button type="button" :disabled="diagBusy" @click="runDiagAsync(async () => (await runDiceEngineTest(api)).join('\n'))">
                    Dice: engine roll (+ PA history UI)
                </button>
            </div>

            <div class="diag-group">Tests that touch the server or other players</div>
            <div class="diag-buttons">
                <button type="button" @click="runDiagSync(() => runTrackerSelfTest(api, currentLocalId, true))">Tracker (synced)</button>
                <button type="button" @click="runDiagSync(() => runCustomDataSelfTest(api, currentLocalId, true))">Custom data (synced)</button>
                <button type="button" @click="runDiagSync(() => runRenameTest(api, currentLocalId, data.identity.name))">
                    Rename token to sheet name
                </button>
            </div>

            <div class="diag-buttons">
                <button type="button" @click="copyDiag">Copy</button>
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

    .diag-group {
        font-size: 0.7rem;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: #555;
        margin: 0.4rem 0 0.2rem;
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
