import type { LocalId } from "@planarally/mod-api";
import { inject, type ComputedRef, type InjectionKey, type Ref } from "vue";

import type { PF1Character, SheetResource } from "../data";

import type { RuleCards } from "./ruleCards";

// What CharSheet.vue shares with the tab components in this folder (Vue's provide / inject): the
// character, the shape it belongs to, and the few actions several tabs need.

export interface SheetContext {
    /** The stored character: edits go here (then `save`). */
    data: Readonly<Ref<PF1Character>>;
    /** The character with its enabled adjustments applied: what the sheet shows and rolls. */
    view: ComputedRef<PF1Character>;
    /** The token whose sheet this is. */
    currentLocalId: Ref<LocalId | undefined>;
    /** A character (full sheet) rather than a monster or NPC (the DM-only limited sheet). */
    isCharacter: ComputedRef<boolean>;
    isDm: ComputedRef<boolean>;
    save: () => void;
    /** The status line the macro, adjustment and Config choices share. */
    macroStatus: Ref<string>;
    flashMacroStatus: (text: string) => void;
    /** Saves a change and re-exports Custom Data, so the numbers, rolls and dice macros follow. */
    saveAndReexport: (message: string) => void;
    /** Sets a resource's uses left, saves, and updates its tracker on the token. */
    setUsesLeft: (r: SheetResource, value: number) => void;
    cards: RuleCards;
}

export const SHEET_CONTEXT: InjectionKey<SheetContext> = Symbol("pf1e-sheet");

/** The sheet's context, in a component inside CharSheet.vue. */
export function useSheet(): SheetContext {
    const context = inject(SHEET_CONTEXT);
    if (!context) throw new Error("[pf1e-sheet] a sheet tab was used outside CharSheet.vue");
    return context;
}
