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
// Simplifications: an ability change adds its modifier difference to what that ability feeds (melee
// attack/damage and CMB for Str, ranged attack, AC, Ref, initiative and CMD for Dex, Fort for Con,
// Will for Wis, and skills) - but not HP, and Str to damage is always x1 (not x1.5 two-handed).
// Situational parts ("+2 vs fear") are left out.

export interface AdjustmentDef {
    key: string;
    name: string;
    group: "Spells" | "Class abilities" | "Combat" | "Conditions";
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

const forTargets = (effects: AdjustmentEffect[], ...targets: AdjustmentTarget[]): AdjustmentEffect[] =>
    effects.filter((e) => targets.includes(e.target));

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

/** The enabled adjustments of a character, built-in and custom, in a stable order. */
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
    return [...BUILTIN_ADJUSTMENTS, ...custom].filter((a) => on.has(a.key));
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
 * The character with its enabled adjustments applied. Returns the character itself (not a copy)
 * when nothing is enabled. Current HP is never touched: it belongs to the tracker.
 */
export function applyAdjustments(c: PF1Character): PF1Character {
    const active = enabledAdjustments(c);
    if (!active.length) return c;
    const effects = active.flatMap((a) => a.effects);
    const extraAttack = active.some((a) => a.extraAttack);
    const out: PF1Character = JSON.parse(JSON.stringify(c)) as PF1Character;

    // Ability scores, and how much each modifier moved.
    const modDelta = {} as Record<AbilityKey, number>;
    for (const k of ABILITIES) {
        const before = c.abilities[k];
        const after = before + stackEffects(forTargets(effects, k));
        out.abilities[k] = after;
        modDelta[k] = abilityModifier(after) - abilityModifier(before);
    }

    // AC, per bonus type so each lands on the right AC values.
    const acEffects = forTargets(effects, "ac");
    const acBy = (keep: (t: BonusType) => boolean): number => stackEffects(acEffects.filter((e) => keep(e.type)));
    const ac = acBy(() => true);
    out.combat.ac.normal += ac + modDelta.dex;
    out.combat.ac.touch += acBy((t) => !NOT_TOUCH.has(t)) + modDelta.dex;
    out.combat.ac.flatFooted += acBy((t) => !NOT_FLAT_FOOTED.has(t)) + Math.min(0, modDelta.dex);

    // Saves.
    const save = (k: "fort" | "ref" | "will", ability: AbilityKey): number =>
        stackEffects(forTargets(effects, "saves", k)) + modDelta[ability];
    out.combat.saves.fort.total += save("fort", "con");
    out.combat.saves.ref.total += save("ref", "dex");
    out.combat.saves.will.total += save("will", "wis");

    out.combat.initiative += stackEffects(forTargets(effects, "init")) + modDelta.dex;
    out.combat.speed += stackEffects(forTargets(effects, "speed"));

    // Attacks and combat maneuvers.
    const meleeAttack = stackEffects(forTargets(effects, "attack", "meleeAttack")) + modDelta.str;
    const rangedAttack = stackEffects(forTargets(effects, "attack", "rangedAttack")) + modDelta.dex;
    const meleeDamage = stackEffects(forTargets(effects, "damage", "meleeDamage")) + modDelta.str;
    const rangedDamage = stackEffects(forTargets(effects, "damage"));
    out.combat.cmb += meleeAttack;
    out.combat.cmd +=
        stackEffects(forTargets(effects, "cmd")) +
        stackEffects(acEffects.filter((e) => CMD_TYPES.has(e.type))) +
        modDelta.str +
        modDelta.dex;
    for (const atk of out.combat.attacks) {
        const ranged = atk.kind === "ranged";
        atk.bonus = adjustAttackBonus(atk.bonus, ranged ? rangedAttack : meleeAttack, extraAttack);
        atk.damage = adjustDamage(atk.damage, ranged ? rangedDamage : meleeDamage);
    }

    // Skills.
    const skills = stackEffects(forTargets(effects, "skills"));
    for (const skill of out.skills) skill.total += skills + modDelta[skill.ability];

    return out;
}
