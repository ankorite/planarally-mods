import type { CompendiumEntry, DataBlock, GameApi } from "@planarally/mod-api";
import { ref, watch } from "vue";

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

/** Whether rules text goes to the compendium (the block is loaded) rather than onto each sheet. */
export function rulesInCompendium(): boolean {
    return block !== undefined;
}

/** The full rules text of a feat, spell or skill from the campaign's rules block, if it is there. */
export function ruleText(kind: RuleKind, name: string): string {
    return block?.reactiveData.value.entries[ruleId(kind, name)]?.body ?? "";
}

/** PlanarAlly's reference to a rule, for its rule popover and for chat links: "pf1e-sheet/feat-power-attack". */
export function ruleRef(kind: RuleKind, name: string): string {
    return `${modTag}/${ruleId(kind, name)}`;
}

/**
 * Opens PlanarAlly's own rule popover for a rule at the mouse position. Returns false when this server
 * can't (no compendium system, or the rule isn't registered), so the caller can do nothing instead.
 */
export function openRule(api: GameApi, kind: RuleKind, name: string, event: MouseEvent): boolean {
    const compendium = (api.systems as unknown as Record<string, unknown>)["compendium"] as
        | { openRuleAt?: (ref: string, x: number, y: number) => void; getEntry?: (ref: string) => unknown }
        | undefined;
    const ref = ruleRef(kind, name);
    if (typeof compendium?.openRuleAt !== "function" || !compendium.getEntry?.(ref)) return false;
    compendium.openRuleAt(ref, event.clientX, event.clientY);
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
