import type { GameApi } from "@planarally/mod-api";

/**
 * Whether the viewer is the DM. A DM who has switched to "fake player" (to preview what players see)
 * counts as a player. `isDm` / `isFakePlayer` live on PlanarAlly's game state but aren't in the
 * published types yet. Reads reactive state, so it can be used inside a Vue `computed`.
 */
export function isDm(api: GameApi): boolean {
    const game = (api.systemsState as unknown as { game?: { reactive?: { isDm?: boolean; isFakePlayer?: boolean } } })
        .game;
    return game?.reactive?.isDm === true && game.reactive.isFakePlayer !== true;
}

/** Whether a shape is a PlanarAlly character (gets the full sheet) rather than a monster/NPC token. */
export function isCharacterShape(api: GameApi, shape: Parameters<GameApi["getShape"]>[0]): boolean {
    try {
        return api.getShape(shape)?.character !== undefined;
    } catch {
        return false;
    }
}

// ---- who may read and write a token's sheet ------------------------------------------------------
//
// PlanarAlly's dev branch (Nov 2026, after mod API 0.6) gives DataBlocks access levels: "dm", "owner"
// (users with edit access to the token) or "room". A shape DataBlock defaults to "owner" for both, which
// suits a character's sheet. A monster's or NPC's sheet is the DM's: until now only its tab was hidden
// from players, so a player with edit access to the token could still read its stat block. With access
// levels the DM's client makes those sheets "dm" for both, and a token that has since become a character
// "owner" again. The published mod API types don't have access levels yet, so they're described here,
// and a server without them is left alone.

export type SheetAccessLevel = "dm" | "owner" | "room";

export interface SheetAccess {
    read: SheetAccessLevel;
    write: SheetAccessLevel;
}

/** The access a token's sheet should have: its owners' for a character, the DM's for anything else. */
export function sheetAccess(character: boolean): SheetAccess {
    return character ? { read: "owner", write: "owner" } : { read: "dm", write: "dm" };
}

interface AccessibleBlock {
    existsOnServer: boolean;
    access?: SheetAccess | null;
    setAccess?: (access: SheetAccess) => Promise<boolean>;
}

export type SheetAccessOutcome = "unsupported" | "not-dm" | "no-sheet" | "unchanged" | "preset" | "set" | "failed";

/** The sheet DataBlock's access as this client knows it, for the Diagnostics report. */
export function describeSheetAccess(block: unknown): string {
    const b = block as AccessibleBlock | undefined;
    if (!b) return "no sheet data loaded";
    if (typeof b.setAccess !== "function") return "this server has no DataBlock access levels";
    if (!b.access) return "server default";
    return `read: ${b.access.read}, write: ${b.access.write}`;
}

/**
 * Gives a token's sheet the access it should have (see above), on the DM's client. A sheet already on the
 * server is changed there; one that isn't yet gets it for when it is created ("preset"), so a new
 * monster's sheet is never readable by players at all. Call it before saving a new sheet. A sheet that
 * is still loading is waited for (up to `waitMs`).
 */
export async function applySheetAccess(
    api: GameApi,
    shape: Parameters<GameApi["getGlobalId"]>[0],
    character: boolean,
    sheetName: string,
    waitMs = 3000,
): Promise<SheetAccessOutcome> {
    if (!isDm(api)) return "not-dm";
    const shapeId = api.getGlobalId(shape);
    if (!shapeId) return "no-sheet";
    const repr = { category: "shape", shape: shapeId, name: sheetName } as const;
    let block = api.getDataBlock(repr) as unknown as AccessibleBlock | undefined;
    for (let waited = 0; waited < waitMs && !block; waited += 250) {
        await new Promise((r) => setTimeout(r, 250));
        block = api.getDataBlock(repr) as unknown as AccessibleBlock | undefined;
    }
    if (!block) return "no-sheet";
    if (typeof block.setAccess !== "function") return "unsupported";
    const want = sheetAccess(character);
    if (block.access?.read === want.read && block.access.write === want.write) return "unchanged";
    // A sheet on the server default is "owner": right for a character.
    if (block.existsOnServer && !block.access && character) return "unchanged";
    const onServer = block.existsOnServer;
    try {
        if (!(await block.setAccess.call(block, want))) return "failed";
        return onServer ? "set" : "preset";
    } catch {
        return "failed";
    }
}
