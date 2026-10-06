import type { GameApi, LocalId } from "@planarally/mod-api";

import { abilityModifier, type AbilityKey, type PF1Character } from "./data";

// Writes the sheet into the token's Custom Data, so PlanarAlly's own dice panel can use it.
//
// What this is built on (read from PA's bundle by the diagnostics scan, not guessed):
//   * An element is { shapeId, source, prefix, name, kind, value, reference, description }, with
//     kind one of "number" | "text" | "boolean" | "dice-expression". Elements are identified by
//     (source, prefix, name), case-insensitively. We use our own `source` so we never touch anything
//     made in PA's UI (source "planarally").
//   * PA's dice panel resolves `{name}`, `{prefix/name}` or `{[shapeId]name}` inside a formula against
//     the Custom Data of the selected/focused token. A variable matches an element's `name` (or its
//     `reference` alias, when set) after stripping every character outside [\w /] - which is why
//     every name here is plain letters, digits, underscores and spaces.
//   * A "dice-expression" element can reference other elements, and PA expands those RECURSIVELY.
//     An element that (even indirectly) references itself would recurse forever, so names are unique
//     across every prefix, and the "Roll ..." expressions only reference number elements.
//   * Clicking a dice-expression element in the Custom Data tab opens PA's dice panel with the
//     expression filled in; Enter rolls it natively (3D dice, "share with", toast for other players).

export const CD_SOURCE = "pf1e-sheet";

export type CdKind = "number" | "dice-expression";

export interface CdElement {
    prefix: string;
    name: string;
    kind: CdKind;
    value: number | string;
}

/** Variable names may only contain [\w /]; "/" is the path separator, so it is dropped too. */
export function cdName(raw: string): string {
    return raw
        .replace(/[^\w ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** A caster class without its archetype: "Oracle (Dual-Cursed Oracle)" -> "Oracle". */
function baseClass(name: string): string {
    return cdName(name.replace(/\s*\(.*$/, ""));
}

/** First bonus in a piece of text: "+13" -> 13. */
function firstBonus(text: string): number | undefined {
    const m = /[+-]?\d+/.exec(text);
    return m ? Number(m[0]) : undefined;
}

/** Every bonus of an iterative attack string, in order: "+13/+8/+3" -> [13, 8, 3]. */
export function iterativeBonuses(text: string): number[] {
    return text
        .replace(/\([^)]*\)/g, "")
        .split("/")
        .map(firstBonus)
        .filter((b): b is number => b !== undefined);
}

/** "1st", "2nd", "3rd", "4th" ... */
export function ordinal(n: number): string {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** `{Spellcraft}`: PA's variable syntax for "the Custom Data field with this name". */
export const field = (name: string): string => `{${name}}`;

/** A d20 check using a Custom Data field for its modifier: `1d20 + {STR mod}`. */
export const checkFormula = (fieldName: string): string => `1d20 + ${field(fieldName)}`;

/**
 * An iterative attack: a d20 check on the weapon's first-attack field, shifted by this attack's offset
 * from it: `1d20 + {Atk greatsword} - 5`. Every attack follows an edit of that one field.
 */
export function attackFormula(fieldName: string, offset: number): string {
    if (offset === 0) return checkFormula(fieldName);
    return `${checkFormula(fieldName)} ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}`;
}

/**
 * The exact names of the fields the sheet's buttons roll against, as exported. They are read back from
 * the same builder rather than guessed, because names are de-duplicated and sanitised ("Knowledge
 * (arcana)" -> "Knowledge arcana"), so the button must use whatever name the field actually got.
 */
export interface SheetNames {
    abilityMod: Record<AbilityKey, string>;
    init: string;
    fort: string;
    ref: string;
    will: string;
    cmb: string;
    /** One per entry of `character.skills`, same order. */
    skills: string[];
    /**
     * One per entry of `character.combat.attacks`, same order. `atk` is the first attack's field (missing
     * means nothing to roll); `offsets` has one entry per iterative attack, relative to it ([0, -5, -10]).
     */
    attacks: { atk?: string; offsets: number[]; dmg?: string }[];
}

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"] as const;

/** The elements this sheet exports, in a stable order, plus the names its buttons need. */
export function buildSheet(c: PF1Character): { elements: CdElement[]; names: SheetNames } {
    const out: CdElement[] = [];
    const used = new Set<string>();

    /** Adds an element and returns the (possibly de-duplicated) name it was given. */
    const add = (prefix: string, rawName: string, kind: CdKind, value: number | string): string => {
        const base = cdName(rawName) || "Unnamed";
        let name = base;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
        used.add(name.toLowerCase());
        out.push({ prefix, name, kind, value });
        return name;
    };
    const num = (v: number): number => (Number.isFinite(v) ? v : 0);

    // --- numbers other formulas can use: {STR mod}, {Fort}, {Spellcraft} ... ---
    const abilityMod = {} as Record<AbilityKey, string>;
    for (const key of ABILITY_KEYS) {
        const label = key.toUpperCase();
        const score = num(c.abilities[key]);
        add("/abilities", label, "number", score);
        abilityMod[key] = add("/abilities", `${label} mod`, "number", abilityModifier(score));
    }

    const init = add("/combat", "Init", "number", num(c.combat.initiative));
    const fort = add("/combat", "Fort", "number", num(c.combat.saves.fort.total));
    const refl = add("/combat", "Ref", "number", num(c.combat.saves.ref.total));
    const will = add("/combat", "Will", "number", num(c.combat.saves.will.total));
    add("/combat", "BAB", "number", num(c.combat.bab));
    const cmb = add("/combat", "CMB", "number", num(c.combat.cmb));
    add("/combat", "CMD", "number", num(c.combat.cmd));
    add("/combat", "AC", "number", num(c.combat.ac.normal));
    add("/combat", "Touch AC", "number", num(c.combat.ac.touch));
    add("/combat", "Flatfooted AC", "number", num(c.combat.ac.flatFooted));
    add("/combat", "Max HP", "number", num(c.combat.hp.max));
    add("/combat", "Speed", "number", num(c.combat.speed));

    const concentration: [string, string][] = [];
    for (const sc of c.spellcasting) {
        const cls = baseClass(sc.className);
        if (!cls) continue;
        add("/combat", `CL ${cls}`, "number", num(sc.casterLevel));
        concentration.push([cls, add("/combat", `Concentration ${cls}`, "number", num(sc.concentration))]);
    }

    const skills: string[] = [];
    for (const skill of c.skills) skills.push(add("/skills", skill.name, "number", num(skill.total)));

    // Attacks: the first iterative attack bonus is a number (so a buff can be typed in as a Custom Data
    // edit and every roll follows); the later attacks are offsets from it, not fields of their own. The
    // damage formula is a rollable dice-expression. A flat damage figure ("6") has nothing to roll and
    // gets no field.
    const attacks: SheetNames["attacks"] = [];
    for (const atk of c.combat.attacks) {
        const label = atk.name.trim();
        const bonuses = iterativeBonuses(atk.bonus);
        const first = bonuses[0];
        const entry: SheetNames["attacks"][number] = { offsets: [] };
        if (first !== undefined) {
            entry.atk = add("/attacks", `Atk ${label}`, "number", first);
            entry.offsets = bonuses.map((b) => b - first);
        }
        if (/\d\s*d\s*\d/i.test(atk.damage)) {
            entry.dmg = add("/attacks", `Dmg ${label}`, "dice-expression", atk.damage.trim());
        }
        attacks.push(entry);
    }

    // --- ready-made rolls: click one in the token's Custom Data tab (or type {Roll ...}) ---
    add("/rolls", "Roll Initiative", "dice-expression", checkFormula(init));
    add("/rolls", "Roll Fortitude", "dice-expression", checkFormula(fort));
    add("/rolls", "Roll Reflex", "dice-expression", checkFormula(refl));
    add("/rolls", "Roll Will", "dice-expression", checkFormula(will));
    add("/rolls", "Roll CMB", "dice-expression", checkFormula(cmb));
    for (const key of ABILITY_KEYS) {
        add("/rolls", `Roll ${key.toUpperCase()} check`, "dice-expression", checkFormula(abilityMod[key]));
    }
    for (const [cls, concName] of concentration) {
        add("/rolls", `Roll Concentration ${cls}`, "dice-expression", checkFormula(concName));
    }
    c.skills.forEach((skill, i) => {
        const fieldName = skills[i];
        if (fieldName) add("/rolls", `Roll ${skill.name}`, "dice-expression", checkFormula(fieldName));
    });
    c.combat.attacks.forEach((atk, i) => {
        const entry = attacks[i];
        if (!entry?.atk) return;
        const base = `Roll Attack ${atk.name.trim()}`;
        entry.offsets.forEach((offset, n) => {
            const name = entry.offsets.length > 1 ? `${base} ${ordinal(n + 1)}` : base;
            add("/rolls", name, "dice-expression", attackFormula(entry.atk!, offset));
        });
    });

    return {
        elements: out,
        names: { abilityMod, init, fort, ref: refl, will, cmb, skills, attacks },
    };
}

export function buildElements(c: PF1Character): CdElement[] {
    return buildSheet(c).elements;
}

// ---- talking to PA's Custom Data system ------------------------------------------------------

interface RawElement {
    id: number;
    source: string;
    prefix: string;
    name: string;
    kind: string;
    value: unknown;
    pending?: unknown;
}

interface RealCustomData {
    export(shape: number): RawElement[];
    addElement(element: Record<string, unknown>, server: boolean): void;
    updateValue(shape: number, elementId: number, value: unknown, server: boolean): void;
    removeElement(shape: number, elementId: number, server: boolean): void;
}

function realCustomData(api: GameApi): RealCustomData | undefined {
    const cd = (api.systems as unknown as { customData?: Partial<RealCustomData> }).customData;
    if (!cd) return undefined;
    const ok =
        typeof cd.export === "function" &&
        typeof cd.addElement === "function" &&
        typeof cd.updateValue === "function" &&
        typeof cd.removeElement === "function";
    return ok ? (cd as RealCustomData) : undefined;
}

export interface CdOutcome {
    summary: string;
    added: number;
    updated: number;
    removed: number;
}

const key = (prefix: string, name: string): string => `${prefix.toLowerCase()}|${name.toLowerCase()}`;

/** Our own elements on this token. UI placeholder rows (`pending`) and other sources are ignored. */
function ours(cd: RealCustomData, shape: LocalId): RawElement[] {
    return cd.export(shape).filter((e) => e.source === CD_SOURCE && e.pending === undefined);
}

/**
 * Makes the token's Custom Data match `desired` for our source only: adds what is missing, updates
 * values that changed, removes what the sheet no longer exports. Anything with another source -
 * i.e. everything made by hand in PA - is never read or touched.
 */
export function syncCustomData(api: GameApi, shape: LocalId, desired: CdElement[]): CdOutcome {
    const none = (summary: string): CdOutcome => ({ summary, added: 0, updated: 0, removed: 0 });
    const cd = realCustomData(api);
    if (!cd) return none("This server doesn't support Custom Data from mods.");
    const shapeId = api.getGlobalId(shape);
    if (!shapeId) return none("This token isn't known to the server yet, so Custom Data wasn't written.");

    const existing = new Map(ours(cd, shape).map((e) => [key(e.prefix, e.name), e]));
    let added = 0;
    let updated = 0;
    let removed = 0;

    const create = (want: CdElement): void => {
        cd.addElement(
            {
                shapeId,
                source: CD_SOURCE,
                prefix: want.prefix,
                name: want.name,
                kind: want.kind,
                value: want.value,
                reference: null,
                description: null,
            },
            true,
        );
    };

    for (const want of desired) {
        const k = key(want.prefix, want.name);
        const cur = existing.get(k);
        existing.delete(k);
        if (!cur) {
            create(want);
            added++;
        } else if (cur.kind !== want.kind) {
            // PA's updateValue refuses a value of a different type, so swap the element instead.
            cd.removeElement(shape, cur.id, true);
            create(want);
            updated++;
        } else if (cur.value !== want.value) {
            cd.updateValue(shape, cur.id, want.value, true);
            updated++;
        }
    }
    for (const leftover of existing.values()) {
        cd.removeElement(shape, leftover.id, true);
        removed++;
    }

    const parts: string[] = [];
    if (added) parts.push(`${added} added`);
    if (updated) parts.push(`${updated} updated`);
    if (removed) parts.push(`${removed} removed`);
    return { summary: parts.length ? `Custom Data: ${parts.join(", ")}.` : "", added, updated, removed };
}

/** Removes every element this sheet wrote (and nothing else). */
export function removeCustomData(api: GameApi, shape: LocalId): CdOutcome {
    return syncCustomData(api, shape, []);
}

// ---- keeping this token's fields loaded for PlanarAlly's own resolver -------------------------------
//
// PA's dice panel resolves {variables} against Custom Data it has "leased" for a shape - normally the
// selected one. Holding our own lease for the sheet's token means a formula placed in the dice panel
// still resolves if the token is deselected before you press Enter. (loadState/dropState are PA's
// own lease calls: loadState(shape, key) adds the key, and the data is released when the last key is
// dropped, so dropping only the key we added can't disturb anyone else's.)
const LEASE_KEY = "pf1e-sheet";

export function holdCustomDataLease(api: GameApi, shape: LocalId): () => void {
    const cd = (
        api.systems as unknown as {
            customData?: {
                loadState?: (id: number, key: string) => void;
                dropState?: (id: number, key: string) => void;
            };
        }
    ).customData;
    if (!cd || typeof cd.loadState !== "function" || typeof cd.dropState !== "function") return () => undefined;
    cd.loadState(shape, LEASE_KEY);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        try {
            cd.dropState?.(shape, LEASE_KEY);
        } catch {
            /* nothing useful to do if PA objects to a release */
        }
    };
}
