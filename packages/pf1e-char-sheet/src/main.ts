import type { ApiModMeta, GameApi, LocalId, ModEvents, TrackerId } from "@planarally/mod-api";

import { isCharacterShape, isDm } from "./access";
import CharSheet from "./CharSheet.vue";
import { DATA_BLOCK_NAME, emptyCharacter, type PF1Character } from "./data";
import { diagState, exposeDebugHandle, installBusListeners, note, removeDebugHandle } from "./diagnostics";
import { disposeRules, initRules } from "./rules";
import { isHpTrackerName } from "./trackers";

// Shared game API handle, set in initGame and used throughout the mod.
export let api: GameApi;

/** The installed version (from mod.toml, as PlanarAlly loaded it), for the sheet's update check. */
export let modVersion: string | undefined;

function init(meta: ApiModMeta): void {
    console.log(`Loading ${meta.name} v${meta.version}`);
    diagState.meta = meta;
    modVersion = meta.version;
    modTag = meta.tag;
}

let modTag: string | undefined;

function initGame(gameApi: GameApi): void {
    api = gameApi;

    // Characters get the full sheet, for everyone who can edit them (the DM always can). Any other
    // token gets the limited sheet (combat, skills, specials) for monsters and NPCs - DM only.
    api.ui.shape.registerTab({ component: CharSheet, id: "PF1E", label: "PF1e Sheet" }, (shape, hasEditAccess) =>
        isCharacterShape(api, shape) ? hasEditAccess : isDm(api),
    );

    // Rules text in PlanarAlly's compendium, on servers that have it (rules.ts).
    void initRules(api, modTag);

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
    disposeRules();
}

// Payload shape from PA's own source: { id, trackerId, delta, syncTo }, emitted after the delta has
// been applied to the stored tracker - on every connected client.
function onTrackerUpdated(payload: unknown): void {
    const p = payload as { id?: unknown; trackerId?: unknown; syncTo?: { server?: unknown } } | undefined;
    if (typeof p?.id !== "number" || typeof p.trackerId !== "string") return;
    const id = p.id as LocalId;

    // One writer per change: the client where it was made. PA applies a local change with
    // syncTo.server = true (and sends it to the server); the same change arriving from another client is
    // replayed with server = false. That client can edit the token (or it couldn't have changed the
    // tracker), and the others then get the new sheet data from the server like any other save -
    // rather than every connected browser loading and saving the data block at once.
    if (p.syncTo?.server !== true) return;

    // A monster/NPC's sheet is the DM's: only the DM's client writes it back.
    const character = isCharacterShape(api, id);
    if (!character && !isDm(api)) return;

    let tracker;
    try {
        tracker = api.systems.trackers.get(id, p.trackerId as TrackerId, false);
    } catch {
        return;
    }
    if (!tracker || !Number.isFinite(tracker.value)) return;

    if (isHpTrackerName(tracker.name)) void syncHpIntoSheet(id, tracker.value, character);
    else void syncResourceIntoSheet(id, p.trackerId, tracker.value);
}

/**
 * Writes the tracker's value into the sheet's current HP. Deliberately current HP only: max HP
 * comes from the Hero Lab import and is read-only on the sheet, and a hand-made tracker often has
 * maxvalue 0, which must never overwrite a real max.
 *
 * A character always has a sheet, so its DataBlock is created if needed.
 */
async function syncHpIntoSheet(id: LocalId, current: number, character: boolean): Promise<void> {
    const block = await sheetBlock(id, character);
    // Also skips the echo of our own sheet -> tracker push.
    if (!block || block.data.combat.hp.current === current) return;

    // Write through `reactiveData`, not `block.data`: both are the same object, but only the reactive
    // proxy tells Vue about the change. Writing `block.data` directly stored and synced the new HP but
    // left an open sheet showing the old value, which its next HP commit could push back to the tracker.
    block.reactiveData.value.combat.hp.current = current;
    block.sync();
}

/** Writes a resource tracker's value (x/day, charges, spell slots) into the sheet's uses left. */
async function syncResourceIntoSheet(id: LocalId, trackerId: string, current: number): Promise<void> {
    // Only a token that already has a sheet can have one of its resource trackers.
    const block = await sheetBlock(id, false);
    const resource = block?.reactiveData.value.resources?.find((r) => r.uuid === trackerId);
    if (!block || !resource) return;
    const left = Math.max(0, Math.min(resource.max, current));
    if (resource.left === left) return;
    resource.left = left;
    block.sync();
}

/**
 * The token's sheet DataBlock. A character always has a sheet, so with `create` its block is made
 * if needed. Any other token only has one if the DM imported a monster/NPC onto it, so otherwise an
 * existing block is required: changing a tracker on an ordinary token never creates sheet data.
 */
async function sheetBlock(id: LocalId, create: boolean) {
    const shapeId = api.getGlobalId(id);
    if (!shapeId) return;

    const repr = { category: "shape", shape: shapeId, name: DATA_BLOCK_NAME } as const;
    try {
        return create
            ? await api.getOrLoadDataBlock<PF1Character>(repr, { defaultData: emptyCharacter })
            : (api.getDataBlock<PF1Character>(repr) ?? (await api.loadDataBlock<PF1Character>(repr)));
    } catch {
        return undefined;
    }
}

export const events: ModEvents = {
    init,
    initGame,
    dispose,
};
