// This is the shape of the data we persist in the character's ShapeDataBlock.
// It is intentionally a plain, serializable object (no Map/Set/class instances)
// so it survives JSON.stringify without needing a custom (de)serializer.
//
// It is also intentionally decoupled from Hero Lab's export format: the importer
// in `herolab/parser.ts` is responsible for translating a Hero Lab XML document
// into this shape. Nothing in the UI or in this file needs to know Hero Lab exists.

export interface AbilityScores {
    str: number;
    dex: number;
    con: number;
    int: number;
    wis: number;
    cha: number;
}

export type AbilityKey = keyof AbilityScores;

/** PF1 bonus types. Same-type bonuses don't stack (the highest applies), except the stacking ones. */
export type BonusType =
    | "untyped"
    | "alchemical"
    | "armor"
    | "circumstance"
    | "competence"
    | "deflection"
    | "dodge"
    | "enhancement"
    | "insight"
    | "luck"
    | "morale"
    | "natural"
    | "profane"
    | "resistance"
    | "sacred"
    | "shield"
    | "size";

/** What an adjustment changes. Ability keys change the score, and everything derived from it. */
export type AdjustmentTarget =
    | AbilityKey
    | "attack"
    | "meleeAttack"
    | "rangedAttack"
    | "damage"
    | "meleeDamage"
    | "ac"
    | "saves"
    | "fort"
    | "ref"
    | "will"
    | "skills"
    | "init"
    | "cmd"
    | "speed";

export interface AdjustmentEffect {
    target: AdjustmentTarget;
    type: BonusType;
    value: number;
}

/** An adjustment made on the sheet (the built-in ones live in adjustments.ts). */
export interface CustomAdjustment {
    id: string;
    name: string;
    effects: AdjustmentEffect[];
}

export interface AdjustmentState {
    /** Keys of the enabled adjustments: built-in keys, or custom ids. */
    enabled: string[];
    custom: CustomAdjustment[];
}

/** An aura the sheet derived from Hero Lab and (once synced) created on the token. */
export interface SheetAura {
    /** Stable identity across re-imports, e.g. "vision:darkvision" or "effect:aura-of-courage". */
    key: string;
    name: string;
    /** vision = a vision source (Darkvision); effect = a visible radius (Aura of Courage). */
    kind: "vision" | "effect";
    /** Radius in feet. */
    radius: number;
    /** PlanarAlly's uuid for the aura on the token; "" until it has been created. */
    uuid: string;
}

export interface ClassLevel {
    name: string;
    level: number;
    archetypes: string[];
}

export interface MythicTier {
    /** "Hierophant", "Archmage", ... */
    path: string;
    tier: number;
}

export interface SaveBlock {
    // The "base" save from class tables, before ability/misc modifiers.
    base: number;
    total: number;
    /** Hero Lab's breakdown: total = base + ability + resist + misc. Optional for older saves. */
    ability?: number;
    /** Resistance bonus (cloak of resistance and the like). */
    resist?: number;
    misc?: number;
}

/** Hero Lab's AC breakdown: AC = 10 + all of these. */
export interface AcParts {
    armor: number;
    shield: number;
    dex: number;
    size: number;
    natural: number;
    deflect: number;
    dodge: number;
    /** Hero Lab's misc plus any Wis/Cha bonus to AC (monk, oracle curses...). */
    misc: number;
}

/** One line of Hero Lab's combat maneuver list. */
export interface ManeuverEntry {
    name: string;
    cmb: number;
    cmd: number;
}

export interface AttackEntry {
    name: string;
    /** e.g. "+8/+3" for iterative attacks */
    bonus: string;
    /** e.g. "1d8+4" */
    damage: string;
    /** e.g. "19-20/x2" */
    critical: string;
    /** e.g. "S", "P", "B", "S/P" */
    damageType: string;
    /** Range increment of a ranged weapon, e.g. "30 ft."; empty or absent for melee. */
    range?: string;
    notes: string;
    /**
     * From Hero Lab's <melee> or <ranged> list: decides whether Str or Dex adjustments apply. Optional
     * because characters imported before this existed lack it (treated as melee).
     */
    kind?: "melee" | "ranged";
}

export interface SkillEntry {
    name: string;
    ability: AbilityKey;
    ranks: number;
    classSkill: boolean;
    miscMod: number;
    total: number;
    trainedOnly: boolean;
    /** Hero Lab's ability bonus for the skill. Optional for older saves. */
    abilityMod?: number;
    /** The armor check penalty applies. */
    armorCheck?: boolean;
    /** Hero Lab's rules text for the skill, shown on hover. Optional for older saves. */
    description?: string;
    /** Situational modifiers, e.g. "Speed greater/less than 30 ft.: -4 to jump". */
    situational?: string;
}

export interface FeatEntry {
    name: string;
    /** Short excerpt for the list view. */
    description: string;
    /** Full untruncated rules text, shown on hover. May be empty if not available. */
    fullText: string;
}

export interface SpellEntry {
    name: string;
    level: number;
    /** Short excerpt for the list view. */
    description: string;
    /** Full untruncated rules text, shown on hover. May be empty if not available. */
    fullText: string;
    /** true if prepared/known this is currently loaded into a slot (prepared casters) */
    prepared: boolean;
    /** Hero Lab's statblock fields; optional because spells imported before this lack them. */
    dc?: number;
    save?: string;
    range?: string;
    duration?: string;
    castTime?: string;
    school?: string;
}

export interface SpellcastingClass {
    className: string;
    casterLevel: number;
    concentration: number;
    /** spell level -> slots per day, e.g. { 0: 4, 1: 3, 2: 2 } */
    spellsPerDay: Record<number, number>;
    spells: SpellEntry[];
}

/**
 * A limited-use ability (x/day, x/round) or a spell level's slots per day, kept as a PlanarAlly
 * tracker on the token. Like auras, the sheet remembers the tracker it made by key -> uuid.
 */
export interface SheetResource {
    /** Stable identity across re-imports, e.g. "res:darkness" or "slots:oracle:1". */
    key: string;
    /** Tracker name, e.g. "Darkness (3/day)" or "Oracle level 1 slots". */
    name: string;
    max: number;
    /** Uses already spent in Hero Lab at export time (the starting point when `left` isn't set yet). */
    used: number;
    /**
     * Uses left, kept by the sheet whether or not the resource has a tracker on the token; while it
     * has one, the two are kept in step. Unset until first changed: then it is max - used.
     */
    left?: number;
    /** PlanarAlly's uuid for the tracker on the token; "" until it has been created. */
    uuid: string;
}

/** One entry from Hero Lab's Specials tab (senses, auras, defensive/offensive abilities, items...). */
export interface SpecialEntry {
    name: string;
    /** Display group, e.g. "Senses" or "Offensive abilities". */
    category: string;
    /** Hero Lab's own label, e.g. "Supernatural Ability"; empty when it has none. */
    type: string;
    /** What grants it - a class, race or trait, e.g. "Paladin"; empty for gear. */
    source: string;
    /** Short excerpt for the list view. */
    description: string;
    /** Full rules text, shown on hover. */
    fullText: string;
}

/** Groups specials by category, keeping the order in which each category first appears. */
export function groupSpecials(specials: SpecialEntry[]): { category: string; entries: SpecialEntry[] }[] {
    const groups = new Map<string, SpecialEntry[]>();
    for (const sp of specials) {
        const bucket = groups.get(sp.category);
        if (bucket) bucket.push(sp);
        else groups.set(sp.category, [sp]);
    }
    return Array.from(groups.entries()).map(([category, entries]) => ({ category, entries }));
}

export interface InventoryItem {
    name: string;
    quantity: number;
    weight: number;
    notes: string;
}

/** The Sheet tab's sections, in order, as the Config tab lists them: [key, label]. */
export const SHEET_SECTIONS = [
    ["abilities", "Abilities"],
    ["hp", "HP, initiative and speed"],
    ["ac", "Armor class"],
    ["saves", "Saving throws"],
    ["attack", "Base attack, CMB and CMD"],
    ["weapons", "Weapons"],
    ["skills", "Skills"],
    ["maneuvers", "Combat maneuvers"],
    ["languages", "Languages"],
    ["money", "Money and experience"],
] as const;
export type SheetSection = (typeof SHEET_SECTIONS)[number][0];

/**
 * What the Config tab hides. Everything is shown unless listed. A hidden weapon or skill is also left
 * out of the dice macros (its M box isn't on the sheet any more); hiding a section or tab only hides it.
 */
export interface SheetConfig {
    /** Weapon (attack) names. */
    hiddenWeapons?: string[];
    /** Skill names. */
    hiddenSkills?: string[];
    hiddenSections?: SheetSection[];
    /** Tab names, e.g. "Feats". The Sheet, Config and Diagnostics tabs can't be hidden. */
    hiddenTabs?: string[];
}

// Must be a `type` alias (not an `interface`): the mod API requires DataBlock data to satisfy
// Record<string, unknown>, and only type aliases get an implicit index signature.
export type PF1Character = {
    identity: {
        name: string;
        race: string;
        alignment: string;
        deity: string;
        size: string;
        gender: string;
        /** Optional: characters imported before the paper-style sheet lack these. */
        age?: string;
        hitDice?: string;
        languages?: string[];
    };
    classes: ClassLevel[];
    /** Mythic path and tier (Mythic Adventures); absent for a non-mythic character. */
    mythic?: MythicTier;
    abilities: AbilityScores;
    /** Scores before enhancement and other bonuses (Hero Lab's "16/18" is base/modified). Optional. */
    abilityBase?: AbilityScores;
    combat: {
        hp: { max: number; current: number; nonlethal: number };
        ac: { normal: number; touch: number; flatFooted: number };
        /** The paper sheet's breakdowns; all optional because older imports lack them. */
        acParts?: AcParts;
        saves: { fort: SaveBlock; ref: SaveBlock; will: SaveBlock };
        /** Situational save modifiers, e.g. "+2 vs. enchantments". */
        saveNotes?: string;
        bab: number;
        /** Hero Lab's attack lines, e.g. "+10/+5". */
        meleeAttack?: string;
        rangedAttack?: string;
        cmb: number;
        cmd: number;
        cmdFlatFooted?: number;
        maneuvers?: ManeuverEntry[];
        initiative: number;
        /** Initiative = ability + misc. */
        initiativeParts?: { ability: number; misc: number };
        armorCheckPenalty?: number;
        maxDex?: number;
        /** Effective land speed: after armor and load, as Hero Lab shows it. */
        speed: number;
        /** Speed before armor and load ("30/20" in Hero Lab is base/speed). Optional for older saves. */
        baseSpeed?: number;
        attacks: AttackEntry[];
    };
    skills: SkillEntry[];
    feats: FeatEntry[];
    spellcasting: SpellcastingClass[];
    inventory: InventoryItem[];
    currency: { gp: number; pp?: number; sp?: number; cp?: number };
    /** Experience points. Optional for older saves. */
    xp?: number;
    /**
     * Auras inferred from the Hero Lab specials (Darkvision, "Aura of Courage (10 ft.)" ...).
     * Optional because characters saved before this existed don't have it.
     */
    auras?: SheetAura[];
    /** Hero Lab's Specials tab. Optional because characters saved before this existed lack it. */
    specials?: SpecialEntry[];
    /**
     * Names of the skills exported as dice macros (chosen on the Sheet tab; kept across re-imports).
     * Optional because characters saved before this existed don't have it.
     */
    macroSkills?: string[];
    /**
     * Names of the attacks left out of the dice macros (unticked on the Sheet tab). Attacks are in by
     * default, so this lists exclusions; kept across re-imports. Optional for older saves.
     */
    macroExcludedAttacks?: string[];
    /** Tracked resources (x/day, x/round, spell slots). Optional for older saves. */
    resources?: SheetResource[];
    /**
     * Keys of the resources with Track ticked: only these get a tracker on the token. Resources are
     * untracked until ticked; kept across re-imports. Read it through trackedKeys() (resources.ts),
     * which also handles older saves.
     */
    trackedResources?: string[];
    /**
     * Older saves (before 0.22.0-beta.3): resources were tracked unless listed here. Only read to
     * carry an older sheet's choice over to `trackedResources`; never written any more.
     */
    untrackedResources?: string[];
    /**
     * The fixed roll macros switched off on the Sheet tab: "Initiative", "Fortitude", "Reflex",
     * "Will". They are exported unless listed here. Optional for older saves.
     */
    macroExcludedRolls?: string[];
    /**
     * Spells exported as dice macros: `enabled` holds spell keys (see spellKey in spells.ts) and
     * `formulas` any formula edited on the Spells tab. Optional for older saves.
     */
    spellMacros?: { enabled: string[]; formulas: Record<string, string> };
    /**
     * Adjustments (buffs, conditions) layered on top of the imported numbers; see adjustments.ts.
     * Optional because characters saved before this existed don't have it.
     */
    adjustments?: AdjustmentState;
    /** The Config tab's choices of what the sheet shows; kept across re-imports. Optional. */
    sheetConfig?: SheetConfig;
    notes: string;
    /** Free-form provenance so the sheet can show "last imported ..." */
    importedAt: string | undefined;
};

export function emptyCharacter(): PF1Character {
    return {
        identity: { name: "", race: "", alignment: "", deity: "", size: "Medium", gender: "" },
        classes: [],
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        combat: {
            hp: { max: 0, current: 0, nonlethal: 0 },
            ac: { normal: 10, touch: 10, flatFooted: 10 },
            saves: {
                fort: { base: 0, total: 0 },
                ref: { base: 0, total: 0 },
                will: { base: 0, total: 0 },
            },
            bab: 0,
            cmb: 0,
            cmd: 10,
            initiative: 0,
            speed: 30,
            attacks: [],
        },
        skills: [],
        feats: [],
        spellcasting: [],
        inventory: [],
        currency: { gp: 0 },
        auras: [],
        specials: [],
        macroSkills: [],
        macroExcludedAttacks: [],
        adjustments: { enabled: [], custom: [] },
        resources: [],
        trackedResources: [],
        macroExcludedRolls: [],
        spellMacros: { enabled: [], formulas: {} },
        notes: "",
        importedAt: undefined,
    };
}

export function abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
}

// Name of the ShapeDataBlock we store the character on. Kept in one place
// so the sheet component and the importer agree on it.
export const DATA_BLOCK_NAME = "pf1e-character";
