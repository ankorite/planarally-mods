import { describe, expect, it } from "vitest";

import { applyAdjustments, hitDice, leadingDamage, stackEffects } from "../adjustments";
import { naturalOf } from "../crits";
import { buildSheet, cdName, damageFormula, iterativeBonuses, ordinal } from "../customdata";
import { emptyCharacter, type AdjustmentEffect, type PF1Character } from "../data";
import { carryUsesLeft, refillsDaily, resourceLabel, trackedKeys, usesLeft } from "../resources";
import { defensiveBonus, defensiveDc, guessSpellFormula } from "../spells";
import { compareVersions, tomlVersion } from "../updates";

/** A character with one custom adjustment switched on. */
function adjusted(c: PF1Character, effects: AdjustmentEffect[]): PF1Character {
    c.adjustments = { enabled: ["x"], custom: [{ id: "x", name: "Test", effects }] };
    return applyAdjustments(c);
}

describe("adjustments", () => {
    it("stacks PF1 bonus types", () => {
        expect(
            stackEffects([
                { target: "ac", type: "deflection", value: 2 },
                { target: "ac", type: "deflection", value: 1 },
                { target: "ac", type: "dodge", value: 1 },
                { target: "ac", type: "dodge", value: 1 },
                { target: "ac", type: "untyped", value: -2 },
            ]),
        ).toBe(2 + 1 + 1 - 2);
    });

    it("caps a Dex change to AC at the armor's max Dex", () => {
        const c = emptyCharacter();
        c.abilities.dex = 12; // +1, already at the cap
        c.combat.maxDex = 1;
        c.combat.ac = { normal: 27, touch: 12, flatFooted: 26 };
        const out = adjusted(c, [{ target: "dex", type: "enhancement", value: 4 }]);
        expect(out.combat.ac.normal).toBe(27);
        expect(out.combat.ac.touch).toBe(12);
        // Initiative and Reflex aren't capped.
        expect(out.combat.initiative).toBe(c.combat.initiative + 2);
        // Without armor limits the full change applies.
        const free = emptyCharacter();
        free.abilities.dex = 12;
        expect(adjusted(free, [{ target: "dex", type: "enhancement", value: 4 }]).combat.ac.normal).toBe(10 + 2);
    });

    it("gives a two-handed weapon 1.5x a Strength bonus to damage", () => {
        const c = emptyCharacter();
        c.abilities.str = 18; // +4
        c.combat.attacks = [
            {
                name: "Greatsword",
                bonus: "+13/+8",
                damage: "2d6+9",
                critical: "",
                damageType: "S",
                notes: "",
                kind: "melee",
                twoHanded: true,
            },
            {
                name: "Longsword",
                bonus: "+13/+8",
                damage: "1d8+6",
                critical: "",
                damageType: "S",
                notes: "",
                kind: "melee",
            },
        ];
        const out = adjusted(c, [{ target: "str", type: "enhancement", value: 4 }]); // +2 mod
        expect(out.combat.attacks[0]!.damage).toBe("2d6+12"); // floor(6*1.5)-floor(4*1.5) = 9-6 = +3
        expect(out.combat.attacks[1]!.damage).toBe("1d8+8");
        expect(out.combat.attacks[0]!.bonus).toBe("+15/+10");
    });

    it("raises max HP with Constitution by hit dice, leaving current HP alone", () => {
        const c = emptyCharacter();
        c.identity.hitDice = "7 HD; 4d8+3d10+32";
        c.abilities.con = 16;
        c.combat.hp = { max: 81, current: 50, nonlethal: 0 };
        const out = adjusted(c, [{ target: "con", type: "enhancement", value: 4 }]);
        expect(out.combat.hp.max).toBe(81 + 2 * 7);
        expect(out.combat.hp.current).toBe(50);
        expect(
            hitDice({ identity: { ...c.identity, hitDice: "" }, classes: [{ name: "A", level: 3, archetypes: [] }] }),
        ).toBe(3);
    });

    it("finds the leading damage dice", () => {
        expect(leadingDamage("2d6+4 plus grab")).toEqual({ formula: "2d6+4", rest: " plus grab" });
        expect(damageFormula("1d8+2d6+3 fire")).toBe("1d8+2d6+3");
        expect(damageFormula("6")).toBeUndefined();
    });

    it("returns the stored character when nothing is switched on", () => {
        const c = emptyCharacter();
        expect(applyAdjustments(c)).toBe(c);
    });
});

describe("natural 20 / 1", () => {
    const roll = (...dice: { roll: number; status?: string }[]) => ({ parts: [{ die: "d20", output: dice }] });
    it("spots a kept 20 or 1 on a d20", () => {
        expect(naturalOf(roll({ roll: 20 }))).toBe("nat20");
        expect(naturalOf(roll({ roll: 1 }))).toBe("nat1");
        expect(naturalOf(roll({ roll: 12 }))).toBeUndefined();
    });
    it("ignores dropped dice and other dice", () => {
        expect(naturalOf(roll({ roll: 20, status: "dropped" }, { roll: 14, status: "kept" }))).toBeUndefined();
        expect(naturalOf({ parts: [{ die: "d6", output: [{ roll: 1 }] }] })).toBeUndefined();
        expect(naturalOf(roll({ roll: 1 }, { roll: 20 }))).toBe("nat20");
        expect(naturalOf(undefined)).toBeUndefined();
    });
});

describe("spells", () => {
    it("guesses dice from the rules text at a caster level", () => {
        expect(guessSpellFormula("1d6 points of fire damage per caster level (maximum 10d6)", 7)).toBe("7d6");
        expect(guessSpellFormula("cures 1d8 points of damage + 1 point per caster level (maximum +5)", 7)).toBe(
            "1d8+5",
        );
        expect(guessSpellFormula("1d6 points of damage per two caster levels (maximum 5d6)", 7)).toBe("3d6");
        expect(guessSpellFormula("The smoke lingers 1d6 rounds.", 7)).toBe("");
    });
    it("casts defensively against 15 + 2 x level, +4 with Combat Casting", () => {
        expect(defensiveDc(0)).toBe(15);
        expect(defensiveDc(2)).toBe(19);
        expect(defensiveBonus({ feats: [{ name: "Combat Casting", description: "", fullText: "" }] })).toBe(4);
        expect(defensiveBonus({ feats: [] })).toBe(0);
    });
});

describe("resources", () => {
    const r = (over: object = {}) => ({ key: "res:x", name: "Smite Evil (2/day)", max: 2, used: 0, uuid: "", ...over });
    it("counts uses left within 0..max", () => {
        expect(usesLeft(r())).toBe(2);
        expect(usesLeft(r({ used: 1 }))).toBe(1);
        expect(usesLeft(r({ left: 9 }))).toBe(2);
        expect(usesLeft(r({ left: -1 }))).toBe(0);
    });
    it("keeps uses left across a re-import", () => {
        const next = [r({ max: 3 }), r({ key: "res:new", max: 1 })];
        expect(carryUsesLeft(next, [r({ left: 2 })]).map(usesLeft)).toEqual([3, 1]); // full stays full
        expect(carryUsesLeft(next, [r({ left: 1 })]).map(usesLeft)).toEqual([1, 1]);
    });
    it("labels and refills by how uses come back", () => {
        expect(resourceLabel(r())).toBe("2 per day");
        expect(refillsDaily(r())).toBe(true);
        expect(resourceLabel(r({ name: "Wand of CLW (50 charges)", max: 50 }))).toBe("50 charges");
        expect(refillsDaily(r({ name: "Wand of CLW (50 charges)", max: 50 }))).toBe(false);
        expect(refillsDaily(r({ key: "slots:oracle:1", name: "Oracle level 1 slots" }))).toBe(true);
    });
    it("tracks nothing by default, but keeps an older sheet's trackers", () => {
        expect(trackedKeys({ resources: [r()], trackedResources: [] })).toEqual([]);
        expect(trackedKeys({ resources: [r(), r({ key: "res:b" })], untrackedResources: ["res:b"] })).toEqual([
            "res:x",
        ]);
    });
});

describe("custom data", () => {
    it("names, ordinals and iterative attacks", () => {
        expect(cdName("Knowledge (arcana)")).toBe("Knowledge arcana");
        expect(ordinal(1)).toBe("1st");
        expect(ordinal(12)).toBe("12th");
        expect(ordinal(23)).toBe("23rd");
        expect(iterativeBonuses("+13/+8/+3")).toEqual([13, 8, 3]);
        expect(iterativeBonuses("+5 (+3 vs. evil)")).toEqual([5]);
    });
    it("exports initiative and saves as macros unless switched off", () => {
        const c = emptyCharacter();
        const names = (x: PF1Character) => buildSheet(x).elements.map((e) => e.name);
        expect(names(c)).toContain("Roll Will");
        c.macroExcludedRolls = ["Will"];
        expect(names(c)).not.toContain("Roll Will");
    });
});

describe("update check", () => {
    it("orders versions semver-style", () => {
        const order = [
            "0.21.2",
            "0.22.0-beta.1",
            "0.22.0-beta.2",
            "0.22.0-beta.10",
            "0.22.0",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
        ];
        for (let i = 0; i < order.length - 1; i++) expect(compareVersions(order[i]!, order[i + 1]!)).toBe(-1);
        expect(compareVersions("1.0", "1.0.0")).toBe(0);
        expect(tomlVersion('[mod]\nversion = "1.0.0"\n')).toBe("1.0.0");
    });
});
