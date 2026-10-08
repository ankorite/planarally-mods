import type { GameApi, LocalId } from "@planarally/mod-api";

import { holdCustomDataLease, buildElements, syncCustomData } from "./customdata";
import { DATA_BLOCK_NAME, type PF1Character } from "./data";

// Duplicates a monster/NPC token together with its sheet.
//
// The mod API has no way to create a shape, so this drives PlanarAlly's own copy & paste: the token
// is selected and PlanarAlly's Ctrl+C / Ctrl+V handler (a keydown listener on the window) is given
// those keys. That is PlanarAlly's full duplicate - the new token gets the same image, size, name,
// trackers, auras and Custom Data, on the current layer, offset slightly. It replaces whatever was
// on PlanarAlly's shape clipboard, exactly as pressing Ctrl+C would.
//
// What a duplicate doesn't copy is the mod's data block, so the sheet data is copied here. A
// duplicate gives every tracker and aura a new uuid (in the same order), so the uuids the sheet keeps
// for the trackers and auras it manages are remapped to the copy's.

type Dict = Record<string, unknown>;

interface SelectedSystem {
    get(): readonly { id: LocalId }[];
    set(...ids: LocalId[]): void;
}

interface ListSystem {
    getAll(shape: LocalId): { uuid: string; name: string; temporary?: boolean }[];
}

const systems = (api: GameApi): Dict => api.systems as unknown as Dict;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends one shortcut to PlanarAlly's window keydown handler (Ctrl on Windows/Linux, Cmd on a Mac). */
function press(key: string): void {
    window.dispatchEvent(
        new KeyboardEvent("keydown", {
            key,
            code: `Key${key.toUpperCase()}`,
            ctrlKey: true,
            metaKey: true,
            bubbles: true,
        }),
    );
}

/** old uuid -> new uuid for the records both shapes have, matched by position and checked by name. */
function remap(sys: ListSystem | undefined, from: LocalId, to: LocalId): Map<string, string> {
    const map = new Map<string, string>();
    if (!sys || typeof sys.getAll !== "function") return map;
    const real = (id: LocalId) => sys.getAll(id).filter((r) => r.temporary !== true);
    const before = real(from);
    const after = real(to);
    before.forEach((r, i) => {
        const copy = after[i];
        if (copy && copy.name === r.name) map.set(r.uuid, copy.uuid);
    });
    return map;
}

export interface DuplicateOutcome {
    ok: boolean;
    message: string;
    copy?: LocalId;
}

export async function duplicateToken(api: GameApi, shape: LocalId, character: PF1Character): Promise<DuplicateOutcome> {
    const selected = systems(api)["selected"] as SelectedSystem | undefined;
    if (!selected || typeof selected.set !== "function" || typeof selected.get !== "function") {
        return { ok: false, message: "This server doesn't let mods select tokens, so it can't duplicate one." };
    }

    // 1. PlanarAlly's own copy & paste of just this token.
    selected.set(shape);
    press("c");
    await sleep(50);
    press("v");
    let copy: LocalId | undefined;
    for (let waited = 0; waited < 2000 && copy === undefined; waited += 50) {
        await sleep(50);
        const now = selected.get();
        if (now.length === 1 && now[0]!.id !== shape) copy = now[0]!.id;
    }
    if (copy === undefined) {
        return {
            ok: false,
            message:
                "PlanarAlly didn't paste a copy. Select the token and press Ctrl+C, Ctrl+V, then import the sheet onto it.",
        };
    }

    // 2. The sheet data, pointing at the copy's own trackers and auras.
    const trackerIds = remap(systems(api)["trackers"] as ListSystem | undefined, shape, copy);
    const auraIds = remap(systems(api)["auras"] as ListSystem | undefined, shape, copy);
    const data = JSON.parse(JSON.stringify(character)) as PF1Character;
    for (const r of data.resources ?? []) r.uuid = trackerIds.get(r.uuid) ?? "";
    for (const a of data.auras ?? []) a.uuid = auraIds.get(a.uuid) ?? "";

    const shapeId = api.getGlobalId(copy);
    if (!shapeId)
        return { ok: false, copy, message: "The copy has no id on the server yet - import the sheet onto it." };

    // The copy is sent to the server just before; give it a moment so the data block can attach to it,
    // and retry the creation once if the server wasn't ready.
    await sleep(500);
    const block = api.createDataBlock<PF1Character>(
        { category: "shape", shape: shapeId, name: DATA_BLOCK_NAME },
        data,
        {
            createOnServer: true,
        },
    );
    await sleep(1500);
    if (!block.existsOnServer) block.sync();

    // 3. Make sure the copy's Custom Data (numbers and dice macros) is complete.
    const release = holdCustomDataLease(api, copy);
    try {
        syncCustomData(api, copy, buildElements(data));
    } catch (e) {
        console.error("[pf1e-sheet] Custom Data on the duplicate failed", e);
    } finally {
        release();
    }

    return { ok: true, copy, message: `Duplicated ${data.identity.name || "the token"}; the copy is selected.` };
}
