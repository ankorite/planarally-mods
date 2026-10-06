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

export interface SaveBlock {
    // The "base" save from class tables, before ability/misc modifiers.
    base: number;
    total: number;
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
    notes: string;
}

export interface SkillEntry {
    name: string;
    ability: AbilityKey;
    ranks: number;
    classSkill: boolean;
    miscMod: number;
    total: number;
    trainedOnly: boolean;
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
}

export interface SpellcastingClass {
    className: string;
    casterLevel: number;
    concentration: number;
    /** spell level -> slots per day, e.g. { 0: 4, 1: 3, 2: 2 } */
    spellsPerDay: Record<number, number>;
    spells: SpellEntry[];
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
    };
    classes: ClassLevel[];
    abilities: AbilityScores;
    combat: {
        hp: { max: number; current: number; nonlethal: number };
        ac: { normal: number; touch: number; flatFooted: number };
        saves: { fort: SaveBlock; ref: SaveBlock; will: SaveBlock };
        bab: number;
        cmb: number;
        cmd: number;
        initiative: number;
        speed: number;
        attacks: AttackEntry[];
    };
    skills: SkillEntry[];
    feats: FeatEntry[];
    spellcasting: SpellcastingClass[];
    inventory: InventoryItem[];
    currency: { gp: number };
    /**
     * Auras inferred from the Hero Lab specials (Darkvision, "Aura of Courage (10 ft.)" ...).
     * Optional because characters saved before this existed don't have it.
     */
    auras?: SheetAura[];
    /** Hero Lab's Specials tab. Optional because characters saved before this existed lack it. */
    specials?: SpecialEntry[];
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
