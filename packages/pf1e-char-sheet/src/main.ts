import type { ApiModMeta, GameApi, LocalId, ModEvents } from "@planarally/mod-api";

import CharSheet from "./CharSheet.vue";
import { DATA_BLOCK_NAME, emptyCharacter, type PF1Character } from "./data";
import { diagState, exposeDebugHandle, installBusListeners, note, quickSummary } from "./diagnostics";
import { isHpTrackerName, realTrackers, subscribeToBus } from "./trackers";

// Shared game API handle, set in initGame and used throughout the mod.
export let api: GameApi;

async function init(meta: ApiModMeta): Promise<void> {
    console.log(`Loading ${meta.name} v${meta.version}`);
    diagState.meta = meta;
}

async function initGame(gameApi: GameApi): Promise<void> {
    api = gameApi;

    api.ui.shape.registerTab(
        { component: CharSheet, id: "PF1E", label: "PF1e Sheet" },
        // Only people who can edit the character get the sheet tab (the DM always can).
        (shape: LocalId, hasEditAccess?: boolean) =>
            canEdit(hasEditAccess) && api.getShape(shape)?.character !== undefined,
    );

    // Tracker -> sheet. PA emits "tracker:updated" on its event bus after every tracker change,
    // whether it came from the local UI or from another player via the server.
    try {
        if (!subscribeToBus(api, "tracker:updated", onTrackerUpdated)) {
            note("no usable api.eventBus - HP changes made on the token will not reach the sheet");
        }
    } catch (e) {
        note(`tracker event subscription failed: ${String(e)}`);
    }

    // Diagnostics (see diagnostics.ts): console handle, event-bus logging, startup summary.
    try {
        exposeDebugHandle(api, () => api.systemsState?.selected?.reactive?.focus);
        installBusListeners(api);
        console.log(`[pf1e-diag] quick summary:\n${quickSummary(api)}`);
    } catch (e) {
        console.log(`[pf1e-diag] startup probe failed: ${String(e)}`);
    }
}

/**
 * Whether the viewer may edit the shape whose tab is being decided. PlanarAlly's published types say
 * the tab filter receives `hasEditAccess`; that is used when it is a boolean. If a server doesn't
 * pass it, fall back to PlanarAlly's own "can edit the focused shape" flag, and failing that to "is
 * the DM" - so a missing argument can never hide the sheet from the DM, only from players.
 */
function canEdit(hasEditAccess: boolean | undefined): boolean {
    if (typeof hasEditAccess === "boolean") return hasEditAccess;
    const state = api.systemsState as unknown as
        | {
              access?: { hasEditAccess?: { value?: unknown } };
              game?: { raw?: { isDm?: boolean } };
          }
        | undefined;
    const flag = state?.access?.hasEditAccess?.value;
    if (typeof flag === "boolean") return flag;
    return state?.game?.raw?.isDm === true;
}

async function loadLocation(): Promise<void> {
    note("loadLocation event fired");
}

// Payload shape verified from PA's own source: { id, trackerId, delta, syncTo }, emitted after
// the delta has been applied to the stored tracker.
function onTrackerUpdated(payload: unknown): void {
    const p = payload as { id?: unknown; trackerId?: unknown } | undefined;
    if (typeof p?.id !== "number" || typeof p.trackerId !== "string") return;
    const id = p.id as LocalId;

    try {
        if (api.getShape(id)?.character === undefined) return;
    } catch {
        return;
    }

    const tracker = realTrackers(api)?.get(id, p.trackerId);
    if (!tracker || !isHpTrackerName(tracker.name)) return;

    void syncTrackerIntoSheet(id, tracker.value);
}

/**
 * Writes the tracker's value into the sheet's current HP. Deliberately current HP only: max HP
 * comes from the Hero Lab import and is read-only on the sheet, and a hand-made tracker often has
 * maxvalue 0, which must never overwrite a real max.
 */
async function syncTrackerIntoSheet(id: LocalId, current: number): Promise<void> {
    if (!Number.isFinite(current)) return;
    const shapeId = api.getGlobalId(id);
    if (!shapeId) return;

    const block = await api.getOrLoadDataBlock<PF1Character>(
        { category: "shape", shape: shapeId, name: DATA_BLOCK_NAME },
        { defaultData: emptyCharacter },
    );
    if (!block) return;

    // Also skips the echo of our own sheet -> tracker push.
    if (block.data.combat.hp.current === current) return;

    block.data.combat.hp.current = current;
    block.sync();
}

export const events: ModEvents = {
    init,
    initGame,
    loadLocation,
};
