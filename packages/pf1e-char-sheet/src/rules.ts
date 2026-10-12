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
// Only feats, spells and skills go there: general rules, the same for everyone. A creature's special
// abilities stay on its own sheet, so a monster's abilities never show up in the players' compendium.
//
// A server without the compendium keeps the text on each sheet, as before.

export type RuleKind = "feat" | "spell" | "skill";

const BLOCK = { category: "room", name: "pf1e-rules" } as const;
const BOOK = "PF1e (Hero Lab)";
const PATHS: Record<RuleKind, string> = { feat: "Feats", spell: "Spells", skill: "Skills" };

type RuleData = { entries: Record<string, CompendiumEntry> };

let block: DataBlock<RuleData> | undefined;
let unregister: (() => void) | undefined;
let modTag = "pf1e-sheet";
let gameApi: GameApi | undefined;

/** PlanarAlly's compendium system (runtime only; the mod API types just `register`). */
interface CompendiumSystem {
    getEntry?: (ref: string) => { body?: string } | undefined;
    openRuleAt?: (ref: string, x: number, y: number) => void;
    toggle?: () => void;
}

function compendiumSystem(api: GameApi | undefined): CompendiumSystem | undefined {
    return (api?.systems as unknown as Record<string, unknown> | undefined)?.["compendium"] as
        | CompendiumSystem
        | undefined;
}

function compendiumOpen(api: GameApi): boolean {
    const state = (api.systemsState as unknown as Record<string, unknown>)["compendium"] as
        | { reactive?: { open?: boolean } }
        | undefined;
    return state?.reactive?.open === true;
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
    return `compendium "${BOOK}": ${count("feat")} feats, ${count("spell")} spells, ${count("skill")} skills (${Math.round(JSON.stringify(block.data).length / 1024)} KB)`;
}

/**
 * The full rules text of a feat, spell or skill, read from PlanarAlly's compendium (the entry this mod
 * registered); falls back to the campaign's rules block that feeds it, which is the same text.
 */
export function ruleText(kind: RuleKind, name: string): string {
    const fromCompendium = compendiumSystem(gameApi)?.getEntry?.(ruleRef(kind, name))?.body;
    return fromCompendium ?? block?.reactiveData.value.entries[ruleId(kind, name)]?.body ?? "";
}

/** Whether a rule is registered in PlanarAlly's compendium (so its page can be opened). */
export function ruleRegistered(kind: RuleKind, name: string): boolean {
    return compendiumSystem(gameApi)?.getEntry?.(ruleRef(kind, name)) !== undefined;
}

/** PlanarAlly's reference to a rule, for its rule popover and for chat links: "pf1e-sheet/feat-power-attack". */
export function ruleRef(kind: RuleKind, name: string): string {
    return `${modTag}/${ruleId(kind, name)}`;
}

/**
 * Opens a rule's page in PlanarAlly's compendium panel.
 *
 * The panel keeps its selected entry to itself and the mod API can't navigate it, so this opens the
 * panel, types the rule's name into its search box and picks the "PF1e (Hero Lab)" result - what you
 * would do by hand - then brings the panel to the front. If that doesn't work (a PlanarAlly version
 * with a different panel), it shows PlanarAlly's rule popover at the mouse instead. Returns false when
 * the rule isn't in the compendium at all.
 */
export async function openRule(api: GameApi, kind: RuleKind, name: string, event: MouseEvent): Promise<boolean> {
    const compendium = compendiumSystem(api);
    const ref = ruleRef(kind, name);
    if (!compendium?.getEntry) {
        console.info("[pf1e-sheet] compendium: this PlanarAlly has no compendium system to open");
        return false;
    }
    if (!compendium.getEntry(ref)) {
        console.info(`[pf1e-sheet] compendium: ${ref} isn't registered - re-import the character to add it`);
        return false;
    }
    const { clientX, clientY } = event;

    try {
        if (!compendiumOpen(api)) compendium.toggle?.();
        await nextTick();
        const panel = document.querySelector<HTMLElement>("#compendium");
        const search = panel?.querySelector<HTMLInputElement>("input[type=search]");
        if (panel && search) {
            search.value = name;
            search.dispatchEvent(new Event("input", { bubbles: true }));
            await nextTick();
            const hit = Array.from(panel.querySelectorAll<HTMLButtonElement>("#compendium-list button")).find(
                (b) =>
                    b.querySelector("span")?.textContent?.trim() === name &&
                    (b.querySelector("small")?.textContent ?? "").includes(BOOK),
            );
            if (hit) {
                hit.click();
                panel.click(); // the panel's own click handler brings it in front of other dialogs
                return true;
            }
            console.info(`[pf1e-sheet] compendium: no search result for "${name}"; showing the popover instead`);
        } else {
            console.info("[pf1e-sheet] compendium: panel not found; showing the popover instead");
        }
    } catch (e) {
        console.warn("[pf1e-sheet] couldn't open the compendium page", e);
    }
    compendium.openRuleAt?.(ref, clientX, clientY);
    return true;
}

/**
 * On import: moves the full rules text of the character's feats, spells and skills into the campaign's
 * rules block (adding what isn't there yet) and strips it from the character, keeping the excerpts.
 * Each spell's dice formula is guessed first, while its full text is still at hand. Returns how many
 * entries were added; does nothing (and keeps the text on the sheet) without the compendium.
 */
export function moveRulesToCompendium(api: GameApi, character: PF1Character): number {
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

    if (changed) {
        block.updateData({ entries });
        block.sync();
        register(api);
    }
    return added;
}
