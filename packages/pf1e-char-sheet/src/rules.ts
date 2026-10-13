import type { CompendiumEntry, DataBlock, GameApi } from "@planarally/mod-api";
import { nextTick, ref, watch } from "vue";

import type { PF1Character } from "./data";
import { guessSpellFormula } from "./spells";

// Rules text in PlanarAlly's compendium.
//
// Hero Lab exports the full rules text of every feat, spell and skill with each character, so the same
// "Power Attack" or "Cure Light Wounds" text used to be stored again in every token's sheet. On a server
// with the compendium (mod API 0.2), the text is stored once per campaign instead - in a room DataBlock
// every client loads - and registered as a "PF1e (Hero Lab)" book in PlanarAlly's compendium, where it
// can be browsed, searched and linked from chat and notes. The sheet keeps only the short excerpt and
// looks the full text up by kind and name.
//
// The compendium's `register` only lives in the browser for the session, which is why the text itself
// is kept in the room block: each client registers the block's entries when the game loads, and again
// whenever an import (on any client) adds some.
//
// Feats, spells and skills go there, and a character's specials (class features, racial traits, magic
// item abilities). A monster's or NPC's specials stay on its own DM-only sheet, so its abilities never
// show up in the players' compendium.
//
// A server without the compendium keeps the text on each sheet, as before.

export type RuleKind = "feat" | "spell" | "skill" | "special";

const BLOCK = { category: "room", name: "pf1e-rules" } as const;
const BOOK = "PF1e (Hero Lab)";
const PATHS: Record<RuleKind, string> = { feat: "Feats", spell: "Spells", skill: "Skills", special: "Specials" };

type RuleData = { entries: Record<string, CompendiumEntry> };

let block: DataBlock<RuleData> | undefined;
let unregister: (() => void) | undefined;
let modTag = "pf1e-sheet";
let gameApi: GameApi | undefined;

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

/** True once the rules block is loaded, i.e. rules text lives in the compendium (reactive, for the sheet). */
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

function register(api: GameApi): void {
    unregister?.();
    unregister = undefined;
    const entries = Object.values(block?.data.entries ?? {});
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

/** Loads the campaign's rules block and registers it; call once from initGame. */
export async function initRules(api: GameApi, tag: string | undefined): Promise<void> {
    if (tag) modTag = tag;
    gameApi = api;
    if (!compendiumSupported(api)) return;
    try {
        block = await api.getOrLoadDataBlock<RuleData>(BLOCK, { defaultData: () => ({ entries: {} }) });
    } catch (e) {
        console.warn("[pf1e-sheet] couldn't load the rules block; rules text stays on each sheet", e);
        return;
    }
    if (!block) return;
    rulesReady.value = true;
    register(api);
    // Another client's import saves new entries into the block: register them here too.
    watch(
        () => Object.keys(block?.reactiveData.value.entries ?? {}).length,
        () => register(api),
    );
}

export function disposeRules(): void {
    unregister?.();
    unregister = undefined;
    block = undefined;
    gameApi = undefined;
    rulesReady.value = false;
}

/** One line for the Diagnostics health check. */
export function rulesStatus(api: GameApi): string {
    if (!compendiumSupported(api)) return "this server has no compendium: rules text is kept on each sheet";
    if (!block) return "compendium present but the rules block isn't loaded: rules text is kept on each sheet";
    const entries = Object.values(block.data.entries);
    const count = (kind: RuleKind) => entries.filter((e) => e.kind === kind).length;
    return `compendium "${BOOK}": ${count("feat")} feats, ${count("spell")} spells, ${count("skill")} skills, ${count("special")} specials (${Math.round(JSON.stringify(block.data).length / 1024)} KB)`;
}

/**
 * PlanarAlly's reference to a registered rule: "<mod tag>/<id>", or - should PlanarAlly prefix it
 * differently - whatever reference its entry list gives the entry with this id in this mod's book.
 */
function registeredRef(kind: RuleKind, name: string): string | undefined {
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
    const ref = registeredRef(kind, name);
    const fromCompendium = ref ? compendiumSystem(gameApi)?.getEntry?.(ref)?.body : undefined;
    return fromCompendium ?? block?.reactiveData.value.entries[ruleId(kind, name)]?.body ?? "";
}

/** Whether a rule is in PlanarAlly's compendium (so its page can be opened): registered there, or in this mod's rules block, which is what gets registered. */
export function ruleRegistered(kind: RuleKind, name: string): boolean {
    return (
        registeredRef(kind, name) !== undefined || block?.reactiveData.value.entries[ruleId(kind, name)] !== undefined
    );
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
 * On import: moves the full rules text of the character's feats, spells and skills into the campaign's
 * rules block (adding what isn't there yet) and strips it from the character, keeping the excerpts.
 * Each spell's dice formula is guessed first, while its full text is still at hand. Returns how many
 * entries were added; does nothing (and keeps the text on the sheet) without the compendium.
 * `withSpecials` moves the specials' text too - for characters, not for a monster's DM-only sheet.
 */
export function moveRulesToCompendium(api: GameApi, character: PF1Character, withSpecials: boolean): number {
    for (const sc of character.spellcasting) {
        for (const spell of sc.spells) {
            spell.guess = guessSpellFormula(spell.fullText || spell.description, sc.casterLevel);
        }
    }
    if (!block) return 0;

    const entries = { ...block.data.entries };
    let added = 0;
    let changed = false;
    const put = (kind: RuleKind, name: string, body: string, group?: Record<string, string>): void => {
        if (!name || !body) return;
        const id = ruleId(kind, name);
        if (entries[id]?.body === body) return;
        if (!entries[id]) added++;
        changed = true;
        entries[id] = { id, name, kind, path: [PATHS[kind]], body, ...(group ? { group } : {}) };
    };

    for (const feat of character.feats) {
        put("feat", feat.name, feat.fullText, feat.category ? { category: feat.category } : undefined);
        feat.fullText = "";
    }
    for (const sc of character.spellcasting) {
        for (const spell of sc.spells) {
            put("spell", spell.name, spell.fullText, spell.school ? { school: spell.school } : undefined);
            spell.fullText = "";
        }
    }
    for (const skill of character.skills) {
        put("skill", skill.name, skill.description ?? "");
        delete skill.description;
    }
    if (withSpecials) {
        for (const sp of character.specials ?? []) {
            const group: Record<string, string> = {};
            if (sp.category) group["category"] = sp.category;
            if (sp.source) group["source"] = sp.source;
            put("special", sp.name, sp.fullText, Object.keys(group).length ? group : undefined);
            sp.fullText = "";
        }
    }

    if (changed) {
        block.updateData({ entries });
        block.sync();
        register(api);
    }
    return added;
}
