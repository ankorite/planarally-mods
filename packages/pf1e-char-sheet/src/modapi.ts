import type { GameApi, LocalId } from "@planarally/mod-api";

import { isCharacterShape, isDm } from "./access";
import { applyAdjustments } from "./adjustments";
import { buildSheet, type SheetNames } from "./customdata";
import { DATA_BLOCK_NAME, type PF1Character } from "./data";
import { ruleText, type RuleKind } from "./rules";

// What other mods can read from the sheet, through PlanarAlly's `provideApi` / `getModApi` (PlanarAlly's
// dev branch, Nov 2026, after mod API 0.6). Another mod gets it with
//
//     const pf1e = api.getModApi<Pf1eSheetApi>("pf1e-sheet");
//
// (reactive: undefined while this mod isn't loaded). It only reads: nothing here changes a sheet. A
// monster's or NPC's sheet is only given to the DM, as on the sheet itself, and the server's DataBlock
// access levels apply on top of that.

export interface Pf1eSheetApi {
    /** This interface's version; it goes up when a change could break a mod that uses it. */
    readonly apiVersion: 1;
    /** The installed version of the sheet mod, e.g. "1.1.0". */
    readonly modVersion: string | undefined;
    /**
     * The token's character as the sheet shows it: the Hero Lab import with its enabled adjustments (buffs,
     * conditions) applied, or with `{ adjusted: false }` as stored. A copy, so changing it changes nothing.
     * Undefined when the token has no imported sheet, or this user may not read it.
     */
    getCharacter(shape: LocalId, options?: { adjusted?: boolean }): Promise<PF1Character | undefined>;
    /**
     * The token's Custom Data field names, as the sheet exports them, for rolls in PlanarAlly's dice syntax:
     * `1d20 + {${names.skills[i]}}`, `1d20 + {${names.will}}`. Undefined like `getCharacter`.
     */
    getRollFields(shape: LocalId): Promise<SheetNames | undefined>;
    /** The full rules text of a feat, spell, skill or special in the campaign's "PF1e (Hero Lab)" compendium. */
    ruleText(kind: RuleKind, name: string): string;
}

/** The token's stored sheet, if it has an imported one this user may read. */
async function storedSheet(api: GameApi, shape: LocalId): Promise<PF1Character | undefined> {
    // A monster's or NPC's sheet is the DM's, whatever the server would allow.
    if (!isCharacterShape(api, shape) && !isDm(api)) return undefined;
    const shapeId = api.getGlobalId(shape);
    if (!shapeId) return undefined;
    const repr = { category: "shape", shape: shapeId, name: DATA_BLOCK_NAME } as const;
    let block = api.getDataBlock<PF1Character>(repr);
    if (!block) {
        try {
            block = await api.loadDataBlock<PF1Character>(repr);
        } catch {
            // Loaded meanwhile by someone else in this browser (two loads at once throw).
            block = api.getDataBlock<PF1Character>(repr);
        }
    }
    const data = block?.data;
    return data?.importedAt ? data : undefined;
}

export function createSheetApi(api: GameApi, modVersion: string | undefined): Pf1eSheetApi {
    return {
        apiVersion: 1,
        modVersion,
        async getCharacter(shape, options) {
            const stored = await storedSheet(api, shape);
            if (!stored) return undefined;
            const shown = options?.adjusted === false ? stored : applyAdjustments(stored);
            return JSON.parse(JSON.stringify(shown)) as PF1Character;
        },
        async getRollFields(shape) {
            const stored = await storedSheet(api, shape);
            return stored ? (JSON.parse(JSON.stringify(buildSheet(stored).names)) as SheetNames) : undefined;
        },
        ruleText,
    };
}

/**
 * Offers the API to other mods, on a PlanarAlly that has `provideApi`; returns how to take it back
 * (PlanarAlly also removes it when the mod unloads).
 */
export function provideSheetApi(api: GameApi, modVersion: string | undefined): (() => void) | undefined {
    const provide = (api as unknown as { provideApi?: (provided: object) => () => void }).provideApi;
    if (typeof provide !== "function") return undefined;
    try {
        return provide.call(api, createSheetApi(api, modVersion));
    } catch (e) {
        console.warn("[pf1e-sheet] couldn't offer the sheet's API to other mods", e);
        return undefined;
    }
}
