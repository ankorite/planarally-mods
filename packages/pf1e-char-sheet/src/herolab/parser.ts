// Parses a Hero Lab "Export As -> XML" file for Pathfinder 1e into our PF1Character shape.
//
// This is built directly against real exports (Hero Lab 8.9h, Pathfinder RPG data files),
// not the general HL schema docs, since HL's XML shape varies a fair bit by which game-system
// and community add-on packs the player has installed. The overall skeleton
// (document > public > character > ...) has been stable across HL versions for a long time,
// but individual @attribute names can differ if someone uses a heavily reconfigured data set.
// If an import comes back with holes, the first thing to check is whether the relevant element
// in the XML has a different attribute name than assumed below - the constants and small helpers
// here are deliberately kept in one place to make that easy to patch.
//
// IMPORTANT - minions/companions/mounts: a character can carry a full nested character block
// for an animal companion, eidolon, mount, etc. at <character><minions><character>...
// (confirmed from a real export with a mount). Every query in this file is scoped to the
// character's own DIRECT children (via the `own`/`ownAll` helpers below, using the CSS :scope
// combinator) specifically so it never descends into that nested subtree. A plain
// querySelectorAll would find the minion's <attributes>, <classes>, <skills>, etc. too, and
// since those come later in the document, they would silently overwrite or get appended after
// the real character's own data. Do not replace `own`/`ownAll` with plain `first`/`all` calls
// on `character` itself without re-checking this.
//
// Note on descriptions: feat/spell/item descriptions in the export are full reproductions of the
// rulebook text. We deliberately only keep a short excerpt (see `excerpt`) rather than importing
// the full text verbatim - it keeps the DataBlock small and fast to sync, and avoids duplicating
// large chunks of Paizo's copyrighted rules text into the campaign database.

import {
    abilityModifier,
    emptyCharacter,
    type AbilityKey,
    type AttackEntry,
    type FeatEntry,
    type InventoryItem,
    type PF1Character,
    type SheetAura,
    type SkillEntry,
    type SpecialEntry,
    type SpellEntry,
    type SpellcastingClass,
} from "../data";

const ABILITY_NAME_TO_KEY: Record<string, AbilityKey> = {
    Strength: "str",
    Dexterity: "dex",
    Constitution: "con",
    Intelligence: "int",
    Wisdom: "wis",
    Charisma: "cha",
};

const ABILITY_ABBR_TO_KEY: Record<string, AbilityKey> = {
    STR: "str",
    DEX: "dex",
    CON: "con",
    INT: "int",
    WIS: "wis",
    CHA: "cha",
};

/** Parses "+12", "-2", "12" etc into a number. Returns 0 for missing/unparsable input. */
function num(value: string | null | undefined): number {
    if (!value) return 0;
    const n = Number(value.replace(/[^\d.+-]/g, ""));
    return Number.isFinite(n) ? n : 0;
}

function attr(el: Element | null | undefined, name: string): string {
    return el?.getAttribute(name) ?? "";
}

/** The first DIRECT child of `el` matching `tag` - never a nested minion's. */
function own(el: Element | null | undefined, tag: string): Element | null {
    return el?.querySelector(`:scope > ${tag}`) ?? null;
}

/** All DIRECT children of `el` matching `tag` - never a nested minion's. */
function ownAll(el: Element | null | undefined, tag: string): Element[] {
    return el ? Array.from(el.querySelectorAll(`:scope > ${tag}`)) : [];
}

/** Keeps only the first paragraph of a description, capped in length. See file header note. */
function excerpt(text: string | null | undefined, maxLen = 240): string {
    if (!text) return "";
    const firstPara = text.split(/\n\s*\n/)[0]?.trim() ?? "";
    return firstPara.length > maxLen ? firstPara.slice(0, maxLen - 1) + "…" : firstPara;
}

/**
 * Full text for the hover tooltip. Unlike `excerpt`, this keeps every paragraph, only
 * collapsing repeated whitespace and applying a generous cap so one pathologically long
 * entry (some HL descriptions include full spell-progression tables) can't blow up the
 * DataBlock on its own.
 */
function fullText(text: string | null | undefined, maxLen = 4000): string {
    if (!text) return "";
    const cleaned = text.replace(/[ \t]+/g, " ").trim();
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + "…" : cleaned;
}

export class HeroLabImportError extends Error {}

export function parseHeroLabXml(xmlText: string): PF1Character {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");

    if (doc.querySelector("parsererror")) {
        throw new HeroLabImportError("This file isn't valid XML.");
    }

    const character = doc.querySelector("document > public > character");
    if (!character) {
        throw new HeroLabImportError(
            "Couldn't find a <character> element - is this a Hero Lab XML export?",
        );
    }

    const result = emptyCharacter();

    parseIdentity(character, result);
    parseClasses(character, result);
    parseAbilities(character, result);
    parseCombat(character, result);
    parseSkills(character, result);
    parseFeats(character, result);
    parseSpells(character, result);
    parseInventory(character, result);
    parseAuras(character, result);
    parseSpecials(character, result);

    result.importedAt = new Date().toISOString();

    return result;
}

function parseIdentity(character: Element, out: PF1Character): void {
    out.identity.name = attr(character, "name");
    out.identity.race = attr(own(character, "race"), "name");
    out.identity.alignment = attr(own(character, "alignment"), "name");
    out.identity.deity = attr(own(character, "deity"), "name");
    out.identity.size = attr(own(character, "size"), "name") || "Medium";
    out.identity.gender = attr(own(character, "personal"), "gender");

    out.currency.gp = num(attr(own(character, "money"), "gp"));
}

function parseClasses(character: Element, out: PF1Character): void {
    out.classes = ownAll(own(character, "classes"), "class").map((cls) => ({
        name: attr(cls, "name"),
        level: num(attr(cls, "level")),
        archetypes: [],
    }));
}

function parseAbilities(character: Element, out: PF1Character): void {
    for (const attribute of ownAll(own(character, "attributes"), "attribute")) {
        const key = ABILITY_NAME_TO_KEY[attr(attribute, "name")];
        if (!key) continue;
        const value = own(attribute, "attrvalue");
        // `modified` reflects the effective score including enhancement/inherent bonuses etc,
        // which is what HL shows on its own sheet as the character's current score.
        out.abilities[key] = num(attr(value, "modified")) || num(attr(value, "base"));
    }
}

function parseCombat(character: Element, out: PF1Character): void {
    const health = own(character, "health");
    out.combat.hp.max = num(attr(health, "hitpoints"));
    out.combat.hp.current = num(attr(health, "currenthp"));
    out.combat.hp.nonlethal = num(attr(health, "nonlethal"));

    const ac = own(character, "armorclass");
    out.combat.ac.normal = num(attr(ac, "ac"));
    out.combat.ac.touch = num(attr(ac, "touch"));
    out.combat.ac.flatFooted = num(attr(ac, "flatfooted"));

    for (const save of ownAll(own(character, "saves"), "save")) {
        const total = num(attr(save, "save"));
        const base = num(attr(save, "base"));
        const abbr = attr(save, "abbr").toLowerCase();
        if (abbr === "fort") out.combat.saves.fort = { base, total };
        else if (abbr === "ref") out.combat.saves.ref = { base, total };
        else if (abbr === "will") out.combat.saves.will = { base, total };
    }

    out.combat.bab = num(attr(own(character, "attack"), "baseattack"));

    const maneuvers = own(character, "maneuvers");
    out.combat.cmb = num(attr(maneuvers, "cmb"));
    out.combat.cmd = num(attr(maneuvers, "cmd"));

    out.combat.initiative = num(attr(own(character, "initiative"), "total"));
    // Current effective speed (already reduced for armor/load), matching HL's own sheet.
    out.combat.speed = num(attr(own(own(character, "movement"), "speed"), "value"));

    const attacks: AttackEntry[] = [
        ...ownAll(own(character, "melee"), "weapon"),
        ...ownAll(own(character, "ranged"), "weapon"),
    ].map((weapon) => ({
        name: attr(weapon, "name"),
        bonus: attr(weapon, "attack"),
        damage: attr(weapon, "damage"),
        critical: attr(weapon, "crit"),
        damageType: attr(weapon, "typetext"),
        notes: "",
    }));
    out.combat.attacks = attacks;
}

function parseSkills(character: Element, out: PF1Character): void {
    const skills: SkillEntry[] = [];
    for (const skill of ownAll(own(character, "skills"), "skill")) {
        const abilityAbbr = attr(skill, "attrname").toUpperCase();
        skills.push({
            name: attr(skill, "name"),
            ability: ABILITY_ABBR_TO_KEY[abilityAbbr] ?? "str",
            ranks: num(attr(skill, "ranks")),
            classSkill: attr(skill, "classskill") === "yes",
            trainedOnly: attr(skill, "trainedonly") === "yes",
            total: num(attr(skill, "value")),
            // HL doesn't expose a clean "misc only" breakdown; total is the source of truth,
            // this is just a best-effort remainder for display purposes.
            miscMod:
                num(attr(skill, "value")) -
                num(attr(skill, "ranks")) -
                abilityModifier(out.abilities[ABILITY_ABBR_TO_KEY[abilityAbbr] ?? "str"]) -
                (attr(skill, "classskill") === "yes" && num(attr(skill, "ranks")) > 0 ? 3 : 0),
        });
    }
    out.skills = skills;
}

function parseFeats(character: Element, out: PF1Character): void {
    const feats: FeatEntry[] = [];
    for (const feat of ownAll(own(character, "feats"), "feat")) {
        const text = own(feat, "description")?.textContent;
        feats.push({
            name: attr(feat, "name"),
            description: excerpt(text),
            fullText: fullText(text),
        });
    }
    out.feats = feats;
}

function parseSpells(character: Element, out: PF1Character): void {
    const spellsMemorized = own(character, "spellsmemorized");
    const spellNodes = [
        ...ownAll(own(character, "spellsknown"), "spell"),
        // Structure under a populated <spellsmemorized> is unverified (see README) - cast a
        // slightly wider net here, but still rooted at this character's OWN spellsmemorized,
        // never a minion's.
        ...(spellsMemorized ? Array.from(spellsMemorized.querySelectorAll("spell")) : []),
    ];
    const classNodes = ownAll(own(character, "classes"), "class");

    const casting: SpellcastingClass[] = [];
    for (const spellClass of ownAll(own(character, "spellclasses"), "spellclass")) {
        const className = attr(spellClass, "name");

        // The <class> element carries casterlevel/concentration; match it up by name.
        const matchingClass = classNodes.find((c) => attr(c, "name") === className);

        const spellsPerDay: Record<number, number> = {};
        for (const level of ownAll(spellClass, "spelllevel")) {
            const lvl = num(attr(level, "level"));
            spellsPerDay[lvl] =
                attr(level, "unlimited") === "yes" ? -1 : num(attr(level, "maxcasts"));
        }

        // <spell class="..."> uses the bare class name (e.g. "Oracle"), while spellclass/class
        // use the full name with archetype (e.g. "Oracle (Dual-Cursed Oracle)"). Match by prefix.
        const baseClassName = className.toLowerCase();
        const spells: SpellEntry[] = spellNodes
            .filter((s) => baseClassName.startsWith(attr(s, "class").toLowerCase()))
            .map((s) => {
                const text = own(s, "description")?.textContent;
                return {
                    name: attr(s, "name"),
                    level: num(attr(s, "level")),
                    description: excerpt(text),
                    fullText: fullText(text),
                    prepared: s.closest("spellsmemorized") !== null,
                };
            });

        casting.push({
            className,
            casterLevel: num(attr(matchingClass, "casterlevel")),
            concentration: num(attr(matchingClass, "concentrationcheck")),
            spellsPerDay,
            spells,
        });
    }
    out.spellcasting = casting;
}

function parseInventory(character: Element, out: PF1Character): void {
    const items: InventoryItem[] = [
        ...ownAll(own(character, "magicitems"), "item"),
        ...ownAll(own(character, "gear"), "item"),
    ].map((item) => {
        const cost = own(item, "cost");
        const weight = own(item, "weight");
        return {
            name: attr(item, "name"),
            quantity: num(attr(item, "quantity")) || 1,
            weight: num(attr(weight, "value")),
            notes: attr(cost, "text") ? `Cost: ${attr(cost, "text")}` : "",
        };
    });
    out.inventory = items;
}

// ---- auras -------------------------------------------------------------------------------
//
// Hero Lab's "Specials" tab lives in several containers under <character>. Two matter here:
//   <senses>  Darkvision (60 feet) / "Darkvision 60 ft." ...  -> a VISION aura on the token
//   <auras>   "Aura of Courage +4 (10 ft.) (Su)"              -> a visible radius aura
// (Both are read with `own`, so a mount's or companion's senses never become the rider's.)
// Senses with no range (Low-Light Vision, Scent, Deaf) and auras with no radius are skipped.

const FEET_RE = /(\d+)\s*[- ]?\s*(?:ft|feet|foot)\b/i;
const VISION_RE = /\b(darkvision|blindsight)\b[^0-9]{0,16}?(\d+)\s*[- ]?\s*(?:ft|feet|foot)\b/i;

function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseAuras(character: Element, out: PF1Character): void {
    const found = new Map<string, SheetAura>();
    const add = (kind: SheetAura["kind"], name: string, radius: number): void => {
        // The key ignores a "+4"-style bonus so the same aura keeps its identity (and gets updated,
        // not deleted and recreated) when the bonus changes with level.
        const key = `${kind}:${slug(name.replace(/\s*[+-]\d+\b/g, ""))}`;
        const existing = found.get(key);
        // Two sources of the same sense (race + a magic item): the better range wins.
        if (existing) existing.radius = Math.max(existing.radius, radius);
        else found.set(key, { key, name, kind, radius, uuid: "" });
    };

    for (const sp of ownAll(own(character, "senses"), "special")) {
        const m = VISION_RE.exec(`${attr(sp, "name")} ${attr(sp, "shortname")}`);
        if (m?.[1] && m[2]) {
            const sense = m[1].toLowerCase();
            add("vision", sense.charAt(0).toUpperCase() + sense.slice(1), Number(m[2]));
        }
    }

    for (const sp of ownAll(own(character, "auras"), "special")) {
        const full = attr(sp, "name");
        const radius = FEET_RE.exec(full) ?? FEET_RE.exec(attr(sp, "shortname"));
        if (!radius?.[1]) continue;
        // "Aura of Courage +4 (10 ft.) (Su)" -> the shortname "Aura of Courage" when there is one,
        // otherwise the name minus a trailing "(Su)"/"(Ex)"/"(Sp)".
        const name =
            attr(sp, "shortname") ||
            full
                .replace(/\s*\([^)]*\b(?:ft|feet|foot)\b[^)]*\)/gi, "")
                .replace(/\s*\((?:su|ex|sp)\)\s*$/i, "");
        add("effect", name.trim(), Number(radius[1]));
    }

    out.auras = Array.from(found.values());
}

// ---- specials ----------------------------------------------------------------------------
//
// Hero Lab's Specials tab is spread over several containers directly under <character>, each holding
// <special name shortname type sourcetext><description/></special>. All are read with `own`, so a
// mount's or companion's specials (they have their own containers under <minions>) never show up
// on the rider. Order here is the order they are displayed in.

const SPECIAL_CONTAINERS: [tag: string, category: string][] = [
    ["senses", "Senses"],
    ["auras", "Auras"],
    ["defensive", "Defensive abilities"],
    ["immunities", "Immunities"],
    ["resistances", "Resistances"],
    ["weaknesses", "Weaknesses"],
    ["damagereduction", "Damage reduction"],
    ["attack", "Offensive abilities"],
    ["spelllike", "Spell-like abilities"],
    ["otherspecials", "Other abilities"],
];

/** HL bookkeeping rows that carry no information. */
const SKIPPED_SPECIALS = /^equipment slots in use$/i;

function parseSpecials(character: Element, out: PF1Character): void {
    const specials: SpecialEntry[] = [];
    const seen = new Set<string>();

    for (const [tag, baseCategory] of SPECIAL_CONTAINERS) {
        for (const sp of ownAll(own(character, tag), "special")) {
            const name = attr(sp, "name").trim();
            if (!name || SKIPPED_SPECIALS.test(name)) continue;

            const type = attr(sp, "type").trim();
            // "Oracle, Oracle" (granted twice) -> "Oracle"
            const source = Array.from(
                new Set(
                    attr(sp, "sourcetext")
                        .split(",")
                        .map((part) => part.trim())
                        .filter(Boolean),
                ),
            ).join(", ");

            // "Other specials" is a catch-all that mixes class/race/trait abilities with magic items
            // and scrolls. Only abilities carry a type or a source, so that tells them apart.
            const category = tag === "otherspecials" && !type && !source ? "Items & equipment" : baseCategory;

            const key = `${category}|${name.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const text = own(sp, "description")?.textContent;
            specials.push({ name, category, type, source, description: excerpt(text), fullText: fullText(text) });
        }
    }
    out.specials = specials;
}
