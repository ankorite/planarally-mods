import type { CompendiumEntry, CompendiumRecord, DataBlock, GameApi } from "@planarally/mod-api";
import { nextTick, ref, toRaw, watch } from "vue";

import type { PF1Character } from "./data";
import { guessSpellFormula } from "./spells";

// Rules text in PlanarAlly's compendium.
//
// Hero Lab exports the full rules text of every feat, spell and skill with each character, so the same
// "Power Attack" or "Cure Light Wounds" text used to be stored again in every token's sheet. On a server
// with the compendium (mod API 0.2), the text is stored once per campaign instead - in room DataBlocks
// every client loads - and registered as a "PF1e (Hero Lab)" book in PlanarAlly's compendium, where it
// can be browsed, searched and linked from chat and notes. The sheet keeps only the short excerpt and
// looks the full text up by kind and name.
//
// The compendium's `register` only lives in the browser for the session, which is why the text itself
// is kept in the room blocks: each client registers their entries when the game loads, and again
// whenever an import (on any client) adds some.
//
// Feats, spells and skills go there, and a character's specials (class features, racial traits, magic
// item abilities). A monster's or NPC's specials stay on its own DM-only sheet, so its abilities never
// show up in the players' compendium.
//
// A special's name carries what changes as the character levels ("Trap Sense +2 (Ex)", "Smite Evil
// (2/day)"), so it is stored under the name without those parts ("Trap Sense"), and the sheet remembers
// that name (SpecialEntry.rule): a level-up finds the same entry instead of adding another. Two
// different texts under one such name (an investigator's Mutagen discovery and Mutagen ability) get the
// source added ("Mutagen (Investigator)"), else the full name. Entries stored under full names before
// 1.1 stay readable, but one whose text is also under its short name isn't listed in the compendium.
//
// A server without the compendium keeps the text on each sheet, as before.

export type RuleKind = "feat" | "spell" | "skill" | "special";

const BOOK = "PF1e (Hero Lab)";
const PATHS: Record<RuleKind, string> = { feat: "Feats", spell: "Spells", skill: "Skills", special: "Specials" };

// How the text is stored.
//
// A DataBlock is saved whole, and PlanarAlly only sends a save to the clients in the saver's map
// location, so one block for the whole campaign could be overwritten by a client holding an older copy
// (a player on another map, or two imports at once) - losing rules whose text had already been taken off
// their sheets. So:
//   * the rules are spread over SHARDS room blocks by a hash of their id, so a write only touches the
//     few rules in one shard and two writes rarely meet;
//   * text is only taken off a sheet once that rule is CONFIRMED on the server: it was in a block when
//     the block was loaded from the server, or arrived in another client's save. A rule this client has
//     just written stays on the sheet too until then (usually the next session), and an entry that did
//     get lost is written again from the sheet that still has its text.
// "pf1e-rules", the single block used before 1.0, is still read (never written), so its rules keep
// working; the same rule in a shard wins.
const SHARDS = 32;
const LEGACY_BLOCK = { category: "room", name: "pf1e-rules" } as const;
const shardRepr = (i: number) => ({ category: "room", name: `pf1e-rules-${String(i).padStart(2, "0")}` }) as const;

/**
 * A rule as stored in the room blocks. This is the sheet's own format (the compendium entry of mod API
 * 0.4, kind included), kept as it is so blocks written by any version stay readable; `register` turns it
 * into a compendium entry.
 */
interface StoredRule {
    id: string;
    name: string;
    kind: RuleKind;
    path?: string[];
    group?: Record<string, string>;
    body: string;
}

type RuleData = { entries: Record<string, StoredRule> };

/**
 * The compendium schema's system (mod API 0.6): with the rule's kind it says what an entry is, so other
 * mods can find PF1e feats or spells with `compendium.getEntries("pf1e", "feat")`.
 */
const SYSTEM = "pf1e";

let shards: DataBlock<RuleData>[] = [];
let legacy: DataBlock<RuleData> | undefined;
/** id -> rules text known to be on the server (see above). */
const confirmed = new Map<string, string>();
/** The data object each shard was last given by this client, to tell our writes from other clients'. */
const ownWrites = new Map<number, RuleData>();
const stopWatches: (() => void)[] = [];
let unregister: (() => void) | undefined;
let registerTimer: ReturnType<typeof setTimeout> | undefined;
let modTag = "pf1e-sheet";
let gameApi: GameApi | undefined;

/** The shard a rule id lives in: a small FNV-1a hash, stable across clients and versions. */
export function shardOf(id: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % SHARDS;
}

function confirmAll(data: RuleData | undefined): void {
    for (const [id, entry] of Object.entries(data?.entries ?? {})) confirmed.set(id, entry.body);
}

/** PlanarAlly's compendium system (runtime only; the mod API types just `register`). */
interface CompendiumSystem {
    getEntry?: (ref: string) => { body?: string } | undefined;
    listEntries?: () => { id: string; mod: string; book: string; ref: string; body?: string }[];
    openRuleAt?: (ref: string, x: number, y: number) => void;
    toggle?: () => void;
}

/**
 * PlanarAlly's compendium system: from the mod API's systems, else from the `systems` PlanarAlly puts on
 * `window` (the same registry). Some PlanarAlly versions don't hand it to mods; then this is undefined
 * and the sheet works the panel through the page instead.
 */
function compendiumSystem(api: GameApi | undefined): CompendiumSystem | undefined {
    const fromApi = (api?.systems as unknown as Record<string, unknown> | undefined)?.["compendium"];
    const fromWindow = (window as unknown as { systems?: Record<string, unknown> }).systems?.["compendium"];
    return (fromApi ?? fromWindow) as CompendiumSystem | undefined;
}

/** True once the rules blocks are loaded, i.e. rules text lives in the compendium (reactive, for the sheet). */
export const rulesReady = ref(false);

/** Whether this server's mod API has the compendium. */
export function compendiumSupported(api: GameApi): boolean {
    return typeof (api as Partial<GameApi>).compendium?.register === "function";
}

/** The compendium id of a rule: "feat-power-attack" (no slashes or spaces, as PlanarAlly requires). */
export function ruleId(kind: RuleKind, name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `${kind}-${slug || "unnamed"}`;
}

/**
 * A special's name without what changes with level: parenthesised parts and a trailing number, bonus or
 * dice. "Trap Sense +2 (Ex)" -> "Trap Sense", "Studied Strike +2d6 (Ex)" -> "Studied Strike",
 * "Mythic Power (5/day, Surge +1d6)" -> "Mythic Power", "Cape of free will +2/+3" -> "Cape of free will".
 */
export function specialRuleName(name: string): string {
    const short = name
        .replace(/\s*\([^)]*\)/g, "")
        .replace(/\s+[+-]?\d+(?:d\d+)?(?:\/[+-]?\d+)*\s*$/i, "")
        .trim();
    return short || name.trim();
}

/** This client's copy of a rule: from its shard, else from the pre-1.0 block. Reactive. */
function localEntry(id: string): StoredRule | undefined {
    return shards[shardOf(id)]?.reactiveData.value.entries[id] ?? legacy?.reactiveData.value.entries[id] ?? undefined;
}

/** Every rule this client has: the pre-1.0 block's, overridden by the shards'. */
function allEntries(): StoredRule[] {
    const byId = new Map<string, StoredRule>();
    for (const e of Object.values(legacy?.data.entries ?? {})) byId.set(e.id, e);
    for (const shard of shards) for (const e of Object.values(shard.data.entries)) byId.set(e.id, e);
    return [...byId.values()];
}

/**
 * The entries to list in the compendium: all of them, except a special stored under its full name before
 * 1.1 when the same text is also stored under a shorter name (the one the sheets use now).
 */
export function listedEntries(entries: StoredRule[]): StoredRule[] {
    const shortest = new Map<string, StoredRule>();
    for (const e of entries) {
        if (e.kind !== "special") continue;
        const key = `${specialRuleName(e.name)}\u0000${e.body}`;
        const seen = shortest.get(key);
        if (!seen || e.name.length < seen.name.length) shortest.set(key, e);
    }
    return entries.filter(
        (e) => e.kind !== "special" || shortest.get(`${specialRuleName(e.name)}\u0000${e.body}`) === e,
    );
}

/**
 * A stored rule as a compendium entry: with mod API 0.6's schema, and still with the `kind` that servers
 * from before it (mod API 0.4 / 0.5) read.
 */
function toCompendiumEntry(rule: StoredRule): CompendiumEntry {
    const { kind, ...rest } = rule;
    return { ...rest, schema: { system: SYSTEM, kind }, ...({ kind } as object) };
}

function register(api: GameApi): void {
    unregister?.();
    unregister = undefined;
    const entries = listedEntries(allEntries()).map(toCompendiumEntry);
    if (!entries.length) return;
    unregister = api.compendium.register(entries, {
        name: BOOK,
        views: [
            { at: ["Spells"], name: "School", by: "school" },
            { at: ["Feats"], name: "Category", by: "category" },
            { at: ["Specials"], name: "Category", by: "category" },
            { at: ["Specials"], name: "Source", by: "source" },
        ],
    });
}

/** Re-registers once after a burst of changes (an import can touch several shards). */
function registerSoon(api: GameApi): void {
    clearTimeout(registerTimer);
    registerTimer = setTimeout(() => register(api), 50);
}

/** Loads the campaign's rules blocks and registers them; call once from initGame. */
export async function initRules(api: GameApi, tag: string | undefined): Promise<void> {
    if (tag) modTag = tag;
    gameApi = api;
    if (!compendiumSupported(api)) return;
    try {
        const loaded = await Promise.all(
            Array.from({ length: SHARDS }, (_, i) =>
                api.getOrLoadDataBlock<RuleData>(shardRepr(i), { defaultData: () => ({ entries: {} }) }),
            ),
        );
        if (loaded.some((b) => !b)) throw new Error("a rules block didn't load");
        shards = loaded as DataBlock<RuleData>[];
        // Without defaultData, a missing block is simply undefined (and isn't created).
        legacy = (await api.getOrLoadDataBlock<RuleData>(LEGACY_BLOCK)) ?? undefined;
    } catch (e) {
        console.warn("[pf1e-sheet] couldn't load the rules blocks; rules text stays on each sheet", e);
        shards = [];
        return;
    }
    // What came from the server is confirmed; blocks created here (not on the server yet) are empty.
    shards.forEach((shard) => {
        if (shard.existsOnServer) confirmAll(shard.data);
    });
    confirmAll(legacy?.data);
    rulesReady.value = true;
    register(api);
    // Another client's save replaces a shard's data object (PlanarAlly's DataBlock.Saved / Created):
    // confirm and register what it brought. This client's own writes are recognised and skipped.
    shards.forEach((shard, i) => {
        stopWatches.push(
            watch(
                () => shard.reactiveData.value,
                (data) => {
                    // The watcher sees Vue's reactive proxy of the data; compare the object underneath.
                    if (toRaw(data) !== ownWrites.get(i)) confirmAll(data);
                    registerSoon(api);
                },
            ),
        );
    });
}

export function disposeRules(): void {
    for (const stop of stopWatches.splice(0)) stop();
    clearTimeout(registerTimer);
    unregister?.();
    unregister = undefined;
    shards = [];
    legacy = undefined;
    confirmed.clear();
    ownWrites.clear();
    gameApi = undefined;
    rulesReady.value = false;
}

/** One line for the Diagnostics health check. */
export function rulesStatus(api: GameApi): string {
    if (!compendiumSupported(api)) return "this server has no compendium: rules text is kept on each sheet";
    if (!shards.length)
        return "compendium present but the rules blocks aren't loaded: rules text is kept on each sheet";
    const entries = allEntries();
    const count = (kind: RuleKind) => entries.filter((e) => e.kind === kind).length;
    const size =
        shards.reduce((n, b) => n + JSON.stringify(b.data).length, 0) + JSON.stringify(legacy?.data ?? {}).length;
    const unconfirmed = entries.filter((e) => confirmed.get(e.id) !== e.body).length;
    return (
        `compendium "${BOOK}": ${count("feat")} feats, ${count("spell")} spells, ${count("skill")} skills, ` +
        `${count("special")} specials (${Math.round(size / 1024)} KB in ${SHARDS} blocks${legacy ? " + the pre-1.0 block" : ""}); ` +
        `${unconfirmed} not confirmed on the server yet (their text stays on the sheets until then)`
    );
}

/**
 * The rule as PlanarAlly's compendium has it registered, through mod API 0.6's `getEntries`. Undefined on
 * an older server (then the compendium system is asked directly, if PlanarAlly hands it to mods).
 */
function registeredRecord(kind: RuleKind, name: string): CompendiumRecord | undefined {
    const getEntries = (gameApi?.compendium as Partial<GameApi["compendium"]> | undefined)?.getEntries;
    if (typeof getEntries !== "function") return undefined;
    const id = ruleId(kind, name);
    try {
        return getEntries.call(gameApi!.compendium, SYSTEM, kind).find((e) => e.id === id && e.mod === modTag);
    } catch {
        return undefined;
    }
}

/**
 * PlanarAlly's reference to a registered rule: "<mod tag>/<id>", or - should PlanarAlly prefix it
 * differently - whatever reference its entry list gives the entry with this id in this mod's book.
 */
function registeredRef(kind: RuleKind, name: string): string | undefined {
    const record = registeredRecord(kind, name);
    if (record) return record.ref;
    const compendium = compendiumSystem(gameApi);
    const direct = ruleRef(kind, name);
    if (compendium?.getEntry?.(direct)) return direct;
    const id = ruleId(kind, name);
    return compendium?.listEntries?.().find((e) => e.id === id && (e.mod === modTag || e.book === BOOK))?.ref;
}

/**
 * The full rules text of a feat, spell or skill, read from PlanarAlly's compendium (the entry this mod
 * registered); falls back to the campaign's rules block that feeds it, which is the same text.
 */
export function ruleText(kind: RuleKind, name: string): string {
    const record = registeredRecord(kind, name);
    if (record) return record.body;
    const ref = registeredRef(kind, name);
    const fromCompendium = ref ? compendiumSystem(gameApi)?.getEntry?.(ref)?.body : undefined;
    return fromCompendium ?? localEntry(ruleId(kind, name))?.body ?? "";
}

/** Whether a rule is in PlanarAlly's compendium (so its page can be opened): registered there, or in this mod's rules block, which is what gets registered. */
export function ruleRegistered(kind: RuleKind, name: string): boolean {
    return registeredRef(kind, name) !== undefined || localEntry(ruleId(kind, name)) !== undefined;
}

/** PlanarAlly's reference to a rule, for its rule popover and for chat links: "pf1e-sheet/feat-power-attack". */
export function ruleRef(kind: RuleKind, name: string): string {
    return `${modTag}/${ruleId(kind, name)}`;
}

/**
 * Opens a rule's page in PlanarAlly's compendium panel.
 *
 * The panel keeps its selected entry to itself and the mod API can't navigate it, so this works the page
 * the way you would by hand: opens the panel (with the compendium system's toggle when PlanarAlly hands
 * it to mods, else with the menu's Compendium button), types the rule's name into its search box and
 * clicks the "PF1e (Hero Lab)" result, then brings the panel to the front. If that fails and the
 * compendium system is available, PlanarAlly's rule popover is shown at the mouse instead. Returns
 * ok: false with the reason (also logged to the console) when it can't do either.
 */
export async function openRule(
    api: GameApi,
    kind: RuleKind,
    name: string,
    event: MouseEvent,
): Promise<{ ok: boolean; reason: string }> {
    const fail = (reason: string): { ok: boolean; reason: string } => {
        console.info(`[pf1e-sheet] compendium: ${reason}`);
        return { ok: false, reason };
    };
    if (!ruleRegistered(kind, name)) {
        return fail(`"${name}" isn't in the compendium yet - re-import the character (or open its sheet) to add it`);
    }
    const compendium = compendiumSystem(api);
    const { clientX, clientY } = event;

    try {
        if (!panelVisible()) {
            if (compendium?.toggle) compendium.toggle();
            else {
                const menu = compendiumMenuButton();
                if (!menu) {
                    const systems = Object.keys((api.systems as unknown as Record<string, unknown>) ?? {}).join(", ");
                    return fail(
                        `couldn't find the Compendium menu button to open the panel (mod API systems: ${systems})`,
                    );
                }
                menu.click();
            }
        }
        const panel = await waitFor(() => (panelVisible() ? document.querySelector<HTMLElement>("#compendium") : null));
        const search = panel?.querySelector<HTMLInputElement>("input[type=search], input");
        if (!panel || !search) return fail("the compendium panel didn't open");
        search.value = name;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        const hit = await waitFor(() =>
            Array.from(panel.querySelectorAll<HTMLButtonElement>("#compendium-list button, button")).find(
                (b) =>
                    b.querySelector("span")?.textContent?.trim() === name &&
                    (b.querySelector("small")?.textContent ?? "").includes(BOOK),
            ),
        );
        if (hit) {
            hit.click();
            panel.click(); // the panel's own click handler brings it in front of other dialogs
            return { ok: true, reason: "" };
        }
        console.info(`[pf1e-sheet] compendium: no "${BOOK}" search result for "${name}"`);
    } catch (e) {
        console.warn("[pf1e-sheet] couldn't open the compendium page", e);
    }
    const ref = registeredRef(kind, name) ?? ruleRef(kind, name);
    if (compendium?.openRuleAt) {
        compendium.openRuleAt(ref, clientX, clientY);
        return { ok: true, reason: "" };
    }
    return fail(`couldn't find "${name}" in the compendium panel`);
}

/** Whether PlanarAlly's compendium panel is on screen (it is always in the page, hidden with v-show). */
function panelVisible(): boolean {
    const container = document.querySelector<HTMLElement>("#compendium-container");
    return container !== null && getComputedStyle(container).display !== "none";
}

/** The game menu's Compendium button (only shown when some mod registered a compendium). */
function compendiumMenuButton(): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>("button, .menu-accordion, [role=button]")).find(
        (el) => el.textContent?.trim().toLowerCase() === "compendium" && !el.closest("#pf1e-sheet"),
    );
}

/** Polls `get` for up to ~1.5 s (Vue renders the panel after the next tick or two). */
async function waitFor<T>(get: () => T | null | undefined): Promise<T | undefined> {
    for (let i = 0; i < 30; i++) {
        await nextTick();
        const value = get();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
}

/**
 * On import, and when an older sheet is opened: copies the full rules text of the character's feats,
 * spells and skills (and, with `withSpecials`, specials - for characters, not a monster's DM-only sheet)
 * into the campaign's rules blocks, adding or updating what they lack, and takes the text off the
 * character only for rules already confirmed on the server (see the top of this file); the excerpts
 * stay. Each spell's dice formula is guessed first, while its full text is still at hand. Returns how
 * many rules were added and how many texts were taken off; does nothing without the compendium.
 */
export function moveRulesToCompendium(
    api: GameApi,
    character: PF1Character,
    withSpecials: boolean,
): { added: number; stripped: number } {
    for (const sc of character.spellcasting) {
        for (const spell of sc.spells) {
            spell.guess ??= guessSpellFormula(spell.fullText || spell.description, sc.casterLevel);
        }
    }
    if (!shards.length) return { added: 0, stripped: 0 };

    const pending = new Map<number, Record<string, StoredRule>>();
    let added = 0;
    let stripped = 0;
    /** Stores the rule if needed; returns whether its text may come off the sheet. */
    const put = (kind: RuleKind, name: string, body: string, group?: Record<string, string>): boolean => {
        if (!name || !body) return false;
        const id = ruleId(kind, name);
        const i = shardOf(id);
        const current = pending.get(i)?.[id] ?? localEntry(id);
        if (current?.body !== body) {
            const entries = pending.get(i) ?? { ...shards[i]!.data.entries };
            if (!current) added++;
            entries[id] = { id, name, kind, path: [PATHS[kind]], body, ...(group ? { group } : {}) };
            pending.set(i, entries);
        }
        if (confirmed.get(id) !== body) return false;
        stripped++;
        return true;
    };

    for (const feat of character.feats) {
        if (put("feat", feat.name, feat.fullText, feat.category ? { category: feat.category } : undefined)) {
            feat.fullText = "";
        }
    }
    for (const sc of character.spellcasting) {
        for (const spell of sc.spells) {
            if (put("spell", spell.name, spell.fullText, spell.school ? { school: spell.school } : undefined)) {
                spell.fullText = "";
            }
        }
    }
    for (const skill of character.skills) {
        if (put("skill", skill.name, skill.description ?? "")) delete skill.description;
    }
    if (withSpecials) {
        const current = (name: string): StoredRule | undefined => {
            const id = ruleId("special", name);
            return pending.get(shardOf(id))?.[id] ?? localEntry(id);
        };
        for (const sp of character.specials ?? []) {
            // The text: on the sheet, else (a sheet from before 1.1, its text already moved) in the entry
            // it was stored under.
            const body = sp.fullText || (sp.rule ? current(sp.rule)?.body : undefined) || current(sp.name)?.body || "";
            if (!body) continue;
            // The name to keep it under: the one this sheet already uses, the short name, the short name
            // with its source, or the full name - the first that is free or already holds this text.
            const short = specialRuleName(sp.name);
            const names = [sp.rule, short, sp.source ? `${short} (${sp.source})` : undefined].filter(
                (n): n is string => !!n,
            );
            const name =
                names.find((n) => {
                    const e = current(n);
                    return !e || e.body === body;
                }) ?? sp.name;
            const group: Record<string, string> = {};
            if (sp.category) group["category"] = sp.category;
            if (sp.source) group["source"] = sp.source;
            const onSheet = sp.fullText !== "";
            if (put("special", name, body, Object.keys(group).length ? group : undefined)) {
                if (onSheet) sp.fullText = "";
                else stripped--; // its text was already off this sheet
            }
            if (name === sp.name) delete sp.rule;
            else sp.rule = name;
        }
    }

    for (const [i, entries] of pending) {
        const data = { entries };
        ownWrites.set(i, data);
        shards[i]!.updateData(data);
        shards[i]!.sync();
    }
    if (pending.size) registerSoon(api);
    return { added, stripped };
}
