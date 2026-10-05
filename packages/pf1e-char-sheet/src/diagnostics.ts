// The DM-only Diagnostics tab: two read-only reports to copy into a bug report.
//
//   * Health check (`buildHealthCheck`): is the sheet working on THIS token? Checks every PlanarAlly
//     API function the sheet calls, the token's HP tracker, Custom Data and auras against what the
//     sheet expects, resolves every exported roll formula (without rolling), and lists recent
//     tracker / Custom Data events.
//   * API dump (`buildApiDump`): everything PlanarAlly's mod API exposes at runtime, plus a scan of
//     PlanarAlly's own JS for hook / event names. For when a PlanarAlly update changes the API.
//
// Neither report changes anything: no tracker, aura, Custom Data element or roll is created. The
// API is handled as `unknown` throughout, so a change in PlanarAlly can't break this file.

import { buildElements, CD_SOURCE } from "./customdata";
import type { PF1Character } from "./data";
import { resolveFormula } from "./roll";
import { isHpTrackerName } from "./trackers";

type Dict = Record<string, unknown>;

export const diagState = {
    meta: undefined as unknown,
    /** Log every event-bus event to the console too (they are always kept for the reports). */
    verbose: false,
    busCount: 0,
    busLog: [] as { n: number; time: string; name: string; json: string }[],
    notes: [] as string[],
};

export function note(text: string): void {
    diagState.notes.push(`${new Date().toISOString()} ${text}`);
    if (diagState.notes.length > 100) diagState.notes.shift();
    console.log(`[pf1e-sheet] ${text}`);
}

function recordBus(name: string, args: unknown[]): void {
    diagState.busCount++;
    const json = safeStringify(args, 400);
    diagState.busLog.push({ n: diagState.busCount, time: new Date().toISOString(), name, json });
    if (diagState.busLog.length > 150) diagState.busLog.shift();
    if (diagState.verbose) console.log(`[pf1e-sheet] eventBus "${name}" ${json}`);
}

// The events PlanarAlly emits on api.eventBus that matter to the sheet.
const BUS_EVENTS = [
    "tracker:added", "tracker:updated", "tracker:removed",
    "customData:added", "customData:updated", "customData:removed",
];

/** Keeps a log of tracker / Custom Data events for the reports. Our callbacks only record. */
export function installBusListeners(api: unknown): void {
    const bus = get(api, "eventBus");
    const on = get(bus, "on");
    if (typeof on !== "function") {
        note("api.eventBus.on missing - no event log");
        return;
    }
    for (const name of BUS_EVENTS) {
        try {
            on.call(bus, name, (...args: unknown[]) => recordBus(name, args));
        } catch (e) {
            note(`eventBus.on("${name}") failed: ${String(e)}`);
        }
    }
}

// ---------------------------------------------------------------------------------------
// small safe helpers
// ---------------------------------------------------------------------------------------

function isObjLike(x: unknown): x is Dict {
    return (typeof x === "object" && x !== null) || typeof x === "function";
}

/** Property read that never throws (getters on exotic objects can). */
function get(x: unknown, key: string): unknown {
    try {
        return isObjLike(x) ? x[key] : undefined;
    } catch {
        return undefined;
    }
}

function safe<T>(fn: () => T, fallback: T): T {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

function ctorName(x: unknown): string {
    return safe(() => {
        const c = (x as { constructor?: { name?: string } }).constructor;
        return c?.name ?? "?";
    }, "?");
}

function safeStringify(v: unknown, max = 600): string {
    const seen = new WeakSet<object>();
    try {
        const s = JSON.stringify(v, (_k: string, val: unknown) => {
            if (typeof val === "function") return `[fn/${val.length}]`;
            if (val instanceof Map) return { __map: Array.from(val.entries()).slice(0, 5) };
            if (val instanceof Set) return { __set: Array.from(val.values()).slice(0, 5) };
            if (typeof val === "object" && val !== null) {
                if (seen.has(val)) return "[repeat/circular]";
                seen.add(val);
            }
            return val;
        });
        const text = s ?? "undefined";
        return text.length > max ? `${text.slice(0, max)}...(+${text.length - max})` : text;
    } catch (e) {
        return `<stringify failed: ${String(e)}>`;
    }
}

function sourceOf(fn: unknown, max = 450): string {
    try {
        const s = Function.prototype.toString.call(fn).replace(/\s+/g, " ");
        return s.length > max ? `${s.slice(0, max)}...(+${s.length - max})` : s;
    } catch {
        return "<source unavailable>";
    }
}

function describeValue(v: unknown): string {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    switch (typeof v) {
        case "function":
            return `fn/${v.length}`;
        case "object":
            if (Array.isArray(v)) return `arr(${v.length})`;
            if (v instanceof Map) return `Map(${v.size})`;
            if (v instanceof Set) return `Set(${v.size})`;
            return `obj<${ctorName(v)}>`;
        case "string":
            return `str:${JSON.stringify(v.slice(0, 30))}`;
        default:
            return `${typeof v}:${String(v)}`;
    }
}

function describeDescriptor(d: PropertyDescriptor | undefined): string {
    if (!d) return "?";
    if ("get" in d || "set" in d) return `accessor(${d.get ? "get" : ""}${d.set ? "set" : ""})`;
    return describeValue(d.value as unknown);
}

// ---------------------------------------------------------------------------------------
// structural introspection: own properties + the whole prototype chain (class methods live
// on prototypes, which Object.keys() would miss entirely)
// ---------------------------------------------------------------------------------------

interface Member {
    name: string;
    desc: string;
    fn: unknown;
    value: unknown;
}
interface Level {
    ctor: string;
    members: Member[];
}

function collectLevels(obj: unknown, maxLevels = 6): Level[] {
    const levels: Level[] = [];
    if (!isObjLike(obj)) return levels;
    let cur: object | null = obj;
    for (
        let i = 0;
        cur !== null && cur !== Object.prototype && cur !== Function.prototype && i < maxLevels;
        i++
    ) {
        const members: Member[] = [];
        let names: string[] = [];
        try {
            names = Object.getOwnPropertyNames(cur);
        } catch {
            /* exotic object */
        }
        for (const name of names) {
            if (name === "constructor") continue;
            let d: PropertyDescriptor | undefined;
            try {
                d = Object.getOwnPropertyDescriptor(cur, name);
            } catch {
                /* ignore */
            }
            const isAccessor = d !== undefined && ("get" in d || "set" in d);
            const value: unknown = !isAccessor && d ? (d.value as unknown) : undefined;
            members.push({
                name,
                desc: describeDescriptor(d),
                fn: typeof value === "function" ? value : undefined,
                value,
            });
        }
        levels.push({ ctor: ctorName(cur), members });
        try {
            cur = Object.getPrototypeOf(cur) as object | null;
        } catch {
            cur = null;
        }
    }
    return levels;
}

interface DescribeOpts {
    /** Include function source for members whose name matches (or all when `true`). */
    sources?: RegExp | boolean;
    maxSources?: number;
    /** Max characters of each function's source (default 450). */
    sourceMax?: number;
}

function describeObject(label: string, obj: unknown, opts: DescribeOpts = {}): string[] {
    const lines: string[] = [`### ${label}  [${typeof obj}, ctor ${ctorName(obj)}]`];
    if (!isObjLike(obj)) {
        lines.push(`  value: ${describeValue(obj)}`);
        return lines;
    }
    const levels = collectLevels(obj);
    levels.forEach((lvl, i) => {
        const names = lvl.members.map((m) => `${m.name}:${m.desc}`).join(", ");
        lines.push(`  L${i}${i === 0 ? " own" : " proto"} (${lvl.ctor}): ${names || "(none)"}`);
    });

    if (opts.sources) {
        const seen = new Set<string>();
        let count = 0;
        const max = opts.maxSources ?? 20;
        for (const lvl of levels) {
            for (const m of lvl.members) {
                if (m.fn === undefined || seen.has(m.name)) continue;
                seen.add(m.name);
                if (opts.sources instanceof RegExp && !opts.sources.test(m.name)) continue;
                if (count >= max) continue;
                count++;
                lines.push(`  src ${m.name}: ${sourceOf(m.fn, opts.sourceMax)}`);
            }
        }
    }
    return lines;
}

/** Like describeObject, but recurses into plain-object members (for api.ui etc). */
function describeTree(label: string, obj: unknown, depth: number, opts: DescribeOpts = {}): string[] {
    const lines = describeObject(label, obj, opts);
    if (depth <= 0 || !isObjLike(obj)) return lines;
    const level0 = collectLevels(obj, 1)[0];
    for (const m of level0?.members ?? []) {
        if (
            isObjLike(m.value) &&
            typeof m.value === "object" &&
            !Array.isArray(m.value) &&
            !(m.value instanceof Map) &&
            !(m.value instanceof Set)
        ) {
            lines.push(...describeTree(`${label}.${m.name}`, m.value, depth - 1, opts));
        }
    }
    return lines;
}

const INTEREST = /dice|roll|chat|aura|track|custom|branch|initiative|message|notif|hook|event|variant/i;

/** Breadth-limited search of an object graph for names matching `re`. */
function findPaths(root: unknown, re: RegExp, maxDepth = 4, maxResults = 200): string[] {
    const results: string[] = [];
    const seen = new WeakSet<object>();
    const visit = (node: unknown, path: string, depth: number): void => {
        if (results.length >= maxResults || !isObjLike(node) || typeof node === "function") return;
        if (seen.has(node)) return;
        seen.add(node);
        if (typeof Node !== "undefined" && node instanceof Node) return;
        const levels = collectLevels(node, 4);
        levels.forEach((lvl, i) => {
            for (const m of lvl.members) {
                if (re.test(m.name) && results.length < maxResults) {
                    results.push(`${path}.${m.name} (${m.desc}${i > 0 ? ", on prototype" : ""})`);
                }
            }
        });
        if (depth >= maxDepth) return;
        for (const m of levels[0]?.members ?? []) {
            if (
                isObjLike(m.value) &&
                typeof m.value === "object" &&
                !Array.isArray(m.value) &&
                !(m.value instanceof Map) &&
                !(m.value instanceof Set)
            ) {
                visit(m.value, `${path}.${m.name}`, depth + 1);
            }
        }
    };
    visit(root, "api", 0);
    return results;
}

// ---------------------------------------------------------------------------------------
// API dump sections
// ---------------------------------------------------------------------------------------

function jsResourceNames(): string[] {
    const names = new Set<string>();
    safe(() => {
        for (const e of performance.getEntriesByType("resource")) {
            if (/\.js(\?|$)/.test(e.name)) names.add((e.name.split("/").pop() ?? "").split("?")[0] ?? "");
        }
    }, undefined);
    safe(() => {
        document.querySelectorAll("script[src], link[rel=modulepreload]").forEach((el) => {
            const src = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
            if (src) names.add((src.split("/").pop() ?? "").split("?")[0] ?? "");
        });
    }, undefined);
    return Array.from(names).filter(Boolean).sort();
}

function sectionEnv(): string[] {
    return [
        "## env",
        `userAgent: ${navigator.userAgent}`,
        `secureContext: ${String(window.isSecureContext)} (clipboard API needs true)`,
        `mod meta: ${safeStringify(diagState.meta, 600)}`,
    ];
}

function sectionTopLevel(api: unknown): string[] {
    return [
        "## api (top level)",
        ...describeObject("api", api),
        ...describeTree("api.ui", get(api, "ui"), 2),
    ];
}

const SYSTEM_SOURCE_RE = /track|aura|dice|roll|chat|custom|data|initiative/i;

function sectionSystems(api: unknown): string[] {
    const lines = ["## api.systems"];
    const systems = get(api, "systems");
    if (!isObjLike(systems)) return [...lines, "(missing)"];
    const keys = safe(() => Object.getOwnPropertyNames(systems), [] as string[]);
    lines.push(`keys: ${keys.join(", ")}`);
    for (const key of keys) {
        const sys = get(systems, key);
        // Source for every function on the systems we care about; names only for the rest.
        lines.push(
            ...describeObject(`api.systems.${key}`, sys, {
                sources: SYSTEM_SOURCE_RE.test(key) ? true : false,
                maxSources: 25,
            }),
        );
    }
    return lines;
}

function sectionSystemsState(api: unknown): string[] {
    const lines = ["## api.systemsState"];
    const st = get(api, "systemsState");
    if (!isObjLike(st)) return [...lines, "(missing)"];
    const keys = safe(() => Object.getOwnPropertyNames(st), [] as string[]);
    lines.push(`keys: ${keys.join(", ")}`);
    for (const key of keys) {
        const sub = get(st, key);
        lines.push(...describeObject(`api.systemsState.${key}`, sub));
        for (const variant of ["raw", "readonly"]) {
            const inner = get(sub, variant);
            if (isObjLike(inner)) {
                const innerKeys = safe(() => Object.getOwnPropertyNames(inner), [] as string[]);
                lines.push(`  ${variant} keys: ${innerKeys.join(", ")}`);
            }
        }
    }
    return lines;
}

const SHAPE_RE = /aura|tracker|custom|dice|roll|chat|branch|variant|label|badge|name/i;
const SHAPE_DATA_RE = /aura|tracker|custom|variant/i;

function sectionShape(api: unknown, shapeId: number | undefined): string[] {
    const lines = ["## shape (the runtime shape object)"];
    if (shapeId === undefined) return [...lines, "(no current shape id - open a character first)"];
    const getShape = get(api, "getShape");
    if (typeof getShape !== "function") return [...lines, "api.getShape is not a function"];
    const shape = safe(() => getShape.call(api, shapeId) as unknown, undefined);
    if (!isObjLike(shape)) return [...lines, `api.getShape(${shapeId}) returned ${describeValue(shape)}`];

    lines.push(...describeObject(`shape(${shapeId})`, shape, { sources: SHAPE_RE, maxSources: 14 }));

    // Sample actual data for the interesting own properties - shows what an aura/tracker
    // record looks like (field names), which the types never told us.
    for (const m of collectLevels(shape, 1)[0]?.members ?? []) {
        if (SHAPE_DATA_RE.test(m.name) && isObjLike(m.value) && typeof m.value !== "function") {
            lines.push(`  data ${m.name} = ${safeStringify(m.value, 700)}`);
        }
    }
    return lines;
}
function sectionChunks(): string[] {
    const names = jsResourceNames();
    const interesting = names.filter((n) => INTEREST.test(n));
    return [
        "## loaded JS chunks (feature modules in this PA build show up by file name)",
        `interesting: ${interesting.join(", ") || "(none matched)"}`,
        `all (${names.length}): ${names.join(", ")}`,
    ];
}

const WINDOW_RE = /dice|aura|tracker|chat|(?<![a-z])roll|socket|planar|__pa|modapi/i;

function sectionWindow(): string[] {
    const names = safe(() => Object.getOwnPropertyNames(window), [] as string[]);
    return [
        "## window globals matching dice/aura/tracker/chat/roll/socket/planar",
        names.filter((n) => WINDOW_RE.test(n)).join(", ") || "(none)",
    ];
}

function sectionVueApp(): string[] {
    const lines = ["## Vue app probe (global stores/plugins PA may have provided)"];
    const candidates: unknown[] = [
        document.getElementById("app"),
        document.body.firstElementChild,
        ...Array.from(document.querySelectorAll("body > div")),
    ];
    for (const el of candidates) {
        const app = get(el, "__vue_app__");
        if (!isObjLike(app)) continue;
        const gp = get(get(app, "config"), "globalProperties");
        lines.push(`globalProperties keys: ${safe(() => Object.getOwnPropertyNames(gp as object).join(", "), "?")}`);
        const provides = get(get(app, "_context"), "provides");
        lines.push(
            `provides keys: ${safe(
                () => Reflect.ownKeys(provides as object).map((k) => String(k)).join(", "),
                "?",
            )}`,
        );
        return lines;
    }
    return [...lines, "(no __vue_app__ found)"];
}

async function fetchText(path: string): Promise<string> {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(path, { signal: ctrl.signal });
        clearTimeout(timer);
        const text = (await r.text()).replace(/\s+/g, " ").slice(0, 200);
        return `${r.status} ${text}`;
    } catch (e) {
        return `failed: ${String(e)}`;
    }
}
function callM(obj: unknown, name: string, ...args: unknown[]): unknown {
    if (!isObjLike(obj)) throw new Error(`cannot call ${name} on ${describeValue(obj)}`);
    const f = obj[name];
    if (typeof f !== "function") throw new Error(`${name} is not a function (${describeValue(f)})`);
    return (f as (...a: unknown[]) => unknown).apply(obj, args);
}

const tail = (v: unknown, n: number): unknown => (Array.isArray(v) ? v.slice(-n) : v);
const sstate = (api: unknown, key: string): unknown => get(get(api, "systemsState"), key);
const sraw = (api: unknown, key: string): unknown => get(sstate(api, key), "raw");
const system = (api: unknown, key: string): unknown => get(get(api, "systems"), key);

function timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
}
// ---------------------------------------------------------------------------------------
// health check
// ---------------------------------------------------------------------------------------

/** Every API function the sheet calls, by path from `api`. */
const REQUIRED_API: [path: string, usedFor: string][] = [
    ["getShape", "tab filter, tracker sync"],
    ["getGlobalId", "Custom Data, DataBlock"],
    ["getOrLoadDataBlock", "tracker -> sheet HP"],
    ["eventBus.on", "tracker -> sheet HP"],
    ["systems.trackers.getAll", "HP tracker"],
    ["systems.trackers.get", "HP tracker"],
    ["systems.trackers.add", "HP tracker"],
    ["systems.trackers.update", "HP tracker"],
    ["systems.auras.getAll", "auras"],
    ["systems.auras.add", "auras"],
    ["systems.auras.update", "auras"],
    ["systems.auras.remove", "auras"],
    ["systems.customData.export", "Custom Data, rolls"],
    ["systems.customData.addElement", "Custom Data"],
    ["systems.customData.updateValue", "Custom Data"],
    ["systems.customData.removeElement", "Custom Data"],
    ["systems.customData.loadState", "dice panel rolls"],
    ["systems.customData.dropState", "dice panel rolls"],
    ["systems.dice.loadSystems", "rolls"],
    ["systems.dice.getSystem", "quick rolls"],
    ["systems.dice.setInput", "dice panel rolls"],
    ["systems.dice.addToHistory", "quick roll result popup"],
    ["systems.dice.showResults", "quick roll result popup"],
    ["systems.players.getCurrentPlayer", "quick roll history name"],
    ["systems.properties.setName", "token rename on import"],
    ["gameplay.activateTool", "dice panel rolls"],
];

const ENGINE_FUNCTIONS = ["parse", "roll", "evaluate", "collect"];

function getPath(root: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((o, k) => get(o, k), root);
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

/**
 * Read-only check of the sheet on one token. `character` is the sheet's own data for that token.
 * Problems are marked "!" and repeated in the summary at the top.
 */
export async function buildHealthCheck(
    api: unknown,
    shapeId: number | undefined,
    character: PF1Character,
): Promise<string> {
    const problems: string[] = [];
    const body: string[] = [];
    const ok = (text: string): void => void body.push(`  ${text}`);
    const bad = (text: string): void => {
        body.push(`! ${text}`);
        problems.push(text);
    };
    const section = (title: string, fn: () => void | Promise<void>): Promise<void> =>
        Promise.resolve()
            .then(() => {
                body.push("", `## ${title}`);
                return fn();
            })
            .catch((e: unknown) => bad(`${title}: check failed: ${String(e)}`));

    await section("Environment", async () => {
        ok(`mod: ${String(get(diagState.meta, "name") ?? "?")} v${String(get(diagState.meta, "version") ?? "?")}`);
        ok(`PlanarAlly: GET /api/version -> ${await fetchText("/api/version")}`);
        ok(`browser: ${navigator.userAgent}`);
        ok(`secure context: ${String(window.isSecureContext)} (copy-to-clipboard needs true)`);
        const game = get(sstate(api, "game"), "reactive");
        ok(`DM: ${String(get(game, "isDm"))}, fake player: ${String(get(game, "isFakePlayer"))}`);
        if (get(sraw(api, "room"), "enableDice") === false) bad("dice are disabled in this room");
        else ok("dice enabled in this room");
    });

    let engine: unknown;
    await section("PlanarAlly API functions the sheet uses", async () => {
        for (const [path, usedFor] of REQUIRED_API) {
            const present = typeof getPath(api, path) === "function";
            if (present) ok(`${pad("OK", 8)}${pad(path, 36)}${usedFor}`);
            else bad(`${pad("MISSING", 8)}${pad(path, 36)}${usedFor}`);
        }
        const dice = system(api, "dice");
        try {
            await Promise.race([Promise.resolve(callM(dice, "loadSystems")), timeout(8000)]);
            engine = callM(dice, "getSystem", "2d");
        } catch (e) {
            bad(`2d dice engine not available: ${String(e)}`);
            return;
        }
        const missing = ENGINE_FUNCTIONS.filter((f) => typeof get(engine, f) !== "function");
        if (missing.length) bad(`2d dice engine is missing ${missing.join(", ")}`);
        else ok(`2d dice engine: ${ENGINE_FUNCTIONS.join(", ")} present`);
    });

    if (shapeId === undefined) {
        bad("no token - open the sheet on a character token and run the check again");
        return finish(problems, body);
    }

    await section("Token", () => {
        ok(`local id: ${shapeId}, global id: ${safeStringify(safe(() => callM(api, "getGlobalId", shapeId), undefined))}`);
        const props = safe(
            () => ((get(sstate(api, "properties"), "readonly") as Dict)["data"] as Map<number, unknown>).get(shapeId),
            undefined,
        );
        ok(`token name: ${safeStringify(get(props, "name"))}`);
        const shape = safe(() => callM(api, "getShape", shapeId), undefined);
        if (get(shape, "character") === undefined) bad("token is not marked as a character");
        else ok(`character id: ${safeStringify(get(shape, "character"))}`);
    });

    await section("Sheet data", () => {
        const c = character;
        if (!c.identity.name) bad("no character imported on this token");
        ok(`name: ${c.identity.name || "(none)"}`);
        ok(`classes: ${c.classes.map((k) => `${k.name} ${k.level}`).join(", ") || "(none)"}`);
        ok(`imported: ${c.importedAt ?? "(never)"}`);
        ok(
            `counts: ${c.skills.length} skills, ${c.combat.attacks.length} attacks, ${c.feats.length} feats, ` +
                `${c.spellcasting.reduce((n, s) => n + s.spells.length, 0)} spells, ${c.specials?.length ?? 0} specials, ` +
                `${c.inventory.length} items, ${c.auras?.length ?? 0} auras`,
        );
        ok(`DataBlock size: ${(JSON.stringify(c).length / 1024).toFixed(1)} KB`);
        for (const a of c.combat.attacks) ok(`attack: ${a.name} ${a.bonus} dmg ${a.damage} crit ${a.critical}`);
    });

    await section("HP tracker", () => {
        const all = safe(() => callM(system(api, "trackers"), "getAll", shapeId) as unknown[], [] as unknown[]);
        const real = all.filter((t) => get(t, "temporary") !== true);
        const hp = real.filter((t) => isHpTrackerName(get(t, "name")));
        const { current, max } = character.combat.hp;
        ok(`sheet HP: ${current} / ${max}`);
        ok(`trackers on token: ${real.map((t) => `${String(get(t, "name"))} ${String(get(t, "value"))}/${String(get(t, "maxvalue"))}`).join(", ") || "(none)"}`);
        if (hp.length === 0) bad('no tracker named "HP" - use "Push HP to tracker" on the Core tab');
        else if (hp.length > 1) bad(`${hp.length} trackers named "HP" - only the first is synced`);
        const first = hp[0];
        if (first !== undefined && get(first, "value") !== current) {
            bad(`HP tracker shows ${String(get(first, "value"))} but the sheet has ${current}`);
        }
    });

    await section("Custom Data", () => {
        const exported = safe(() => callM(system(api, "customData"), "export", shapeId) as unknown[], [] as unknown[]);
        const mine = exported.filter((e) => get(e, "source") === CD_SOURCE && get(e, "pending") === undefined);
        const others = exported.filter((e) => get(e, "source") !== CD_SOURCE && get(e, "pending") === undefined);
        const expected = buildElements(character);
        const k = (prefix: unknown, name: unknown): string => `${String(prefix).toLowerCase()}|${String(name).toLowerCase()}`;
        const have = new Map(mine.map((e) => [k(get(e, "prefix"), get(e, "name")), e]));
        const missing: string[] = [];
        const outdated: string[] = [];
        for (const want of expected) {
            const key = k(want.prefix, want.name);
            const cur = have.get(key);
            have.delete(key);
            if (!cur) missing.push(`${want.prefix}/${want.name}`);
            else if (get(cur, "kind") !== want.kind || get(cur, "value") !== want.value) {
                outdated.push(`${want.prefix}/${want.name} (token ${safeStringify(get(cur, "value"))}, sheet ${safeStringify(want.value)})`);
            }
        }
        ok(`sheet exports ${expected.length} elements; token has ${mine.length} from the sheet, ${others.length} from elsewhere`);
        if (missing.length) bad(`${missing.length} missing (use "Export to Custom Data"): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", ..." : ""}`);
        if (outdated.length) bad(`${outdated.length} differ from the sheet: ${outdated.slice(0, 20).join("; ")}${outdated.length > 20 ? "; ..." : ""}`);
        if (have.size) ok(`${have.size} left over from an older export (removed on next export): ${Array.from(have.values()).map((e) => String(get(e, "name"))).join(", ")}`);
        if (!missing.length && !outdated.length) ok("all sheet elements present and up to date");
    });

    await section("Roll formulas (resolved, not rolled)", () => {
        const rolls = buildElements(character).filter((e) => e.prefix === "/rolls" || e.kind === "dice-expression");
        let good = 0;
        for (const r of rolls) {
            try {
                const resolved = resolveFormula(api, shapeId, `{${r.name}}`);
                const parsed = engine === undefined ? [] : (callM(engine, "parse", resolved) as unknown[]);
                if (engine !== undefined && (!Array.isArray(parsed) || parsed.length === 0)) {
                    bad(`${r.name}: "${resolved}" is not a valid dice formula`);
                } else good++;
            } catch (e) {
                bad(`${r.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        ok(`${good} of ${rolls.length} formulas resolve${engine === undefined ? "" : " and parse"}`);
    });

    await section("Auras", () => {
        const live = safe(() => callM(system(api, "auras"), "getAll", shapeId) as unknown[], [] as unknown[]).filter(
            (a) => get(a, "temporary") !== true,
        );
        ok(
            `on token: ${live.map((a) => `${String(get(a, "name"))} ${String(get(a, "value"))} ft${get(a, "visionSource") === true ? " (vision)" : ""}${get(a, "active") === false ? " (off)" : ""}`).join(", ") || "(none)"}`,
        );
        for (const a of character.auras ?? []) {
            const onToken = a.uuid !== "" && live.some((x) => get(x, "uuid") === a.uuid);
            if (onToken) ok(`sheet aura ${a.name} ${a.radius} ft: on token`);
            else bad(`sheet aura ${a.name} ${a.radius} ft is not on the token - use "Create / update auras on the token"`);
        }
        if (!(character.auras ?? []).length) ok("the sheet has no auras for this character");
    });

    await section("Recent tracker / Custom Data events", () => {
        const recent = diagState.busLog.slice(-15);
        if (!recent.length) ok("(none since the page loaded)");
        for (const b of recent) ok(`${b.time} ${b.name} ${b.json}`);
        for (const n of diagState.notes.slice(-10)) ok(`note: ${n}`);
    });

    return finish(problems, body);
}

function finish(problems: string[], body: string[]): string {
    return [
        `=== PF1E SHEET HEALTH CHECK ${new Date().toISOString()} ===`,
        problems.length ? `${problems.length} problem(s):` : "No problems found.",
        ...problems.map((p) => `  - ${p}`),
        ...body,
        "",
        "=== END ===",
    ].join("\n");
}

// ---------------------------------------------------------------------------------------
// API dump
// ---------------------------------------------------------------------------------------

// Chunks worth reading. Babylon/shader files are skipped: they're large and irrelevant.
const SCAN_ALLOW = /^(Game|dice|DiceFormat|ToggleFormat|dx|index|state|socket|utils|http|types|tools|movement)-/;

function viteChunkUrls(): string[] {
    const urls = new Set<string>();
    const consider = (raw: string): void => {
        try {
            const u = new URL(raw, location.href);
            const file = u.pathname.split("/").pop() ?? "";
            if (u.pathname.startsWith("/static/vite/") && u.pathname.endsWith(".js") && SCAN_ALLOW.test(file)) {
                urls.add(u.href);
            }
        } catch {
            /* not a URL */
        }
    };
    safe(() => {
        for (const e of performance.getEntriesByType("resource")) consider(e.name);
    }, undefined);
    safe(() => {
        document.querySelectorAll("link[rel=modulepreload], script[src]").forEach((el) => {
            consider(el.getAttribute("href") ?? el.getAttribute("src") ?? "");
        });
    }, undefined);
    return Array.from(urls).sort();
}

function snippets(text: string, needle: string, radius: number, max: number): string[] {
    const out: string[] = [];
    let from = 0;
    while (out.length < max) {
        const i = text.indexOf(needle, from);
        if (i === -1) break;
        out.push(text.slice(Math.max(0, i - radius), i + needle.length + radius).replace(/\s+/g, " "));
        from = i + needle.length;
    }
    return out;
}

async function fetchChunk(url: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        return await r.text();
    } finally {
        clearTimeout(timer);
    }
}

// Event/hook names: `.pipe("pre:tracker:update"` / `.emit("tracker:updated"` etc. PA's minified
// code writes them as template literals, so accept backticks and both quote styles.
const BUS_NAME_RE = /\.(pipe|tap|emit|on|once)\((?:`|"|')([A-Za-z0-9_.\-/]+:[A-Za-z0-9_.:\-/]+)(?:`|"|')/g;
// Socket (wire protocol) names look like "Shape.Options.Tracker.Update".
const WIRE_NAME_RE = /(?:`|"|')([A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*){1,6})(?:`|"|')/g;
const WIRE_INTEREST = /dice|roll|chat|aura|tracker|custom|propert|message/i;
// Searched for in PlanarAlly's JS: how its own code calls the parts of the API the sheet relies on.
const NEEDLES: [needle: string, radius: number, max: number][] = [
    [".addToHistory(", 250, 3],
    [".showResults(", 250, 3],
    [".getSystem(", 250, 3],
    [".setInput(", 250, 3],
    ["isVariable", 350, 3],
    ["shareWith", 300, 3],
    ["dice-expression", 200, 3],
    ["defaultValue", 150, 4],
];

/**
 * Reads the JS PlanarAlly itself served (read-only, same origin) for what the API objects can't
 * show: every hook and event name, socket message names, and how PlanarAlly's own code calls the
 * dice / Custom Data functions the sheet uses.
 */
async function bundleScan(): Promise<string[]> {
    const lines = ["## PlanarAlly bundle scan"];
    const urls = viteChunkUrls();
    lines.push(`scanning ${urls.length} chunk(s)`);

    const bus = new Map<string, Set<string>>(); // event/hook name -> methods used with it
    const wire = new Set<string>();
    const hits = new Map<string, string[]>();

    for (const url of urls) {
        const file = url.split("/").pop() ?? url;
        let text: string;
        try {
            text = await fetchChunk(url);
        } catch (e) {
            lines.push(`  ${file}: FETCH FAILED ${String(e)}`);
            continue;
        }
        lines.push(`  ${file}: ${(text.length / 1024).toFixed(0)} KB`);
        for (const m of text.matchAll(BUS_NAME_RE)) {
            const name = m[2] ?? "";
            if (!name) continue;
            if (!bus.has(name)) bus.set(name, new Set());
            bus.get(name)?.add(m[1] ?? "?");
        }
        for (const m of text.matchAll(WIRE_NAME_RE)) {
            if (m[1] && WIRE_INTEREST.test(m[1])) wire.add(m[1]);
        }
        for (const [needle, radius, max] of NEEDLES) {
            const arr = hits.get(needle) ?? [];
            for (const sn of snippets(text, needle, radius, max)) if (arr.length < max) arr.push(`[${file}] ${sn}`);
            hits.set(needle, arr);
        }
    }

    const byMethod = (...methods: string[]): string =>
        Array.from(bus.entries())
            .filter(([, used]) => methods.some((m) => used.has(m)))
            .map(([name]) => name)
            .sort()
            .join(", ") || "(none)";
    lines.push(
        "",
        `hooks (pipe/tap - api.hooks): ${byMethod("pipe", "tap")}`,
        `events (emit - api.eventBus.on): ${byMethod("emit")}`,
        `socket names (dice/roll/chat/aura/tracker/custom/propert/message): ${Array.from(wire).sort().join(", ") || "(none)"}`,
    );
    for (const [needle] of NEEDLES) {
        const arr = hits.get(needle) ?? [];
        lines.push("", `### ${needle}`, ...(arr.length ? arr : ["(no hits)"]));
    }
    return lines;
}

const SOURCE_SYSTEMS = /^(trackers|auras|customData|dice|properties|players)$/;

/**
 * Everything the mod API exposes at runtime: members of `api`, every system and its state, the
 * source of the functions the sheet relies on, the current token's raw data, and a scan of
 * PlanarAlly's JS. Large; meant to be pasted whole when a PlanarAlly update breaks something.
 */
export async function buildApiDump(api: unknown, shapeId: number | undefined): Promise<string> {
    const out: string[] = [`=== PF1E API DUMP ${new Date().toISOString()} (token ${String(shapeId)}) ===`];
    const run = async (title: string, fn: () => string[] | Promise<string[]>): Promise<void> => {
        try {
            out.push(...(await fn()));
        } catch (e) {
            out.push(`## ${title}: SECTION FAILED: ${String(e)}`);
        }
        out.push("");
    };

    await run("env", sectionEnv);
    out.push(`## server version\nGET /api/version -> ${await fetchText("/api/version")}`, "");
    await run("top level", () => sectionTopLevel(api));
    await run("hooks / eventBus / gameplay", () => [
        ...describeTree("api.hooks", get(api, "hooks"), 2, { sources: true, maxSources: 10 }),
        ...describeTree("api.eventBus", get(api, "eventBus"), 2, { sources: true, maxSources: 10 }),
        ...describeTree("api.gameplay", get(api, "gameplay"), 2),
    ]);
    await run("systems", () => sectionSystems(api));
    await run("sources", () => {
        const lines = ["## source of the systems the sheet uses"];
        const systems = get(api, "systems");
        for (const key of safe(() => Object.getOwnPropertyNames(systems), [] as string[])) {
            if (!SOURCE_SYSTEMS.test(key)) continue;
            lines.push(...describeObject(`api.systems.${key}`, get(systems, key), { sources: true, maxSources: 30, sourceMax: 1200 }));
        }
        return lines;
    });
    await run("systemsState", () => sectionSystemsState(api));
    await run("dice", async () => {
        const dice = system(api, "dice");
        await Promise.race([Promise.resolve(callM(dice, "loadSystems")), timeout(8000)]);
        const raw = sraw(api, "dice");
        return [
            ...describeObject('dice.getSystem("2d")', callM(dice, "getSystem", "2d"), { sources: true, maxSources: 10, sourceMax: 800 }),
            `dice state: ${safeStringify({ uiState: get(raw, "uiState"), textInput: get(raw, "textInput") }, 300)}`,
            `dice history (last 2): ${safeStringify(tail(get(raw, "history"), 2), 1500)}`,
            `room: ${safeStringify(sraw(api, "room"), 300)}`,
        ];
    });
    await run("shape", () => sectionShape(api, shapeId));
    await run("shape data", () => {
        if (shapeId === undefined) return ["## token data", "(no token)"];
        const getAll = (sys: string, fn: string): string =>
            safeStringify(safe(() => callM(system(api, sys), fn, shapeId), undefined), 3000);
        return [
            "## token data",
            `customData.export(): ${getAll("customData", "export")}`,
            `trackers.getAll(): ${getAll("trackers", "getAll")}`,
            `auras.getAll(): ${getAll("auras", "getAll")}`,
        ];
    });
    await run("interest search", () => [
        "## names matching dice/roll/chat/aura/tracker/custom/... anywhere in api (depth 4)",
        ...findPaths(api, INTEREST),
    ]);
    await run("events", () => [
        `## tracker / Custom Data events since page load (${diagState.busCount})`,
        ...(diagState.busLog.length ? diagState.busLog.slice(-30).map((b) => `  ${b.time} ${b.name} ${b.json}`) : ["  (none)"]),
        ...diagState.notes.slice(-20).map((n) => `  note: ${n}`),
    ]);
    await run("chunks", sectionChunks);
    await run("window", sectionWindow);
    await run("vue", sectionVueApp);
    await run("bundle scan", bundleScan);
    out.push("=== END ===");
    return out.join("\n");
}

/** Console handle: `pf1eApi` is the live API, `pf1eDiag` runs the reports. */
export function exposeDebugHandle(api: unknown, getShapeId: () => number | undefined): void {
    (window as unknown as Dict).pf1eApi = api;
    (window as unknown as Dict).pf1eDiag = {
        apiDump: () => buildApiDump(api, getShapeId()),
        state: diagState,
    };
}
