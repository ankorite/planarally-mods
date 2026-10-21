import { afterEach, describe, expect, it } from "vitest";
import { nextTick, ref, type Ref } from "vue";

import { emptyCharacter, type PF1Character } from "../data";
import {
    disposeRules,
    initRules,
    listedEntries,
    moveRulesToCompendium,
    ruleId,
    ruleRegistered,
    ruleText,
    rulesReady,
    shardOf,
    specialRuleName,
} from "../rules";

// A fake PlanarAlly with just enough of the DataBlock and compendium behaviour rules.ts relies on: a
// "server" holding block data by name, blocks that know whether they exist there, sync() that writes
// to it, and another client's save arriving as a replaced data object.

type Server = Map<string, string>;

class FakeBlock<D> {
    existsOnServer: boolean;
    reactiveData: Ref<D>;
    constructor(
        private server: Server,
        private name: string,
        data: D,
        exists: boolean,
    ) {
        this.existsOnServer = exists;
        this.reactiveData = ref(data) as Ref<D>;
    }
    get data(): D {
        return this.reactiveData.value;
    }
    updateData(d: D): void {
        this.reactiveData.value = d;
    }
    sync(): void {
        this.server.set(this.name, JSON.stringify(this.reactiveData.value));
        this.existsOnServer = true;
    }
    /** Another client's save arriving (PlanarAlly's DataBlock.Saved). */
    remoteSave(d: D): void {
        this.server.set(this.name, JSON.stringify(d));
        this.reactiveData.value = d;
    }
}

function fakeApi(server: Server) {
    const blocks = new Map<string, FakeBlock<unknown>>();
    const registered: { entries: { id: string; schema?: { system: string; kind: string } }[] }[] = [];
    const api = {
        compendium: {
            register(entries: { id: string }[]) {
                registered.push({ entries });
                return () => undefined;
            },
        },
        systems: {},
        async getOrLoadDataBlock(repr: { name: string }, opts?: { defaultData?: () => unknown }) {
            const known = blocks.get(repr.name);
            if (known) return known;
            const raw = server.get(repr.name);
            if (raw === undefined && !opts?.defaultData) return undefined;
            const block = new FakeBlock(server, repr.name, raw ? JSON.parse(raw) : opts!.defaultData!(), !!raw);
            blocks.set(repr.name, block);
            return block;
        },
    };
    return { api: api as never, blocks, registered };
}

function character(): PF1Character {
    const c = emptyCharacter();
    c.feats = [{ name: "Power Attack", description: "short", fullText: "Power Attack full text" }];
    c.skills = [
        {
            name: "Climb",
            ability: "str",
            ranks: 1,
            classSkill: true,
            miscMod: 0,
            total: 5,
            trainedOnly: false,
            description: "Climb full text",
        },
    ];
    c.specials = [
        {
            name: "Smite Evil (1/day)",
            category: "Offensive abilities",
            type: "",
            source: "Paladin",
            description: "s",
            fullText: "Smite text",
        },
    ];
    return c;
}

afterEach(() => disposeRules());

describe("rules storage", () => {
    it("spreads rules over stable shards", () => {
        expect(shardOf("feat-power-attack")).toBe(shardOf("feat-power-attack"));
        const used = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => shardOf(`feat-${x}`)));
        expect(used.size).toBeGreaterThan(1);
        expect(ruleId("feat", "Weapon Focus (Longsword)")).toBe("feat-weapon-focus-longsword");
    });

    it("keeps text on the sheet until the server is known to have it, then moves it", async () => {
        const server: Server = new Map();
        const s1 = fakeApi(server);
        await initRules(s1.api, "pf1e-sheet");
        expect(rulesReady.value).toBe(true);

        // First import: rules are written, but not confirmed yet - nothing comes off the sheet.
        const c = character();
        const first = moveRulesToCompendium(s1.api, c, true);
        expect(first).toEqual({ added: 3, stripped: 0 });
        expect(c.feats[0]!.fullText).toBe("Power Attack full text");
        expect(ruleText("feat", "Power Attack")).toBe("Power Attack full text");
        expect(ruleRegistered("skill", "Climb")).toBe(true);
        // Written to the server, in the rules' shards.
        const shardName = `pf1e-rules-${String(shardOf("feat-power-attack")).padStart(2, "0")}`;
        expect(JSON.parse(server.get(shardName)!).entries["feat-power-attack"].body).toBe("Power Attack full text");

        // Opening it again in the same session changes nothing (no confirmation, nothing to write) - even
        // after the shards' watchers have seen this client's own write.
        await nextTick();
        await new Promise((r) => setTimeout(r, 80));
        const again = moveRulesToCompendium(s1.api, c, true);
        expect(again).toEqual({ added: 0, stripped: 0 });
        disposeRules();

        // Next session: the blocks come from the server, so the rules are confirmed and the text moves.
        const s2 = fakeApi(server);
        await initRules(s2.api, "pf1e-sheet");
        const next = moveRulesToCompendium(s2.api, c, true);
        expect(next).toEqual({ added: 0, stripped: 3 });
        expect(c.feats[0]!.fullText).toBe("");
        expect(c.skills[0]!.description).toBeUndefined();
        expect(c.specials![0]!.fullText).toBe("");
        // A special is stored under its name without the per-level part.
        expect(c.specials![0]!.rule).toBe("Smite Evil");
        expect(ruleText("special", "Smite Evil")).toBe("Smite text");
    });

    it("leaves a monster's specials on its sheet", async () => {
        const server: Server = new Map();
        const s = fakeApi(server);
        await initRules(s.api, "pf1e-sheet");
        const c = character();
        const out = moveRulesToCompendium(s.api, c, false);
        expect(out.added).toBe(2);
        expect(ruleRegistered("special", "Smite Evil (1/day)")).toBe(false);
        expect(ruleRegistered("special", "Smite Evil")).toBe(false);
    });

    it("confirms rules that arrive in another client's save, and re-registers them", async () => {
        const server: Server = new Map();
        const s = fakeApi(server);
        await initRules(s.api, "pf1e-sheet");
        const id = ruleId("feat", "Power Attack");
        const name = `pf1e-rules-${String(shardOf(id)).padStart(2, "0")}`;
        const block = s.blocks.get(name) as FakeBlock<{ entries: Record<string, unknown> }>;
        block.remoteSave({
            entries: {
                [id]: { id, name: "Power Attack", kind: "feat", path: ["Feats"], body: "Power Attack full text" },
            },
        });
        await nextTick();
        await new Promise((r) => setTimeout(r, 80));
        expect(s.registered.at(-1)?.entries.map((e) => e.id)).toContain(id);
        // Confirmed by that save, so this client's sheet may drop the text straight away.
        const c = character();
        expect(moveRulesToCompendium(s.api, c, true).stripped).toBe(1);
        expect(c.feats[0]!.fullText).toBe("");
    });

    it("writes a lost rule back from a sheet that still has its text", async () => {
        const server: Server = new Map();
        const s1 = fakeApi(server);
        await initRules(s1.api, "pf1e-sheet");
        const c = character();
        moveRulesToCompendium(s1.api, c, true);
        disposeRules();
        // Another client's stale save wiped the shard holding Power Attack.
        const id = ruleId("feat", "Power Attack");
        server.set(`pf1e-rules-${String(shardOf(id)).padStart(2, "0")}`, JSON.stringify({ entries: {} }));

        const s2 = fakeApi(server);
        await initRules(s2.api, "pf1e-sheet");
        const out = moveRulesToCompendium(s2.api, c, true);
        expect(out.added).toBe(1);
        expect(c.feats[0]!.fullText).toBe("Power Attack full text"); // not confirmed again yet: kept
        expect(ruleText("feat", "Power Attack")).toBe("Power Attack full text");
    });

    it("still reads rules from the single pre-1.0 block", async () => {
        const id = ruleId("feat", "Dodge");
        const server: Server = new Map([
            [
                "pf1e-rules",
                JSON.stringify({
                    entries: { [id]: { id, name: "Dodge", kind: "feat", path: ["Feats"], body: "old" } },
                }),
            ],
        ]);
        const s = fakeApi(server);
        await initRules(s.api, "pf1e-sheet");
        expect(ruleText("feat", "Dodge")).toBe("old");
        const c = emptyCharacter();
        c.feats = [{ name: "Dodge", description: "", fullText: "old" }];
        expect(moveRulesToCompendium(s.api, c, true)).toEqual({ added: 0, stripped: 1 });
    });

    it("shortens specials' names to what doesn't change with level", () => {
        expect(specialRuleName("Trap Sense +2 (Ex)")).toBe("Trap Sense");
        expect(specialRuleName("Studied Strike +2d6 (Ex)")).toBe("Studied Strike");
        expect(specialRuleName("Mythic Power (5/day, Surge +1d6)")).toBe("Mythic Power");
        expect(specialRuleName("Cape of free will +2/+3")).toBe("Cape of free will");
        expect(specialRuleName("Deed: Opportune Parry and Riposte (Ex)")).toBe("Deed: Opportune Parry and Riposte");
        expect(specialRuleName("(Ex)")).toBe("(Ex)");
    });

    it("keeps one entry for a special across level-ups, and tells different texts apart", async () => {
        const server: Server = new Map();
        const s = fakeApi(server);
        await initRules(s.api, "pf1e-sheet");
        const special = (name: string, fullText: string, source = "Investigator") => ({
            name,
            category: "Special abilities",
            type: "",
            source,
            description: "",
            fullText,
        });
        const c = emptyCharacter();
        c.specials = [special("Trap Sense +1 (Ex)", "Dodge traps."), special("Mutagen", "The discovery.")];
        expect(moveRulesToCompendium(s.api, c, true).added).toBe(2);

        // Level-up: same text under a new number - nothing new.
        const next = emptyCharacter();
        next.specials = [
            special("Trap Sense +2 (Ex)", "Dodge traps."),
            special("Mutagen", "The discovery."),
            special("Mutagen (DC 17) (Su)", "The class ability."),
        ];
        expect(moveRulesToCompendium(s.api, next, true).added).toBe(1);
        expect(next.specials.map((sp) => sp.rule)).toEqual(["Trap Sense", undefined, "Mutagen (Investigator)"]);
        expect(ruleText("special", "Mutagen")).toBe("The discovery.");
        expect(ruleText("special", "Mutagen (Investigator)")).toBe("The class ability.");
    });

    it("moves an older sheet's specials to their short names, and stops listing the old entries", async () => {
        const oldId = ruleId("special", "Smite Evil (1/day)");
        const old = { id: oldId, name: "Smite Evil (1/day)", kind: "special", path: ["Specials"], body: "Smite text" };
        const server: Server = new Map([
            [`pf1e-rules-${String(shardOf(oldId)).padStart(2, "0")}`, JSON.stringify({ entries: { [oldId]: old } })],
        ]);
        const s = fakeApi(server);
        await initRules(s.api, "pf1e-sheet");
        const c = character();
        c.feats = [];
        c.skills = [];
        c.specials![0]!.fullText = ""; // moved off the sheet by 1.0
        expect(moveRulesToCompendium(s.api, c, true)).toEqual({ added: 1, stripped: 0 });
        expect(c.specials![0]!.rule).toBe("Smite Evil");
        expect(ruleText("special", "Smite Evil")).toBe("Smite text");
        // Both entries are kept, but only the short one is listed.
        const listed = s.registered.at(-1)?.entries.map((e) => e.id);
        await new Promise((r) => setTimeout(r, 80));
        const now = s.registered.at(-1)!.entries.map((e) => e.id);
        expect(now).toContain(ruleId("special", "Smite Evil"));
        expect(now).not.toContain(oldId);
        expect(listed).toContain(oldId); // before the move
        expect(listedEntries([old as never])).toHaveLength(1); // alone, an old entry is still listed
    });

    it("registers mod API 0.6 entries and reads them back through getEntries", async () => {
        const server: Server = new Map();
        const s = fakeApi(server);
        // A 0.6 server: getEntries returns what was registered, as PlanarAlly's records.
        const api = s.api as unknown as { compendium: Record<string, unknown> };
        api.compendium["getEntries"] = (system: string, kind: string) =>
            (s.registered.at(-1)?.entries ?? [])
                .filter((e) => e.schema?.system === system && e.schema?.kind === kind)
                .map((e) => ({ ...e, mod: "pf1e-sheet", ref: `pf1e-sheet/${e.id}`, body: "from the compendium" }));
        await initRules(s.api, "pf1e-sheet");
        moveRulesToCompendium(s.api, character(), true);
        await new Promise((r) => setTimeout(r, 80));
        const feat = s.registered.at(-1)!.entries.find((e) => e.id === "feat-power-attack");
        expect(feat).toMatchObject({ schema: { system: "pf1e", kind: "feat" }, kind: "feat" });
        expect(ruleText("feat", "Power Attack")).toBe("from the compendium");
        expect(ruleRegistered("feat", "Power Attack")).toBe(true);
    });
});
