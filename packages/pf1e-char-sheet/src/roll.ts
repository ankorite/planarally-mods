// Rolling dice through PlanarAlly's OWN dice engine, using the token's Custom Data for the numbers.
//
// The engine (`api.systems.dice.getSystem("2d")`), read from its source by the diagnostics build, has
// four functions that chain together:
//   parse(text)        -> array of parts: dice {amount, die:"d20", input, type}, operators, literals
//   roll(part, opts)   -> async; the dice part with `output` = the raw face values
//   evaluate(part)     -> the same part with output entries as {roll, status} (keep/drop/min/max)
//   collect(parts)     -> { parts: [...each with shortResult/longResult], result: "<total>" }
// so rolling `1d20+11` is parse -> roll+evaluate each dice part -> collect.
//
// FORMULAS REFERENCE CUSTOM DATA, e.g. `1d20 + {STR mod}`. The engine's parse() knows nothing about
// `{...}`: in PlanarAlly's own dice panel the variables are expanded when you press Enter, by code
// that is not exposed to mods. A quick roll therefore expands them itself (`resolveFormula`, a port
// of PA's own resolver, checked against it), and a roll sent to the dice panel is left for PA to
// expand (`openInDicePanel`, after checking the fields exist). The reason this matters: PA silently
// DROPS a variable it can't find, turning `1d20 + {Spellcraft}` into a bare `1d20`, so both paths
// refuse to roll when a field is missing instead.
//
// Two ways to roll:
//   * `rollFormula`     - rolled here, shown to the roller only (PA's result card + history if
//                         `useNativeUi`: `dice.addToHistory(roll, playerName, label)` records it and
//                         `dice.showResults(roll)` opens PA's result card - verified on a live server).
//                         Nothing is sent to other players.
//   * `openInDicePanel` - the formula goes into PA's own dice panel (exactly like clicking a Custom
//                         Data "dice-expression" element) and the player presses Enter. That is PA's
//                         NATIVE roll: 3D dice, "share with", and the toast other players see (PA
//                         sends it over an internal socket emitter mods can't reach).
//
// This module has no imports; the API is passed in as `unknown` so type drift can't break it.

type Dict = Record<string, unknown>;

const isObj = (x: unknown): x is Dict => (typeof x === "object" && x !== null) || typeof x === "function";

function get(x: unknown, key: string): unknown {
    try {
        return isObj(x) ? x[key] : undefined;
    } catch {
        return undefined;
    }
}

/** Calls a method with `this` preserved (class-based systems need it). */
function call(obj: unknown, name: string, ...args: unknown[]): unknown {
    const f = get(obj, name);
    if (typeof f !== "function") throw new Error(`${name} is not a function`);
    return (f as (...a: unknown[]) => unknown).apply(obj, args);
}

export class RollError extends Error {}

/** One or more `{fields}` a formula uses don't exist in the token's Custom Data. */
export class MissingFieldsError extends RollError {
    missing: string[];
    constructor(missing: string[]) {
        super(
            `Custom Data field${missing.length > 1 ? "s" : ""} ${missing.map((m) => `{${m}}`).join(", ")} not found on ` +
                `this token - use "Export to Custom Data" on the Core tab.`,
        );
        this.missing = missing;
    }
}

// ---- {field} resolution: a port of PlanarAlly's own hb()/gb() --------------------------------------
//
// PA's grammar (from its bundle): {name}, {prefix/name} or {[shapeId]name}, matching
// /{(\[\d+\])?([\w /]+)}/g. The last path segment is the name, the rest the prefix (a leading "/" is
// added if missing). A field matches an element whose `reference` (an alias) - or, with none, its
// `name` - equals it case-insensitively after stripping every character outside [\w /], and whose
// prefix matches when one was given. A dice-expression field is expanded recursively.

// A fresh regex per use: a /g regex is stateful (lastIndex), which bites when it is reused or re-entered.
const fieldRe = (): RegExp => /{(\[\d+\])?([\w /]+)}/g;
const hasField = (s: string): boolean => fieldRe().test(s);
const stripOdd = (s: string): string => s.replace(/[^\w /]/g, "");
const MAX_DEPTH = 8;

interface RawElement {
    prefix: string;
    name: string;
    kind: string;
    value: unknown;
    reference?: unknown;
}

function findField(api: unknown, shape: number, path: string): RawElement | undefined {
    const parts = path.split("/");
    const name = (parts[parts.length - 1] ?? "").toLowerCase();
    let prefix = parts.length === 1 ? undefined : parts.slice(0, -1).join("/");
    if (prefix !== undefined && prefix[0] !== "/") prefix = `/${prefix}`;

    const exported = call(get(get(api, "systems"), "customData"), "export", shape);
    if (!Array.isArray(exported)) return undefined;
    return (exported as RawElement[]).find((e) => {
        if (typeof e.prefix !== "string" || typeof e.name !== "string") return false;
        if (prefix !== undefined && stripOdd(e.prefix.toLowerCase()) !== prefix.toLowerCase()) return false;
        const key = typeof e.reference === "string" ? e.reference.toLowerCase() : stripOdd(e.name.toLowerCase());
        return key === name;
    });
}

function expand(api: unknown, shape: number, formula: string, missing: string[], depth: number): string {
    if (depth > MAX_DEPTH)
        throw new RollError("A Custom Data formula refers back to itself (or is nested too deeply).");
    return formula.replace(fieldRe(), (_whole, discriminator: string | undefined, path: string) => {
        const target = discriminator === undefined ? shape : Number.parseInt(discriminator.slice(1, -1), 10);
        const el = findField(api, target, path);
        if (!el) {
            missing.push(path);
            return "";
        }
        return el.kind === "dice-expression"
            ? expand(api, target, String(el.value), missing, depth + 1)
            : String(el.value);
    });
}

/** Tidies the sign when a negative field follows a "+" or "-": `1d20 + -1` -> `1d20 - 1`. */
function tidySigns(formula: string): string {
    return formula
        .replace(/\+\s*-\s*(?=\d)/g, "- ")
        .replace(/-\s*-\s*(?=\d)/g, "+ ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Expands every `{field}` in `formula` against `shape`'s Custom Data. Throws if any is missing. */
export function resolveFormula(api: unknown, shape: number, formula: string): string {
    const missing: string[] = [];
    const resolved = expand(api, shape, formula, missing, 0);
    if (missing.length) throw new MissingFieldsError(Array.from(new Set(missing)));
    return tidySigns(resolved);
}

// ---- display helpers ---------------------------------------------------------------------------------

/**
 * One part of a result for display. A single die or a number is just its value; several dice are
 * shown individually ("[4, 3]") so a damage roll like 2d6+9 isn't reduced to an unexplained "7 + 9".
 * The engine marks kept/dropped dice with * and ~, which add nothing here, so they go.
 */
function describePart(p: unknown): string {
    const long = get(p, "longResult");
    if (typeof get(p, "die") === "string" && Number(get(p, "amount")) > 1 && typeof long === "string" && long) {
        return `[${long.replace(/[*~]/g, "").split(",").join(", ")}]`;
    }
    const short = get(p, "shortResult") ?? get(p, "input");
    return typeof short === "string" || typeof short === "number" ? String(short) : "";
}

export interface RollOptions {
    /** What is being rolled, e.g. "Spellcraft" or "Attack: +3 greatsword". */
    label: string;
    /** Also push into PA's own roll history and open its result card. */
    useNativeUi: boolean;
    /** The token whose Custom Data `{fields}` resolve against; required when the formula has any. */
    shape?: number;
}

export interface RollOutcome {
    /** What was actually rolled, fields expanded: "1d20 + 11". */
    formula: string;
    /** What was asked for, fields intact: "1d20 + {Spellcraft}". */
    template: string;
    total: string;
    breakdown: string;
    /** The engine's own `{ parts, result }` object. */
    roll: unknown;
    /** Non-fatal problems (history/result-card failures) - the roll itself still happened. */
    notes: string[];
}

function checkDiceEnabled(api: unknown): void {
    const roomRaw = get(get(get(api, "systemsState"), "room"), "raw");
    if (get(roomRaw, "enableDice") === false) throw new RollError("Dice are disabled in this room.");
}

/** Rolls `formula` here with PA's 2d engine. `{fields}` are expanded from `opts.shape`'s Custom Data. */
export async function rollFormula(api: unknown, formula: string, opts: RollOptions): Promise<RollOutcome> {
    const notes: string[] = [];
    const systems = get(api, "systems");
    const dice = get(systems, "dice");
    if (!isObj(dice)) throw new RollError("This server has no dice system.");
    checkDiceEnabled(api);

    let toRoll = formula;
    if (hasField(formula)) {
        if (opts.shape === undefined)
            throw new RollError("This formula uses Custom Data fields but no token was given.");
        toRoll = resolveFormula(api, opts.shape, formula);
    }

    await call(dice, "loadSystems");
    const engine = call(dice, "getSystem", "2d");
    if (!isObj(engine)) throw new RollError("The 2d dice engine isn't available.");

    const parsed = call(engine, "parse", toRoll);
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new RollError(`Couldn't read "${toRoll}" as a dice formula.`);
    }

    const parts: unknown[] = [];
    for (const part of parsed) {
        if (isObj(part) && typeof part["die"] === "string") {
            // d100Mode only matters for d100s (whether a 100 is shown as 0 or 100); 1 = show 100.
            const rolled = await call(engine, "roll", part, { d100Mode: 1 });
            parts.push(call(engine, "evaluate", rolled));
        } else {
            parts.push(part);
        }
    }

    const collected = call(engine, "collect", parts);
    const total = String(get(collected, "result"));
    const collectedParts = get(collected, "parts");
    const breakdown = Array.isArray(collectedParts)
        ? collectedParts.map(describePart).join(" ").replace(/\s+/g, " ").trim()
        : "";

    if (opts.useNativeUi) {
        let playerName = "";
        try {
            const player = call(get(systems, "players"), "getCurrentPlayer");
            const name = get(player, "name");
            if (typeof name === "string") playerName = name;
        } catch {
            /* the history entry just gets a generic name */
        }
        try {
            call(dice, "addToHistory", collected, playerName || "Player", opts.label);
        } catch (e) {
            notes.push(`addToHistory failed: ${String(e)}`);
        }
        try {
            call(dice, "showResults", collected);
        } catch (e) {
            notes.push(`showResults failed: ${String(e)}`);
        }
    }

    return { formula: toRoll, template: formula, total, breakdown, roll: collected, notes };
}

/**
 * Hands a formula to PA's own dice panel, the way PA's Custom Data `dice-expression` elements do
 * (verified in PA's DiceFormat component: loadSystems -> activate the Dice tool -> wait 100 ms ->
 * dice.setInput(text)). The player then presses Enter in PA's panel, which performs PA's NATIVE
 * roll: 2d or 3d dice, PA's "share with" setting, and the toast other players see.
 *
 * `{fields}` are left for PA to expand when Enter is pressed, but each is first looked up here so a
 * missing field is reported instead of being silently dropped by PA, and they are rewritten to the
 * explicit `{[shapeId]name}` form PA itself writes, so they resolve for this token even if another
 * one is selected by then.
 *
 * `gameplay.activateTool("Dice")` takes the tool's name as a string: PA's tool enum is a string enum
 * (Select, Pan, Draw, Ruler, Ping, Map, Light, Vision, Spell, Dice, Note - read from its bundle).
 */
export async function openInDicePanel(api: unknown, formula: string, shape?: number): Promise<void> {
    const dice = get(get(api, "systems"), "dice");
    if (!isObj(dice)) throw new RollError("This server has no dice system.");
    checkDiceEnabled(api);

    let text = formula;
    if (hasField(formula)) {
        if (shape === undefined) throw new RollError("This formula uses Custom Data fields but no token was given.");
        resolveFormula(api, shape, formula); // throws MissingFieldsError; the result itself isn't used
        text = formula.replace(fieldRe(), (whole, discriminator: string | undefined, path: string) =>
            discriminator === undefined ? `{[${shape}]${path}}` : whole,
        );
    }

    if (get(dice, "isLoaded") !== true) await call(dice, "loadSystems");
    try {
        call(get(api, "gameplay"), "activateTool", "Dice");
    } catch (e) {
        throw new RollError(`Couldn't open PA's dice tool: ${String(e)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    call(dice, "setInput", text);
}
