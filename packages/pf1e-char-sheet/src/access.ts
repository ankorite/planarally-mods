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
