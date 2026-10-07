import type { ApiModMeta, GameApi, LocalId, ModEvents, TrackerId } from "@planarally/mod-api";

import { isCharacterShape, isDm } from "./access";
import CharSheet from "./CharSheet.vue";
import { DATA_BLOCK_NAME, emptyCharacter, type PF1Character } from "./data";
import { diagState, exposeDebugHandle, installBusListeners, note, removeDebugHandle } from "./diagnostics";
import { isHpTrackerName } from "./trackers";

// Shared game API handle, set in initGame and used throughout the mod.
export let api: GameApi;

/** The installed version (from mod.toml, as PlanarAlly loaded it), for the sheet's update check. */
export let modVersion: string | undefined;

function init(meta: ApiModMeta): void {
    console.log(`Loading ${meta.name} v${meta.version}`);
    diagState.meta = meta;
    modVersion = meta.version;
}

function initGame(gameApi: GameApi): void {
    api = gameApi;

    // Characters get the full sheet, for everyone who can edit them (the DM always can). Any other
    // token gets the limited sheet (combat, skills, specials) for monsters and NPCs - DM only.
    api.ui.shape.registerTab({ component: CharSheet, id: "PF1E", label: "PF1e Sheet" }, (shape, hasEditAccess) =>
        isCharacterShape(api, shape) ? hasEditAccess : isDm(api),
    );

    // Tracker -> sheet. PA emits "tracker:updated" on its event bus after every tracker change,
    // whether it came from the local UI or from another player via the server.
    api.eventBus.on("tracker:updated", onTrackerUpdated);

    // Diagnostics (see diagnostics.ts): console handle and the event log the reports show.
    try {
        exposeDebugHandle(api, () => api.systemsState.selected.reactive.focus);
        installBusListeners(api);
    } catch (e) {
        note(`diagnostics setup failed: ${String(e)}`);
    }
}

// PlanarAlly removes the tab, event-bus listeners and hooks itself after this returns.
function dispose(): void {
    removeDebugHandle();
}

// Payload shape from PA's own source: { id, trackerId, delta, syncTo }, emitted after the delta has
// been applied to the stored tracker.
function onTrackerUpdated(payload: unknown): void {
    const p = payload as { id?: unknown; trackerId?: unknown } | undefined;
    if (typeof p?.id !== "number" || typeof p.trackerId !== "string") return;
    const id = p.id as LocalId;

    // A monster/NPC's sheet is the DM's: only the DM's client writes it back (and players' clients,
    // which can't edit it, don't try).
    const character = isCharacterShape(api, id);
    if (!character && !isDm(api)) return;

    let tracker;
    try {
        tracker = api.systems.trackers.get(id, p.trackerId as TrackerId, false);
    } catch {
        return;
    }
    if (!tracker || !isHpTrackerName(tracker.name)) return;

    void syncTrackerIntoSheet(id, tracker.value, character);
}

/**
 * Writes the tracker's value into the sheet's current HP. Deliberately current HP only: max HP
 * comes from the Hero Lab import and is read-only on the sheet, and a hand-made tracker often has
 * maxvalue 0, which must never overwrite a real max.
 *
 * A character always has a sheet, so its DataBlock is created if needed. Any other token only has
 * one if the DM imported a monster/NPC onto it, so for those an existing DataBlock is required:
 * changing HP on an ordinary token never creates sheet data.
 */
async function syncTrackerIntoSheet(id: LocalId, current: number, character: boolean): Promise<void> {
    if (!Number.isFinite(current)) return;
    const shapeId = api.getGlobalId(id);
    if (!shapeId) return;

    const repr = { category: "shape", shape: shapeId, name: DATA_BLOCK_NAME } as const;
    let block;
    try {
        block = character
            ? await api.getOrLoadDataBlock<PF1Character>(repr, { defaultData: emptyCharacter })
            : (api.getDataBlock<PF1Character>(repr) ?? (await api.loadDataBlock<PF1Character>(repr)));
    } catch {
        return;
    }
    if (!block) return;

    // Also skips the echo of our own sheet -> tracker push.
    if (block.data.combat.hp.current === current) return;

    // Write through `reactiveData`, not `block.data`: both are the same object, but only the reactive
    // proxy tells Vue about the change. Writing `block.data` directly stored and synced the new HP but
    // left an open sheet showing the old value, which its next HP commit could push back to the tracker.
    block.reactiveData.value.combat.hp.current = current;
    block.sync();
}

export const events: ModEvents = {
    init,
    initGame,
    dispose,
};
