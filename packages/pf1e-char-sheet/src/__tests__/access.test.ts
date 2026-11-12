import { describe, expect, it } from "vitest";

import { applySheetAccess, describeSheetAccess, sheetAccess, type SheetAccess } from "../access";
import { emptyCharacter, type PF1Character } from "../data";
import { createSheetApi, provideSheetApi } from "../modapi";

// A fake PlanarAlly: tokens 1 (a character) and 2 (a monster), each with a sheet block.
function fakeApi(opts: { dm: boolean; accessLevels: boolean; blockAccess?: SheetAccess; onServer?: boolean }) {
    const sets: SheetAccess[] = [];
    const sheet = (name: string): PF1Character => {
        const c = emptyCharacter();
        c.identity.name = name;
        c.importedAt = "2026-11-12T00:00:00Z";
        c.adjustments = { enabled: ["bless"], custom: [] };
        return c;
    };
    const blocks = new Map<string, Record<string, unknown>>();
    for (const [shape, name] of [
        ["g1", "Dresdon"],
        ["g2", "Orc"],
    ] as const) {
        const block: Record<string, unknown> = { existsOnServer: opts.onServer ?? true, data: sheet(name) };
        if (opts.accessLevels) {
            block["access"] = opts.blockAccess ?? null;
            block["setAccess"] = (a: SheetAccess) => {
                sets.push(a);
                block["access"] = a;
                return Promise.resolve(true);
            };
        }
        blocks.set(shape, block);
    }
    let provided: object | undefined;
    const api = {
        systemsState: { game: { reactive: { isDm: opts.dm, isFakePlayer: false } } },
        getShape: (id: number) => (id === 1 ? { character: 7 } : {}),
        getGlobalId: (id: number) => `g${id}`,
        getDataBlock: (repr: { shape: string }) => blocks.get(repr.shape),
        loadDataBlock: (repr: { shape: string }) => Promise.resolve(blocks.get(repr.shape)),
        provideApi: (o: object) => {
            provided = o;
            return () => (provided = undefined);
        },
    };
    return { api: api as never, sets, provided: () => provided };
}

describe("sheet access", () => {
    it("is the owners' for a character and the DM's for a monster", () => {
        expect(sheetAccess(true)).toEqual({ read: "owner", write: "owner" });
        expect(sheetAccess(false)).toEqual({ read: "dm", write: "dm" });
    });

    it("makes a monster's sheet DM only, on the DM's client", async () => {
        const f = fakeApi({ dm: true, accessLevels: true });
        expect(await applySheetAccess(f.api, 2 as never, false, "pf1e-sheet", 0)).toBe("set");
        expect(f.sets).toEqual([{ read: "dm", write: "dm" }]);
        expect(await applySheetAccess(f.api, 2 as never, false, "pf1e-sheet", 0)).toBe("unchanged");
        // A character's sheet on the server default is already right.
        expect(await applySheetAccess(f.api, 1 as never, true, "pf1e-sheet", 0)).toBe("unchanged");
        expect(f.sets).toHaveLength(1);
    });

    it("presets a new monster sheet's access before it is created", async () => {
        const f = fakeApi({ dm: true, accessLevels: true, onServer: false });
        expect(await applySheetAccess(f.api, 2 as never, false, "pf1e-sheet", 0)).toBe("preset");
        expect(f.sets).toEqual([{ read: "dm", write: "dm" }]);
        // A new character sheet is preset to its owners' too (the server default, said explicitly).
        expect(await applySheetAccess(f.api, 1 as never, true, "pf1e-sheet", 0)).toBe("preset");
    });

    it("gives a token that became a character its owners' access back", async () => {
        const f = fakeApi({ dm: true, accessLevels: true, blockAccess: { read: "dm", write: "dm" } });
        expect(await applySheetAccess(f.api, 1 as never, true, "pf1e-sheet", 0)).toBe("set");
        expect(f.sets).toEqual([{ read: "owner", write: "owner" }]);
    });

    it("leaves players and older servers alone", async () => {
        expect(await applySheetAccess(fakeApi({ dm: false, accessLevels: true }).api, 2 as never, false, "x", 0)).toBe(
            "not-dm",
        );
        const old = fakeApi({ dm: true, accessLevels: false });
        expect(await applySheetAccess(old.api, 2 as never, false, "x", 0)).toBe("unsupported");
        expect(describeSheetAccess({ existsOnServer: true })).toBe("this server has no DataBlock access levels");
        expect(
            describeSheetAccess({ existsOnServer: true, access: { read: "dm", write: "dm" }, setAccess: () => 0 }),
        ).toBe("read: dm, write: dm");
    });
});

describe("API for other mods", () => {
    it("gives a character's sheet, adjusted or as stored, as a copy", async () => {
        const f = fakeApi({ dm: false, accessLevels: false });
        const sheetApi = createSheetApi(f.api, "1.1.0");
        const adjusted = await sheetApi.getCharacter(1 as never);
        const stored = await sheetApi.getCharacter(1 as never, { adjusted: false });
        expect(adjusted?.identity.name).toBe("Dresdon");
        expect(adjusted!.combat.cmb).toBe(stored!.combat.cmb + 1); // Bless: +1 morale on attacks, so CMB
        adjusted!.identity.name = "changed";
        expect((await sheetApi.getCharacter(1 as never))?.identity.name).toBe("Dresdon");
        expect((await sheetApi.getRollFields(1 as never))?.will).toBeTruthy();
    });

    it("gives a monster's sheet to the DM only", async () => {
        expect(
            await createSheetApi(fakeApi({ dm: false, accessLevels: false }).api, "x").getCharacter(2 as never),
        ).toBe(undefined);
        expect(
            (await createSheetApi(fakeApi({ dm: true, accessLevels: false }).api, "x").getCharacter(2 as never))
                ?.identity.name,
        ).toBe("Orc");
    });

    it("is offered on a PlanarAlly with provideApi, and taken back", () => {
        const f = fakeApi({ dm: false, accessLevels: false });
        const stop = provideSheetApi(f.api, "1.1.0");
        expect(f.provided()).toMatchObject({ apiVersion: 1, modVersion: "1.1.0" });
        stop?.();
        expect(f.provided()).toBeUndefined();
        expect(provideSheetApi({} as never, "1.1.0")).toBeUndefined();
    });
});
