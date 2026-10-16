import { describe, expect, it } from "vitest";

import { HeroLabImportError, parseHeroLabXml } from "../herolab/parser";

// A small hand-written Hero Lab export in the shape of a real one (document > public > character), with
// made-up text. It covers the parts the parser has had to learn: the mythic tier that only shows in the
// class summary, spells known above the castable level, a range ability outside <auras>, a two-handed
// weapon, mutagens (one active in the export, one not), a spell prepared twice, and a minion whose stats must never mix into the character's.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<document><public><character name="Testa Brightblade">
  <race name="half-elf"/><alignment name="Lawful Good"/><deity name="Sarenrae"/>
  <size name="Medium"/>
  <classes level="7" summary="oracle (dual-cursed oracle) 4/paladin (hospitaler) 3/Hierophant 1">
    <class name="Oracle (Dual-Cursed Oracle)" level="4" casterlevel="6" concentrationcheck="+11"/>
    <class name="Paladin (Hospitaler)" level="3" casterlevel="0" concentrationcheck="+3"/>
  </classes>
  <health hitdice="7 HD; 4d8+3d10+32" hitpoints="81" currenthp="81" nonlethal="0"/>
  <xp total="12000"/><money gp="4843" pp="0" sp="0" cp="0"/>
  <personal gender="Male" age="28"/>
  <languages><language name="Common"/><language name="Elven"/></languages>
  <attributes>
    <attribute name="Strength"><attrvalue base="16" modified="18"/></attribute>
    <attribute name="Dexterity"><attrvalue base="12" modified="12"/></attribute>
    <attribute name="Constitution"><attrvalue base="14" modified="16"/></attribute>
    <attribute name="Intelligence"><attrvalue base="12" modified="12"/></attribute>
    <attribute name="Wisdom"><attrvalue base="9" modified="7"/></attribute>
    <attribute name="Charisma"><attrvalue base="17" modified="21"/></attribute>
  </attributes>
  <saves>
    <save abbr="Fort" save="+14" base="+4" fromattr="+3" fromresist="+2" frommisc="+5"/>
    <save abbr="Ref" save="+10" base="+2" fromattr="+1" fromresist="+2" frommisc="+5"/>
    <save abbr="Will" save="+14" base="+7" fromattr="-2" fromresist="+2" frommisc="+7"/>
    <allsaves><situationalmodifiers text="+2 vs. enchantments"/></allsaves>
  </saves>
  <armorclass ac="27" touch="12" flatfooted="26" fromarmor="+12" fromdexterity="+1" fromnatural="+3" fromdeflect="+1"/>
  <penalties><penalty name="Armor Check Penalty" value="-5"/><penalty name="Max Dex Bonus" value="1"/></penalties>
  <maneuvers cmb="+10" cmd="22" cmdflatfooted="21"><maneuvertype name="Trip" cmb="+10" cmd="22"/></maneuvers>
  <initiative total="-3" attrtext="+1" misctext="+0"/>
  <movement><speed value="20"/><basespeed value="30"/></movement>
  <attack baseattack="+6" meleeattack="+10/+5" rangedattack="+7/+2"/>
  <melee>
    <weapon name="+3 greatsword" attack="+13/+8" crit="19-20/x2" damage="2d6+9" typetext="S" equipped="bothhands"/>
    <weapon name="Rapier" attack="+8/+3" crit="18-20/x2" damage="1d6+1" typetext="P"/>
  </melee>
  <ranged/>
  <skills>
    <skill name="Diplomacy" ranks="2" attrbonus="5" attrname="CHA" value="+12" classskill="yes"><description>Talk well.</description><situationalmodifiers text=""/></skill>
    <skill name="Climb" ranks="0" attrbonus="4" attrname="STR" value="-1" armorcheck="yes"><description>Climb things.</description><situationalmodifiers text=""/></skill>
  </skills>
  <feats><feat name="Extra Lay on Hands" categorytext="Class"><description>More healing.</description></feat><feat name="Fencing Grace"/></feats>
  <trackedresources>
    <trackedresource name="Smite Evil (1/day) (Su)" used="0" max="1"/>
    <trackedresource name="Wand of Healing (50 charges)" used="10" max="50"/>
  </trackedresources>
  <auras><special name="Aura of Courage (10 ft.) (Su)" shortname="Aura of Courage"/></auras>
  <otherspecials>
    <special name="Life Link (4 max bonds, 140 feet) (Su)" shortname="Life Link" sourcetext="Oracle"><description>Bond.</description></special>
  </otherspecials>
  <spellsknown>
    <spell name="Cure Light Wounds" level="1" class="Oracle" dc="16"><description>cures 1d8 points of damage + 1 point per caster level (maximum +5).</description></spell>
    <spell name="Cure Serious Wounds" level="3" class="Oracle"><description>Too high to cast yet.</description></spell>
  </spellsknown>
  <spellsmemorized><spell name="Cure Light Wounds (x2)" level="1" class="Oracle"/></spellsmemorized>
  <magicitems><item name="Mutagen: +4 Str, -2 Int, +2 Nat AC" quantity="1"/></magicitems>
  <gear><item name="Cognatogen: +4 Cha, -2 Wis, +2 Nat AC" quantity="1"/></gear>
  <spellclasses>
    <spellclass name="Oracle (Dual-Cursed Oracle)" maxspelllevel="2" spells="Spontaneous">
      <spelllevel level="0" unlimited="yes"/><spelllevel level="1" maxcasts="8"/><spelllevel level="2" maxcasts="4"/>
    </spellclass>
  </spellclasses>
  <minions><character name="Wolf">
    <attributes><attribute name="Strength"><attrvalue base="30" modified="30"/></attribute></attributes>
    <skills><skill name="Bite Stuff" ranks="9" attrname="STR" value="+20"/></skills>
  </character></minions>
</character></public></document>`;

describe("Hero Lab parser", () => {
    const c = parseHeroLabXml(XML);

    it("reads identity, classes and the mythic tier from the summary", () => {
        expect(c.identity).toMatchObject({ name: "Testa Brightblade", race: "half-elf", gender: "Male", age: "28" });
        expect(c.classes.map((k) => `${k.name} ${k.level}`)).toEqual([
            "Oracle (Dual-Cursed Oracle) 4",
            "Paladin (Hospitaler) 3",
        ]);
        expect(c.mythic).toEqual({ path: "Hierophant", tier: 1 });
        expect(c.identity.languages).toEqual(["Common", "Elven"]);
    });

    it("reads abilities with their base scores, and ignores the minion", () => {
        expect(c.abilities.str).toBe(18);
        expect(c.abilityBase?.str).toBe(16);
        expect(c.skills.map((s) => s.name)).toEqual(["Diplomacy", "Climb"]);
    });

    it("reads the paper sheet's breakdowns", () => {
        expect(c.combat.acParts).toMatchObject({ armor: 12, dex: 1, natural: 3, deflect: 1, shield: 0 });
        expect(c.combat.saves.will).toEqual({ base: 7, total: 14, ability: -2, resist: 2, misc: 7 });
        expect(c.combat.saveNotes).toBe("+2 vs. enchantments");
        expect(c.combat.initiativeParts).toEqual({ ability: 1, misc: 0 });
        expect(c.combat).toMatchObject({
            speed: 20,
            baseSpeed: 30,
            armorCheckPenalty: -5,
            maxDex: 1,
            cmdFlatFooted: 21,
        });
    });

    it("reads weapons, including two-handed ones", () => {
        expect(c.combat.attacks[0]).toMatchObject({
            name: "+3 greatsword",
            bonus: "+13/+8",
            damage: "2d6+9",
            twoHanded: true,
        });
        expect(c.combat.attacks[0]!.finesse).toBeUndefined();
        // +8 is nearer the ranged base attack (+7, Dex) than the melee one (+10, Str): a finesse weapon.
        expect(c.combat.attacks[1]).toMatchObject({ name: "Rapier", finesse: true, dexDamage: true });
    });

    it("lists only spells the class can cast now", () => {
        const oracle = c.spellcasting.find((s) => s.className.startsWith("Oracle"))!;
        expect(oracle.spells.map((s) => s.name)).toEqual(["Cure Light Wounds"]);
        expect(oracle.spells[0]).toMatchObject({ count: 2, prepared: true });
        expect(oracle.concentration).toBe(11);
        expect(oracle.spellsPerDay).toEqual({ 0: -1, 1: 8, 2: 4 });
    });

    it("finds resources and auras, including a range ability outside <auras>", () => {
        expect(c.resources?.map((r) => r.name)).toEqual(
            expect.arrayContaining(["Smite Evil (1/day) (Su)", "Wand of Healing (50 charges)"]),
        );
        expect(c.auras?.map((a) => `${a.name} ${a.radius}`)).toEqual(["Aura of Courage 10", "Life Link 140"]);
    });

    it("reads mutagens, and whether each was active in the export", () => {
        expect(c.importedAdjustments).toEqual([
            {
                key: "hl:mutagen-4-str-2-int-2-nat-ac",
                name: "Mutagen (+4 Str, -2 Int, +2 Nat AC)",
                effects: [
                    { target: "str", type: "alchemical", value: 4 },
                    { target: "int", type: "untyped", value: -2 },
                    { target: "ac", type: "natural", value: 2 },
                ],
                inExport: false, // Int isn't lowered
            },
            expect.objectContaining({ name: "Cognatogen (+4 Cha, -2 Wis, +2 Nat AC)", inExport: true }), // Wis 9 -> 7
        ]);
    });

    it("keeps skill rules text for the rule cards", () => {
        expect(c.skills[0]!.description).toBe("Talk well.");
        expect(c.skills[1]!.armorCheck).toBe(true);
    });

    it("rejects files that aren't Hero Lab exports", () => {
        expect(() => parseHeroLabXml("not xml <")).toThrow(HeroLabImportError);
        expect(() => parseHeroLabXml("<document/>")).toThrow(HeroLabImportError);
    });
});
