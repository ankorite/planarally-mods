import type { PF1Character, SpellcastingClass, SpellEntry } from "./data";

// Spell dice macros. Each spell on the Spells tab can be added to the token's dice macros as
// "Cast <spell>". Hero Lab doesn't export a spell's dice as data, only its rules text, so the formula
// is guessed from that text for the spell's caster level and can be edited on the sheet.

/** Identifies a spell within a character: the same spell can be cast by two classes. */
export function spellKey(sc: Pick<SpellcastingClass, "className">, spell: Pick<SpellEntry, "name">): string {
    return `${sc.className.toLowerCase()}|${spell.name.toLowerCase()}`;
}

const DICE = /(\d+)\s*d\s*(\d+)(?:\s*([+-])\s*(\d+)(?!\s*d))?/gi;

/**
 * The first dice in the text that deal damage or heal - "1d6 points of fire damage", "cures 1d8" -
 * skipping dice that are durations or counts ("lingers 1d6 rounds").
 */
function firstEffectDice(text: string): RegExpExecArray | undefined {
    for (const m of text.matchAll(DICE)) {
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
        const before = text.slice(Math.max(0, m.index - 30), m.index);
        if (
            /^\s*(?:points?\b|[a-z]+\s+damage\b|damage\b)/i.test(after) ||
            /\b(?:cures?|heals?|deals?)\s*$/i.test(before)
        ) {
            return m as RegExpExecArray;
        }
    }
    return undefined;
}

/**
 * The dice a spell rolls at caster level `cl`, from its rules text, or "" when none is found:
 *   "1d6 points of fire damage per caster level (maximum 10d6)" -> "7d6" at CL 7
 *   "1d8 points of damage + 1 point per caster level (maximum +5)" -> "1d8+5" at CL 7
 *   "1d6 ... per two caster levels (maximum 5d6)" -> "3d6" at CL 7
 *   "deals 1d4+1 points of force damage" -> "1d4+1"
 * It is a guess: the sheet shows it in an editable field.
 */
export function guessSpellFormula(text: string, cl: number): string {
    const m = firstEffectDice(text);
    if (!m) return "";
    let count = Number(m[1]);
    const die = Number(m[2]);
    let bonus = m[3] ? (m[3] === "-" ? -1 : 1) * Number(m[4]) : 0;
    const level = Math.max(1, cl);

    // What follows the dice, up to the end of that sentence.
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 160).split(/\.\s/)[0] ?? "";

    // "+ 1 point per caster level (maximum +5)": a flat bonus that grows.
    const perPoint =
        /\+\s*(\d+)\s*points?\s+per\s+(two\s+)?(?:caster\s+)?levels?(?:\s*\(\s*max(?:imum)?\s*\+?\s*(\d+)\s*\))?/i.exec(
            after,
        );
    if (perPoint) {
        const per = Number(perPoint[1]);
        const steps = perPoint[2] ? Math.floor(level / 2) : level;
        const add = per * steps;
        bonus += perPoint[3] ? Math.min(add, Number(perPoint[3])) : add;
    } else {
        // "1d6 ... per caster level (maximum 10d6)": the dice themselves grow.
        const perDie = /^[^+]*?\bper\s+(two\s+)?(?:caster\s+)?levels?(?:[^(]*\(\s*max(?:imum)?\s*(\d+)\s*d)?/i.exec(
            after,
        );
        if (perDie) {
            const steps = perDie[1] ? Math.max(1, Math.floor(level / 2)) : level;
            count *= steps;
            if (perDie[2]) count = Math.min(count, Number(perDie[2]));
        }
    }
    return `${count}d${die}${bonus === 0 ? "" : bonus > 0 ? `+${bonus}` : `${bonus}`}`;
}

/** The spell's macro formula: the one edited on the sheet, else the guess. */
export function spellFormula(c: PF1Character, sc: SpellcastingClass, spell: SpellEntry): string {
    const edited = c.spellMacros?.formulas[spellKey(sc, spell)];
    return edited ?? guessSpellFormula(spell.fullText || spell.description, sc.casterLevel);
}

/** The spells exported as dice macros, with their formulas, in sheet order. */
export function macroSpells(c: PF1Character): { name: string; formula: string }[] {
    const enabled = new Set(c.spellMacros?.enabled ?? []);
    if (!enabled.size) return [];
    const out: { name: string; formula: string }[] = [];
    for (const sc of c.spellcasting) {
        for (const spell of sc.spells) {
            if (!enabled.has(spellKey(sc, spell))) continue;
            const formula = spellFormula(c, sc, spell).trim();
            if (formula) out.push({ name: spell.name, formula });
        }
    }
    return out;
}
