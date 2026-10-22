import {
    abilityModifier,
    type AbilityKey,
    type AdjustmentEffect,
    type AdjustmentTarget,
    type BonusType,
    type PF1Character,
} from "./data";

// Adjustments: buffs, class abilities and conditions layered on top of the imported numbers, like
// Hero Lab's Adjust tab. Hero Lab's own adjustments can't be read from its XML export (only their
// combined result is in the numbers), so the character should be exported with them switched OFF
// and switched on here instead, or they'd count twice.
//
// `applyAdjustments` returns an adjusted copy of the character. The sheet shows that copy, and its
// roll buttons and the Custom Data export (dice macros) use it, so toggling an adjustment changes
// every number and roll at once.
//
// Mutagens are the exception: Hero Lab exports them as items, so they're read from the file
// (ImportedAdjustment), along with whether they were active - then their effect is already in the
// numbers, and switching one off takes it back out.
//
// Simplifications: an ability change adds its modifier difference to what that ability feeds (melee
// attack/damage and CMB for Str - or Dex for a finesse weapon, ranged attack, AC, Ref, initiative and CMD for Dex, Fort and max HP
// for Con, Will for Wis, and skills). Situational parts ("+2 vs fear") are left out.

export interface AdjustmentDef {
    key: string;
    name: string;
    group: "From Hero Lab" | "Spells" | "Class abilities" | "Combat" | "Conditions";
    effects: AdjustmentEffect[];
    /** Haste: one extra attack at the highest bonus on a full attack. */
    extraAttack?: boolean;
}

const fx = (target: AdjustmentTarget, type: BonusType, value: number): AdjustmentEffect => ({ target, type, value });

const inspireCourage = (n: number): AdjustmentDef => ({
    key: `inspire-courage-${n}`,
    name: `Inspire Courage +${n}`,
    group: "Class abilities",
    effects: [fx("attack", "competence", n), fx("damage", "competence", n)],
});

const abilityBuff = (key: string, name: string, ability: AbilityKey): AdjustmentDef => ({
    key,
    name,
    group: "Spells",
    effects: [fx(ability, "enhancement", 4)],
});

export const BUILTIN_ADJUSTMENTS: AdjustmentDef[] = [
    { key: "bless", name: "Bless", group: "Spells", effects: [fx("attack", "morale", 1)] },
    {
        key: "prayer",
        name: "Prayer",
        group: "Spells",
        effects: [fx("attack", "luck", 1), fx("damage", "luck", 1), fx("saves", "luck", 1), fx("skills", "luck", 1)],
    },
    {
        key: "haste",
        name: "Haste",
        group: "Spells",
        effects: [
            fx("attack", "untyped", 1),
            fx("ac", "dodge", 1),
            fx("ref", "dodge", 1),
            fx("speed", "enhancement", 30),
        ],
        extraAttack: true,
    },
    {
        key: "heroism",
        name: "Heroism",
        group: "Spells",
        effects: [fx("attack", "morale", 2), fx("saves", "morale", 2), fx("skills", "morale", 2)],
    },
    {
        key: "greater-heroism",
        name: "Heroism, Greater",
        group: "Spells",
        effects: [fx("attack", "morale", 4), fx("saves", "morale", 4), fx("skills", "morale", 4)],
    },
    {
        key: "good-hope",
        name: "Good Hope",
        group: "Spells",
        effects: [
            fx("attack", "morale", 2),
            fx("damage", "morale", 2),
            fx("saves", "morale", 2),
            fx("skills", "morale", 2),
        ],
    },
    {
        key: "divine-favor",
        name: "Divine Favor (+1)",
        group: "Spells",
        effects: [fx("attack", "luck", 1), fx("damage", "luck", 1)],
    },
    { key: "shield-of-faith", name: "Shield of Faith (+2)", group: "Spells", effects: [fx("ac", "deflection", 2)] },
    {
        key: "holy-aura",
        name: "Holy Aura",
        group: "Spells",
        effects: [fx("ac", "deflection", 4), fx("saves", "resistance", 4)],
    },
    { key: "mage-armor", name: "Mage Armor", group: "Spells", effects: [fx("ac", "armor", 4)] },
    { key: "shield", name: "Shield", group: "Spells", effects: [fx("ac", "shield", 4)] },
    { key: "barkskin", name: "Barkskin (+2)", group: "Spells", effects: [fx("ac", "natural", 2)] },
    abilityBuff("bulls-strength", "Bull's Strength", "str"),
    abilityBuff("cats-grace", "Cat's Grace", "dex"),
    abilityBuff("bears-endurance", "Bear's Endurance", "con"),
    abilityBuff("foxs-cunning", "Fox's Cunning", "int"),
    abilityBuff("owls-wisdom", "Owl's Wisdom", "wis"),
    abilityBuff("eagles-splendor", "Eagle's Splendor", "cha"),
    {
        key: "enlarge-person",
        name: "Enlarge Person",
        group: "Spells",
        effects: [fx("str", "size", 2), fx("dex", "size", -2), fx("attack", "size", -1), fx("ac", "size", -1)],
    },
    {
        key: "reduce-person",
        name: "Reduce Person",
        group: "Spells",
        effects: [fx("str", "size", -2), fx("dex", "size", 2), fx("attack", "size", 1), fx("ac", "size", 1)],
    },
    inspireCourage(1),
    inspireCourage(2),
    inspireCourage(3),
    inspireCourage(4),
    {
        key: "rage",
        name: "Rage",
        group: "Class abilities",
        effects: [fx("str", "morale", 4), fx("con", "morale", 4), fx("will", "morale", 2), fx("ac", "untyped", -2)],
    },
    { key: "flanking", name: "Flanking", group: "Combat", effects: [fx("meleeAttack", "untyped", 2)] },
    {
        key: "charging",
        name: "Charging",
        group: "Combat",
        effects: [fx("meleeAttack", "untyped", 2), fx("ac", "untyped", -2)],
    },
    {
        key: "fighting-defensively",
        name: "Fighting Defensively",
        group: "Combat",
        effects: [fx("attack", "untyped", -4), fx("ac", "dodge", 2)],
    },
    {
        key: "shaken",
        name: "Shaken",
        group: "Conditions",
        effects: [fx("attack", "untyped", -2), fx("saves", "untyped", -2), fx("skills", "untyped", -2)],
    },
    {
        key: "sickened",
        name: "Sickened",
        group: "Conditions",
        effects: [
            fx("attack", "untyped", -2),
            fx("damage", "untyped", -2),
            fx("saves", "untyped", -2),
            fx("skills", "untyped", -2),
        ],
    },
    {
        key: "fatigued",
        name: "Fatigued",
        group: "Conditions",
        effects: [fx("str", "untyped", -2), fx("dex", "untyped", -2)],
    },
];

export const BONUS_TYPES: BonusType[] = [
    "untyped",
    "alchemical",
    "armor",
    "circumstance",
    "competence",
    "deflection",
    "dodge",
    "enhancement",
    "insight",
    "luck",
    "morale",
    "natural",
    "profane",
    "resistance",
    "sacred",
    "shield",
    "size",
];

export const TARGET_LABELS: Record<AdjustmentTarget, string> = {
    str: "STR",
    dex: "DEX",
    con: "CON",
    int: "INT",
    wis: "WIS",
    cha: "CHA",
    attack: "Attack",
    meleeAttack: "Melee attack",
    rangedAttack: "Ranged attack",
    damage: "Damage",
    meleeDamage: "Melee damage",
    ac: "AC",
    saves: "All saves",
    fort: "Fort",
    ref: "Ref",
    will: "Will",
    skills: "Skills",
    init: "Initiative",
    cmd: "CMD",
    speed: "Speed",
};

/** "+1 morale Attack, +1 dodge AC". */
export function describeEffects(effects: AdjustmentEffect[], extraAttack = false): string {
    const parts = effects.map(
        (e) =>
            `${e.value >= 0 ? "+" : ""}${e.value}${e.type === "untyped" ? "" : ` ${e.type}`} ${TARGET_LABELS[e.target]}`,
    );
    if (extraAttack) parts.push("extra attack");
    return parts.join(", ");
}

// ---- stacking ---------------------------------------------------------------------------------------

/** Bonus types that stack with themselves (PF1 core rules). */
const STACKING: ReadonlySet<BonusType> = new Set(["untyped", "dodge", "circumstance"]);

/**
 * The combined value of some effects: per bonus type, stacking types add up while any other type
 * only counts its highest bonus. Penalties always add up.
 */
export function stackEffects(effects: AdjustmentEffect[]): number {
    const best = new Map<BonusType, number>();
    let total = 0;
    for (const e of effects) {
        if (e.value < 0 || STACKING.has(e.type)) total += e.value;
        else best.set(e.type, Math.max(best.get(e.type) ?? 0, e.value));
    }
    for (const v of best.values()) total += v;
    return total;
}

// AC: armor / shield / natural don't apply to touch AC; dodge (and Dex) don't apply to flat-footed AC.
// CMD takes the AC bonus types that also protect against maneuvers.
const NOT_TOUCH: ReadonlySet<BonusType> = new Set(["armor", "shield", "natural"]);
const NOT_FLAT_FOOTED: ReadonlySet<BonusType> = new Set(["dodge"]);
const CMD_TYPES: ReadonlySet<BonusType> = new Set([
    "circumstance",
    "deflection",
    "dodge",
    "insight",
    "luck",
    "morale",
    "profane",
    "sacred",
    "untyped",
]);

// ---- applying ----------------------------------------------------------------------------------------

/** The adjustments read from the export (mutagens), as adjustments. */
export function importedAdjustments(c: Pick<PF1Character, "importedAdjustments">): AdjustmentDef[] {
    return (c.importedAdjustments ?? []).map((a) => ({
        key: a.key,
        name: a.name,
        group: "From Hero Lab",
        effects: a.effects,
    }));
}

/** The enabled adjustments of a character - from the export, built-in and custom - in a stable order. */
export function enabledAdjustments(c: PF1Character): AdjustmentDef[] {
    const state = c.adjustments;
    if (!state?.enabled.length) return [];
    const on = new Set(state.enabled);
    const custom: AdjustmentDef[] = state.custom.map((a) => ({
        key: a.id,
        name: a.name,
        group: "Spells",
        effects: a.effects,
    }));
    return [...importedAdjustments(c), ...BUILTIN_ADJUSTMENTS, ...custom].filter((a) => on.has(a.key));
}

const ABILITIES: AbilityKey[] = ["str", "dex", "con", "int", "wis", "cha"];

const fmtBonus = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** Each iterative bonus shifted by `delta`, plus a duplicate of the first for an extra attack. */
function adjustAttackBonus(text: string, delta: number, extraAttack: boolean): string {
    if (delta === 0 && !extraAttack) return text;
    const bonuses = text
        .replace(/\([^)]*\)/g, "")
        .split("/")
        .map((part) => /[+-]?\d+/.exec(part)?.[0])
        .filter((b): b is string => b !== undefined)
        .map((b) => Number(b) + delta);
    if (!bonuses.length) return text;
    if (extraAttack) bonuses.unshift(bonuses[0]!);
    return bonuses.map(fmtBonus).join("/");
}

/** Shifts the flat modifier of the leading dice formula: ("2d6+4 plus grab", +2) -> "2d6+6 plus grab". */
function adjustDamage(text: string, delta: number): string {
    if (delta === 0) return text;
    const lead = leadingDamage(text);
    if (!lead) return text;
    // Keep every dice term; fold the flat terms and the adjustment into one number at the end.
    const terms = lead.formula.match(/[+-]?\d+(?:d\d+)?/gi) ?? [];
    const dice = terms.filter((t) => /d/i.test(t));
    const flat = terms.filter((t) => !/d/i.test(t)).reduce((sum, t) => sum + Number(t), 0) + delta;
    const diceText = dice.map((t, i) => (i === 0 ? t.replace(/^\+/, "") : /^[+-]/.test(t) ? t : `+${t}`)).join("");
    return `${diceText}${flat === 0 ? "" : fmtBonus(flat)}${lead.rest}`;
}

/**
 * The dice formula a Hero Lab damage text starts with, and what follows it: "2d6+4 plus grab" ->
 * "2d6+4" and " plus grab"; "1d8+2d6+3 fire" -> "1d8+2d6+3" and " fire". A chain of terms after the
 * first dice, so a second dice term ("+2d6") isn't mistaken for a flat "+2".
 */
export function leadingDamage(text: string): { formula: string; rest: string } | undefined {
    const m = /^\s*\d+\s*d\s*\d+(?:\s*[+-]\s*\d+(?:\s*d\s*\d+)?)*/i.exec(text);
    if (!m) return undefined;
    return { formula: m[0].replace(/\s+/g, ""), rest: text.slice(m[0].length) };
}

/**
 * The character's hit dice: from Hero Lab's "7 HD; 4d8+3d10+32", else the sum of its class levels.
 * Mythic tiers aren't hit dice.
 */
export function hitDice(c: Pick<PF1Character, "identity" | "classes">): number {
    const m = /(\d+)\s*HD\b/i.exec(c.identity.hitDice ?? "");
    if (m) return Number(m[1]);
    return c.classes.reduce((n, cls) => n + (Number.isFinite(cls.level) ? cls.level : 0), 0);
}

/**
 * The character with its enabled adjustments applied. Returns the character itself (not a copy)
 * when nothing is enabled. Current HP is never touched: it belongs to the tracker.
 */
export function applyAdjustments(c: PF1Character): PF1Character {
    const active = enabledAdjustments(c);
    // What the imported numbers already include: the mutagens Hero Lab had active.
    const baked = (c.importedAdjustments ?? []).filter((a) => a.inExport).flatMap((a) => a.effects);
    if (!active.length && !baked.length) return c;
    const effects = active.flatMap((a) => a.effects);
    const extraAttack = active.some((a) => a.extraAttack);
    const out: PF1Character = JSON.parse(JSON.stringify(c)) as PF1Character;

    // Every change is "what's switched on" minus "what the export already counts", each stacked by the
    // PF1 rules - so a mutagen that's on and in the export changes nothing, and switched off it's
    // taken out, while a buff of the same bonus type stacks against it correctly.
    const net = (pick: (e: AdjustmentEffect) => boolean): number =>
        stackEffects(effects.filter(pick)) - stackEffects(baked.filter(pick));
    const of =
        (...targets: AdjustmentTarget[]) =>
        (e: AdjustmentEffect): boolean =>
            targets.includes(e.target);

    // Ability scores, and how much each modifier moved.
    const modDelta = {} as Record<AbilityKey, number>;
    for (const k of ABILITIES) {
        const before = c.abilities[k];
        const after = before + net(of(k));
        out.abilities[k] = after;
        modDelta[k] = abilityModifier(after) - abilityModifier(before);
    }

    // AC, per bonus type so each lands on the right AC values. A Dex change only counts up to the armor's
    // maximum Dex bonus (Hero Lab's "Max Dex Bonus" penalty), as Hero Lab's own AC does.
    const acBy = (keep: (t: BonusType) => boolean): number => net((e) => e.target === "ac" && keep(e.type));
    const ac = acBy(() => true);
    const maxDex = c.combat.maxDex;
    const dexToAc = (score: number): number => {
        const mod = abilityModifier(score);
        return maxDex === undefined ? mod : Math.min(mod, maxDex);
    };
    const acDex = dexToAc(out.abilities.dex) - dexToAc(c.abilities.dex);
    out.combat.ac.normal += ac + acDex;
    out.combat.ac.touch += acBy((t) => !NOT_TOUCH.has(t)) + acDex;
    // Flat-footed AC has no Dex bonus, only a Dex penalty: it changes only as far as the modifier is below 0.
    const ffDex = Math.min(0, dexToAc(out.abilities.dex)) - Math.min(0, dexToAc(c.abilities.dex));
    out.combat.ac.flatFooted += acBy((t) => !NOT_FLAT_FOOTED.has(t)) + ffDex;

    // Max HP follows a Constitution change: the change in modifier for every hit die. (Current HP is the
    // tracker's and isn't touched.)
    out.combat.hp.max += modDelta.con * hitDice(c);

    // Saves.
    const save = (k: "fort" | "ref" | "will", ability: AbilityKey): number => net(of("saves", k)) + modDelta[ability];
    out.combat.saves.fort.total += save("fort", "con");
    out.combat.saves.ref.total += save("ref", "dex");
    out.combat.saves.will.total += save("will", "wis");

    out.combat.initiative += net(of("init")) + modDelta.dex;
    out.combat.speed += net(of("speed"));

    // Attacks and combat maneuvers.
    const meleeAttack = net(of("attack", "meleeAttack")) + modDelta.str;
    const rangedAttack = net(of("attack", "rangedAttack")) + modDelta.dex;
    const meleeDamage = net(of("damage", "meleeDamage"));
    // Strength to damage: 1x, or 1.5x a bonus for a two-handed weapon (a penalty is never multiplied).
    const strToDamage = (score: number, twoHanded: boolean): number => {
        const mod = abilityModifier(score);
        return twoHanded && mod > 0 ? Math.floor(mod * 1.5) : mod;
    };
    const strDamage = (twoHanded: boolean): number =>
        strToDamage(out.abilities.str, twoHanded) - strToDamage(c.abilities.str, twoHanded);
    const rangedDamage = net(of("damage"));
    out.combat.cmb += meleeAttack;
    out.combat.cmd += net(of("cmd")) + acBy((t) => CMD_TYPES.has(t)) + modDelta.str + modDelta.dex;
    // A finesse weapon (see markDexWeapons in the parser) attacks with Dex, and may add Dex to damage.
    const finesseAttack = meleeAttack - modDelta.str + modDelta.dex;
    for (const atk of out.combat.attacks) {
        const ranged = atk.kind === "ranged";
        const attack = ranged ? rangedAttack : atk.finesse ? finesseAttack : meleeAttack;
        atk.bonus = adjustAttackBonus(atk.bonus, attack, extraAttack);
        const damage = ranged
            ? rangedDamage
            : meleeDamage + (atk.dexDamage ? modDelta.dex : strDamage(atk.twoHanded === true));
        atk.damage = adjustDamage(atk.damage, damage);
    }

    // Skills.
    const skills = net(of("skills"));
    for (const skill of out.skills) skill.total += skills + modDelta[skill.ability];

    return out;
}
