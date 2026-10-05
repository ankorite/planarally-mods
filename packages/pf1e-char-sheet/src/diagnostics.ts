// DIAGNOSTIC BUILD ONLY - remove (or gut) once the dice / tracker / aura integration paths
// are understood.
//
// Why this exists: @planarally/mod-api's published types have repeatedly disagreed with what a
// live PlanarAlly server actually exposes (trackers.getOrCreate missing, preTrackerUpdate never
// firing, ...). Rather than trust the types again, this module looks at the REAL runtime
// objects and produces a plain-text report that can be pasted back for analysis.
//
// Everything here is deliberately defensive: every probe is wrapped in try/catch, nothing
// invokes getters it doesn't have to, and the only write operations (the tracker self-tests)
// are opt-in and clean up after themselves. The API is always passed in as `unknown` so type
// drift in the mod API can't break this file; its only import is our own roll helper.

import { openInDicePanel, rollFormula } from "./roll";

type Dict = Record<string, unknown>;

export const diagState = {
    meta: undefined as unknown,
    /** How many times PA looked up each property on our exported `events` object. */
    eventAccess: new Map<string, number>(),
    trackerHookCount: 0,
    trackerHookCalls: [] as string[],
    /** Events seen on api.eventBus (see installBusListeners). `n` is a monotonic counter. */
    /** Log every event-bus event to the console too (they are always kept for the report). */
    verbose: false,
    busCount: 0,
    busLog: [] as { n: number; name: string; json: string }[],
    notes: [] as string[],
};

export function noteEventAccess(name: string): void {
    const key = name.slice(0, 80);
    diagState.eventAccess.set(key, (diagState.eventAccess.get(key) ?? 0) + 1);
}

export function note(text: string): void {
    diagState.notes.push(`${new Date().toISOString()} ${text}`);
    if (diagState.notes.length > 100) diagState.notes.shift();
    console.log(`[pf1e-diag] ${text}`);
}

export function recordTrackerHook(
    id: unknown,
    tracker: unknown,
    delta: unknown,
    syncTo: unknown,
): void {
    diagState.trackerHookCount++;
    const t = isObjLike(tracker)
        ? { uuid: get(tracker, "uuid"), name: get(tracker, "name"), value: get(tracker, "value"), max: get(tracker, "maxvalue") }
        : tracker;
    const line = safeStringify({ n: diagState.trackerHookCount, id, tracker: t, delta, syncTo }, 500);
    diagState.trackerHookCalls.push(line);
    if (diagState.trackerHookCalls.length > 60) diagState.trackerHookCalls.shift();
    console.log(`[pf1e-diag] preTrackerUpdate fired ${line}`);
}

export function recordBus(name: string, args: unknown[]): void {
    diagState.busCount++;
    const json = safeStringify(args, 400);
    diagState.busLog.push({ n: diagState.busCount, name, json });
    if (diagState.busLog.length > 150) diagState.busLog.shift();
    if (diagState.verbose) console.log(`[pf1e-diag] eventBus "${name}" ${json}`);
}

// Round 1 showed PA's own systems emit events on api.eventBus after they change something
// ("tracker:updated", "customData:added", ...). That is very likely the supported way to get
// notified of changes made elsewhere, so subscribe to a guessed list of names (read-only, our
// callback only logs) and see which ones actually fire. "*" is tried too: mitt-style buses
// call wildcard handlers for every event, which would reveal the real event names for us.
const GUESSED_BUS_EVENTS = [
    "*",
    "tracker:added", "tracker:updated", "tracker:removed",
    "customData:added", "customData:updated", "customData:removed",
    "aura:added", "aura:updated", "aura:removed",
    "shape:added", "shape:updated", "shape:removed",
    "chat:message", "dice:roll", "dice:rolled",
];

export function installBusListeners(api: unknown): void {
    const bus = get(api, "eventBus");
    if (!isObjLike(bus)) {
        note("api.eventBus missing - no event listeners installed");
        return;
    }
    const methods = collectLevels(bus).flatMap((l) => l.members.filter((m) => m.fn !== undefined).map((m) => m.name));
    note(`eventBus methods: ${methods.join(", ") || "(none)"}`);
    const subscribe = ["on", "subscribe", "listen", "addListener", "addEventListener"].find(
        (n) => typeof bus[n] === "function",
    );
    if (subscribe === undefined) {
        note("eventBus: no obvious subscribe method (on/subscribe/listen/addListener) - listeners not installed");
        return;
    }
    let ok = 0;
    const failures: string[] = [];
    for (const name of GUESSED_BUS_EVENTS) {
        try {
            (bus[subscribe] as (...a: unknown[]) => unknown).call(bus, name, (...args: unknown[]) =>
                recordBus(name, args),
            );
            ok++;
        } catch (e) {
            failures.push(`${name}: ${String(e)}`);
        }
    }
    note(
        `eventBus: subscribed to ${ok}/${GUESSED_BUS_EVENTS.length} guessed event names via .${subscribe}()` +
            (failures.length ? `; failures: ${failures.slice(0, 3).join(" | ")}` : ""),
    );
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
// report sections
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
    const lines = ["## shape probe (the real runtime shape object, not the 3-field IShape type)"];
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

function sectionTrackerState(api: unknown): string[] {
    const lines = ["## trackers state (current)"];
    const st = get(get(get(api, "systems"), "trackers"), "state");
    if (!isObjLike(st)) return [...lines, "(trackers.state missing)"];
    lines.push(`id: ${safeStringify(get(st, "id"))}  parentId: ${safeStringify(get(st, "parentId"))}`);
    lines.push(`trackers: ${safeStringify(get(st, "trackers"), 1500)}`);
    lines.push(`parentTrackers: ${safeStringify(get(st, "parentTrackers"), 800)}`);
    lines.push("(note: state.trackers ends with a temporary:true 'New tracker' placeholder row - not a real tracker)");
    return lines;
}

function sectionEvents(): string[] {
    const lines = ["## events (what PA asked our exported `events` object for)"];
    const entries = Array.from(diagState.eventAccess.entries()).sort((a, b) => b[1] - a[1]);
    lines.push(entries.length ? entries.map(([k, v]) => `${k} x${v}`).join(", ") : "(nothing recorded yet)");
    lines.push(`preTrackerUpdate fired ${diagState.trackerHookCount} time(s). Recent:`);
    lines.push(...(diagState.trackerHookCalls.length ? diagState.trackerHookCalls.slice(-15) : ["  (none)"]));
    lines.push(`eventBus events captured: ${diagState.busCount}. Recent:`);
    lines.push(...(diagState.busLog.length ? diagState.busLog.slice(-15).map((b) => `  #${b.n} ${b.name} ${b.json}`) : ["  (none)"]));
    if (diagState.notes.length) lines.push("notes:", ...diagState.notes.slice(-20).map((n) => `  ${n}`));
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

// ---------------------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------------------

export async function buildReport(api: unknown, shapeId: number | undefined): Promise<string> {
    const out: string[] = [`=== PF1E DIAG REPORT ${new Date().toISOString()} (shape ${String(shapeId)}) ===`];
    const run = (title: string, fn: () => string[]): void => {
        try {
            out.push(...fn());
        } catch (e) {
            out.push(`## ${title}: SECTION FAILED: ${String(e)}`);
        }
        out.push("");
    };

    run("env", sectionEnv);
    out.push(`## server version probe\nGET /api/version -> ${await fetchText("/api/version")}`, "");
    run("top level", () => sectionTopLevel(api));
    run("systems", () => sectionSystems(api));
    run("systemsState", () => sectionSystemsState(api));
    run("interest search", () => [
        "## names matching dice/roll/chat/aura/tracker/custom/branch/initiative/message/notif/hook/event/variant anywhere in api (depth 4)",
        ...findPaths(api, INTEREST),
    ]);
    run("shape", () => sectionShape(api, shapeId));
    run("trackers state", () => sectionTrackerState(api));
    run("events", sectionEvents);
    run("chunks", sectionChunks);
    run("window", sectionWindow);
    run("vue", sectionVueApp);
    out.push("=== END REPORT ===");
    return out.join("\n");
}

/** Short version, logged automatically at game init so there's always something in the console. */
export function quickSummary(api: unknown): string {
    const keys = (o: unknown): string => safe(() => Object.getOwnPropertyNames(o as object).join(", "), "?");
    const systems = get(api, "systems");
    const lines = [
        `api keys: ${keys(api)}`,
        `api.systems keys: ${keys(systems)}`,
        `api.systemsState keys: ${keys(get(api, "systemsState"))}`,
        `api.ui keys: ${keys(get(api, "ui"))}  api.ui.shape keys: ${keys(get(get(api, "ui"), "shape"))}`,
    ];
    for (const k of safe(() => Object.getOwnPropertyNames(systems as object), [] as string[])) {
        const names = collectLevels(get(systems, k))
            .flatMap((l) => l.members.map((m) => m.name))
            .join(", ");
        lines.push(`system ${k}: ${names}`);
    }
    lines.push(`interesting chunks: ${jsResourceNames().filter((n) => INTEREST.test(n)).join(", ") || "(none)"}`);
    return lines.join("\n");
}

// =======================================================================================
// ROUND 2: deep dives + self-tests written against the REAL runtime API names that round 1
// revealed (trackers.add/getAll/update/remove, customData.addElement/..., auras.add/...,
// chat.addMessage, dice.setInput, properties.setName, api.eventBus, api.hooks).
// =======================================================================================

function callM(obj: unknown, name: string, ...args: unknown[]): unknown {
    if (!isObjLike(obj)) throw new Error(`cannot call ${name} on ${describeValue(obj)}`);
    const f = obj[name];
    if (typeof f !== "function") throw new Error(`${name} is not a function (${describeValue(f)})`);
    return (f as (...a: unknown[]) => unknown).apply(obj, args);
}

function uuid(): string {
    try {
        // randomUUID only exists on secure contexts (https/localhost); a dev server on plain
        // http://ip:port won't have it, hence the fallback.
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {
        /* fall through */
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

const tail = (v: unknown, n: number): unknown => (Array.isArray(v) ? v.slice(-n) : v);
const sstate = (api: unknown, key: string): unknown => get(get(api, "systemsState"), key);
const sraw = (api: unknown, key: string): unknown => get(sstate(api, key), "raw");
const system = (api: unknown, key: string): unknown => get(get(api, "systems"), key);

function timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
}

/** Runs one call, records its result, and how many eventBus events / legacy hook calls it caused. */
function stepper(lines: string[]): (title: string, fn: () => unknown) => void {
    return (title, fn) => {
        const hookBefore = diagState.trackerHookCount;
        const busBefore = diagState.busCount;
        let result: string;
        try {
            result = safeStringify(fn(), 500);
        } catch (e) {
            result = `THREW ${String(e)}`;
        }
        const bus = diagState.busLog.filter((b) => b.n > busBefore).map((b) => b.name);
        lines.push(
            `- ${title}: ${result} | legacy preTrackerUpdate calls: ${diagState.trackerHookCount - hookBefore}` +
                ` | eventBus events: ${bus.length ? bus.join(", ") : "none"}`,
        );
    };
}

// ---- deep dive: hooks / eventBus / gameplay / modals ------------------------------------

export function buildDeepHooks(api: unknown): string {
    const lines = [`=== DEEP DIVE: hooks / eventBus / gameplay / modals ${new Date().toISOString()} ===`];
    const opts = { sources: true, maxSources: 30, sourceMax: 1200 };
    const run = (title: string, fn: () => string[]): void => {
        try {
            lines.push(...fn());
        } catch (e) {
            lines.push(`## ${title}: SECTION FAILED: ${String(e)}`);
        }
        lines.push("");
    };
    run("hooks", () => describeTree("api.hooks", get(api, "hooks"), 2, opts));
    run("eventBus", () => describeTree("api.eventBus", get(api, "eventBus"), 2, opts));
    run("gameplay", () => describeTree("api.gameplay", get(api, "gameplay"), 3, opts));
    run("modals", () => describeTree("api.ui.modals", get(get(api, "ui"), "modals"), 1, opts));
    run("bus", () => [
        "## eventBus events captured so far (our listeners were installed at game start)",
        ...(diagState.busLog.length
            ? diagState.busLog.slice(-40).map((b) => `  #${b.n} ${b.name} ${b.json}`)
            : ["  (none - either no events fired yet, or the guessed names/subscribe method were wrong; see notes)"]),
        ...diagState.notes.slice(-15).map((n) => `  note: ${n}`),
    ]);
    return lines.join("\n");
}

// ---- deep dive: dice / chat / room ---------------------------------------------------------

export async function buildDeepDice(api: unknown): Promise<string> {
    const lines = [`=== DEEP DIVE: dice / chat / room ${new Date().toISOString()} ===`];
    const dice = system(api, "dice");

    try {
        await Promise.race([Promise.resolve(callM(dice, "loadSystems")), timeout(8000)]);
        lines.push("dice.loadSystems(): completed");
    } catch (e) {
        lines.push(`dice.loadSystems(): ${String(e)}`);
    }
    lines.push(`dice.isLoaded: ${safeStringify(get(dice, "isLoaded"))}`);
    for (const key of ["2d", "3d"]) {
        const sys = safe(() => callM(dice, "getSystem", key), undefined);
        lines.push(
            ...describeObject(`dice.getSystem("${key}")`, sys, { sources: true, maxSources: 30, sourceMax: 1000 }),
        );
    }

    const raw = sraw(api, "dice");
    lines.push(
        `systemsState.dice.raw: ${safeStringify(
            {
                uiState: get(raw, "uiState"),
                textInput: get(raw, "textInput"),
                lastCursorPosition: get(raw, "lastCursorPosition"),
                dimensions3d: get(raw, "dimensions3d"),
            },
            500,
        )}`,
    );
    const history = get(raw, "history");
    lines.push(
        `dice history (${Array.isArray(history) ? history.length : "?"} entries, last 3): ${safeStringify(tail(history, 3), 2000)}`,
    );
    lines.push(`dice result: ${safeStringify(get(raw, "result"), 1500)}`);

    const messages = get(sraw(api, "chat"), "messages");
    lines.push(
        `chat messages (${Array.isArray(messages) ? messages.length : "?"}, last 5): ${safeStringify(tail(messages, 5), 2000)}`,
    );
    lines.push(`room flags: ${safeStringify(sraw(api, "room"), 300)}`);

    lines.push(...describeObject("api.systems.chat (sources)", system(api, "chat"), { sources: true, sourceMax: 1000 }));
    lines.push(...describeObject("api.systems.room (sources)", system(api, "room"), { sources: true, sourceMax: 1000 }));
    lines.push(
        "",
        "TIP: run 'Dice: prefill 1d20+5' (or roll normally in PA), roll it, then run this deep dive again -",
        "the history/result/chat-message lines above then show exactly what a real roll looks like.",
    );
    return lines.join("\n");
}

// ---- deep dive: customData / auras / properties / variants + per-shape data -----------------

export function buildDeepData(api: unknown, shapeId: number | undefined): string {
    const lines = [`=== DEEP DIVE: customData / auras / properties / variants ${new Date().toISOString()} (shape ${String(shapeId)}) ===`];
    const run = (title: string, fn: () => string[]): void => {
        try {
            lines.push(...fn());
        } catch (e) {
            lines.push(`## ${title}: SECTION FAILED: ${String(e)}`);
        }
        lines.push("");
    };
    run("customData src", () =>
        describeObject("api.systems.customData (long sources)", system(api, "customData"), {
            sources: true, maxSources: 25, sourceMax: 1800,
        }),
    );
    run("auras src", () =>
        describeObject("api.systems.auras (long sources)", system(api, "auras"), {
            sources: /^(add|update|remove|getAll|get|fromServerShape|toServerShape)$/, maxSources: 20, sourceMax: 1800,
        }),
    );
    run("properties src", () =>
        describeObject("api.systems.properties (rename-related sources)", system(api, "properties"), {
            sources: /^(setName|setNameVisible|setShowBadge|setIsDefeated|loadState|dropState)$/, maxSources: 12, sourceMax: 1200,
        }),
    );
    run("variants src", () =>
        describeObject("api.systems.variants (sources)", system(api, "variants"), {
            sources: /^(createOrGet|create|add|load|update|store)$/, maxSources: 10, sourceMax: 800,
        }),
    );
    run("shape data", () => {
        if (shapeId === undefined) return ["(no current shape id - open a character first)"];
        const out = [`## data for shape ${shapeId}`];
        out.push(`global id: ${safeStringify(safe(() => callM(api, "getGlobalId", shapeId), undefined))}`);
        const cd = safe(() => callM(system(api, "customData"), "export", shapeId) as unknown[], [] as unknown[]);
        out.push(`customData.export(): ${cd.length} element(s): ${safeStringify(cd, 3000)}`);
        const auras = safe(() => callM(system(api, "auras"), "getAll", shapeId) as unknown[], [] as unknown[]);
        out.push(`auras.getAll(): ${auras.length} aura(s): ${safeStringify(auras, 2500)}`);
        const trackers = safe(() => callM(system(api, "trackers"), "getAll", shapeId) as unknown[], [] as unknown[]);
        out.push(`trackers.getAll(): ${trackers.length} tracker(s): ${safeStringify(trackers, 1500)}`);
        const variants = safe(() => callM(system(api, "variants"), "export", shapeId), undefined);
        out.push(`variants.export(): ${safeStringify(variants, 800)}`);
        const propData = safe(
            () => ((get(sstate(api, "properties"), "readonly") as Dict)["data"] as Map<number, unknown>).get(shapeId),
            undefined,
        );
        out.push(`properties (readonly state) for shape: ${safeStringify(propData, 600)}`);
        return out;
    });
    return lines.join("\n");
}

// ---- self-tests -----------------------------------------------------------------------------

const TEST_SOURCE = "pf1e-diag";

/** Tracker add -> getAll -> update -> remove on a throwaway tracker. */
export function runTrackerSelfTest(api: unknown, shapeId: number | undefined, serverSync: boolean): string[] {
    const lines = [`=== TRACKER SELF-TEST (${serverSync ? "SERVER-SYNCED" : "local only"}) ${new Date().toISOString()} ===`];
    const trackers = system(api, "trackers");
    if (!isObjLike(trackers)) return [...lines, "api.systems.trackers missing"];
    if (shapeId === undefined) return [...lines, "no current shape id"];
    const sync = { ui: true, server: serverSync };
    const step = stepper(lines);
    const id = uuid();
    const mine = (): string =>
        safeStringify(
            (safe(() => callM(trackers, "getAll", shapeId) as unknown[], [] as unknown[])).filter((t) => get(t, "uuid") === id),
            400,
        );

    step("add", () =>
        callM(trackers, "add", shapeId, {
            uuid: id, name: "PF1E-DIAG", value: 5, maxvalue: 10, visible: true, draw: true,
            primaryColor: "#ff00ff", secondaryColor: "#00ffff",
        }, sync),
    );
    lines.push(`  getAll() now: ${mine()}`);
    step("get", () => callM(trackers, "get", shapeId, id));
    step("update value=7", () => callM(trackers, "update", shapeId, id, { value: 7 }, sync));
    lines.push(`  getAll() now: ${mine()}`);
    step("update maxvalue=12,name=PF1E-DIAG2", () =>
        callM(trackers, "update", shapeId, id, { maxvalue: 12, name: "PF1E-DIAG2" }, sync),
    );
    lines.push(`  getAll() now: ${mine()}`);
    step("remove", () => callM(trackers, "remove", shapeId, id, sync));
    lines.push(`  getAll() now: ${mine()}`);
    return lines;
}

/** Custom Data: addElement -> getElementId -> updateValue -> removeElement, under our own `source`. */
export function runCustomDataSelfTest(api: unknown, shapeId: number | undefined, serverSync: boolean): string[] {
    const lines = [`=== CUSTOM DATA SELF-TEST (${serverSync ? "SERVER-SYNCED" : "local only"}) ${new Date().toISOString()} ===`];
    const cd = system(api, "customData");
    if (!isObjLike(cd)) return [...lines, "api.systems.customData missing"];
    if (shapeId === undefined) return [...lines, "no current shape id"];
    const step = stepper(lines);
    const gid = safe(() => callM(api, "getGlobalId", shapeId), undefined);
    lines.push(`global id of shape: ${safeStringify(gid)}`);
    const ident = { shapeId: gid, source: TEST_SOURCE, prefix: "diag", name: "test_number" };
    const mine = (): string =>
        safeStringify(
            (safe(() => callM(cd, "export", shapeId) as unknown[], [] as unknown[])).filter((e) => get(e, "source") === TEST_SOURCE),
            600,
        );

    step("addElement", () =>
        callM(cd, "addElement", { ...ident, kind: "number", value: 5, reference: null, description: "pf1e diagnostic" }, serverSync),
    );
    lines.push(`  export() now: ${mine()}`);
    const elementId = safe(() => callM(cd, "getElementId", ident), undefined);
    lines.push(`  getElementId -> ${safeStringify(elementId)}`);
    step("updateValue 5 -> 9", () => callM(cd, "updateValue", shapeId, elementId, 9, serverSync));
    lines.push(`  export() now: ${mine()}`);
    step("removeElement", () => callM(cd, "removeElement", shapeId, elementId, serverSync));
    lines.push(`  export() now: ${mine()}`);
    return lines;
}

/**
 * Auras: clones an EXISTING aura on the shape (so the record has exactly the right fields, which
 * we haven't seen yet), made inactive/invisible so it can't change lighting or vision, local only.
 */
export function runAuraSelfTest(api: unknown, shapeId: number | undefined): string[] {
    const lines = [`=== AURA SELF-TEST (local only, clone of an existing aura) ${new Date().toISOString()} ===`];
    const auras = system(api, "auras");
    if (!isObjLike(auras)) return [...lines, "api.systems.auras missing"];
    if (shapeId === undefined) return [...lines, "no current shape id"];
    const existing = safe(() => callM(auras, "getAll", shapeId) as unknown[], [] as unknown[]).filter(isObjLike);
    if (!existing.length) {
        return [...lines, "This shape has no aura. Add one via PlanarAlly's Auras UI first (any aura), then re-run - cloning a real one guarantees the right fields."];
    }
    const step = stepper(lines);
    const clone = JSON.parse(JSON.stringify(existing[0])) as Dict;
    const id = uuid();
    clone["uuid"] = id;
    if (typeof clone["name"] === "string") clone["name"] = `${clone["name"]}-diag`;
    for (const k of ["active", "visionSource", "visible"]) if (k in clone) clone[k] = false;
    const sync = { ui: true, server: false };
    const mine = (): string =>
        safeStringify(
            (safe(() => callM(auras, "getAll", shapeId) as unknown[], [] as unknown[])).filter((a) => get(a, "uuid") === id),
            600,
        );

    lines.push(`template aura fields: ${Object.keys(clone).join(", ")}`);
    step("add (clone)", () => callM(auras, "add", shapeId, clone, sync));
    lines.push(`  getAll() now: ${mine()}`);
    if (typeof clone["value"] === "number") {
        step(`update value ${clone["value"]} -> ${clone["value"] + 1}`, () =>
            callM(auras, "update", shapeId, id, { value: (clone["value"] as number) + 1 }, sync),
        );
        lines.push(`  getAll() now: ${mine()}`);
    }
    step("remove", () => callM(auras, "remove", shapeId, id, sync));
    lines.push(`  getAll() now: ${mine()}`);
    return lines;
}

/** Dice: pre-fills PA's roll box. You then press Enter yourself; re-run the dice deep dive after. */
export function runDicePrefill(api: unknown, text = "1d20+5"): string[] {
    const lines = [`=== DICE PREFILL ${new Date().toISOString()} ===`];
    const dice = system(api, "dice");
    if (!isObjLike(dice)) return [...lines, "api.systems.dice missing"];
    const step = stepper(lines);
    const stateNow = (): string =>
        safeStringify({ uiState: get(sraw(api, "dice"), "uiState"), textInput: get(sraw(api, "dice"), "textInput") }, 300);
    lines.push(`state before: ${stateNow()}`);
    step(`setInput(${JSON.stringify(text)})`, () => callM(dice, "setInput", text));
    lines.push(`state after: ${stateNow()}`);
    lines.push("If a roll prompt appeared, press Enter to roll it, then run 'Deep dive: dice & chat' to capture the real roll data.");
    return lines;
}

/** Shape rename via the real setter. This genuinely renames the token - that is the point. */
export function runRenameTest(api: unknown, shapeId: number | undefined, newName: string): string[] {
    const lines = [`=== RENAME TEST (changes the real shape name) ${new Date().toISOString()} ===`];
    const props = system(api, "properties");
    if (!isObjLike(props)) return [...lines, "api.systems.properties missing"];
    if (shapeId === undefined) return [...lines, "no current shape id"];
    if (!newName) return [...lines, "sheet has no character name to rename to (import a character first)"];
    const step = stepper(lines);
    const nameNow = (): string =>
        safeStringify(
            safe(() => ((get(sstate(api, "properties"), "readonly") as Dict)["data"] as Map<number, unknown>).get(shapeId), undefined),
            300,
        );
    for (const lvl of collectLevels(props)) {
        const m = lvl.members.find((x) => x.name === "setName");
        if (m?.fn) {
            lines.push(`setName source: ${sourceOf(m.fn, 1200)}`);
            break;
        }
    }
    lines.push(`state before: ${nameNow()}`);
    step(`setName(${shapeId}, ${JSON.stringify(newName)}, {ui,server})`, () =>
        callM(props, "setName", shapeId, newName, { ui: true, server: true }),
    );
    lines.push(`state after: ${nameNow()}`);
    lines.push("Check the Properties tab and the on-map label, then reload the page to confirm it persisted.");
    return lines;
}

/** Every local-only test in one go (tracker, custom data, aura if present, chat). */
export function runAllLocalTests(api: unknown, shapeId: number | undefined): string[] {
    return [
        ...runTrackerSelfTest(api, shapeId, false), "",
        ...runCustomDataSelfTest(api, shapeId, false), "",
        ...runAuraSelfTest(api, shapeId),
    ];
}

// ---- ROUND 3: dice engine test + PA bundle scanner ------------------------------------------

/** Rolls 1d20+5 through the real engine, pushing into PA's own history/results UI as well. */
export async function runDiceEngineTest(api: unknown): Promise<string[]> {
    const lines = [`=== DICE ENGINE TEST (local; also pushes to PA's native history/results) ${new Date().toISOString()} ===`];
    try {
        const out = await rollFormula(api, "1d20+5", { label: "PF1E-DIAG roll", useNativeUi: true });
        lines.push(`total ${out.total}, breakdown "${out.breakdown}"`);
        lines.push(`engine's collected roll object: ${safeStringify(out.roll, 1600)}`);
        lines.push(`notes: ${out.notes.length ? out.notes.join(" | ") : "(none - addToHistory and showResults did not throw)"}`);
    } catch (e) {
        lines.push(`FAILED: ${String(e)}`);
    }
    const raw = sraw(api, "dice");
    const history = get(raw, "history");
    lines.push(
        `PA dice state after: ${safeStringify({ uiState: get(raw, "uiState"), textInput: get(raw, "textInput") }, 300)}`,
        `PA history (${Array.isArray(history) ? history.length : "?"}, last 2): ${safeStringify(tail(history, 2), 1400)}`,
        `PA result: ${safeStringify(get(raw, "result"), 900)}`,
        "Did a results popup / history entry appear in PA's dice panel? Say so when you paste this.",
    );
    return lines;
}

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
const ANCHORS = [".addToHistory(", ".showResults(", ".getSystem(", ".loadSystems(", ".setInput(", ".addMessage("];

/**
 * Reads the JS PA itself served (read-only, same origin) and extracts what the API can't tell us:
 * the full list of hook and event names, the custom-data element kinds (their defaultValue
 * table), how PA's own dice UI calls the engine and chat, and how dice code touches custom data.
 */
export async function buildBundleScan(): Promise<string> {
    const lines = [`=== PA BUNDLE SCAN ${new Date().toISOString()} ===`];
    const urls = viteChunkUrls();
    lines.push(`scanning ${urls.length} chunk(s): ${urls.map((u) => u.split("/").pop() ?? u).join(", ")}`);

    const bus = new Map<string, Set<string>>(); // event/hook name -> methods used with it
    const wire = new Set<string>();
    const kinds: string[] = [];
    const anchorHits = new Map<string, string[]>();
    const customInDice: string[] = [];
    const referenceHits: string[] = [];

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
        try {
            for (const m of text.matchAll(BUS_NAME_RE)) {
                const name = m[2] ?? "";
                if (!name) continue;
                if (!bus.has(name)) bus.set(name, new Set());
                bus.get(name)?.add(m[1] ?? "?");
            }
            for (const m of text.matchAll(WIRE_NAME_RE)) {
                if (m[1] && WIRE_INTEREST.test(m[1])) wire.add(m[1]);
            }
            for (const sn of snippets(text, "defaultValue", 150, 6)) kinds.push(`[${file}] ${sn}`);
            for (const a of ANCHORS) {
                const hits = anchorHits.get(a) ?? [];
                for (const sn of snippets(text, a, 320, 3)) if (hits.length < 4) hits.push(`[${file}] ${sn}`);
                anchorHits.set(a, hits);
            }
            if (file.startsWith("dice-")) {
                customInDice.push(...snippets(text, "customData", 220, 6).map((sn) => `[${file}] ${sn}`));
            }
            referenceHits.push(...snippets(text, ".reference", 160, 3).map((sn) => `[${file}] ${sn}`));
        } catch (e) {
            lines.push(`  ${file}: ANALYSIS FAILED ${String(e)}`);
        }
    }

    const byMethod = (m: string): string =>
        Array.from(bus.entries())
            .filter(([, methods]) => methods.has(m))
            .map(([name]) => name)
            .sort()
            .join(", ") || "(none)";
    lines.push(
        "",
        "## hook names (.pipe/.tap - mods can register handlers with api.hooks.tap(name, fn))",
        `pipe: ${byMethod("pipe")}`,
        `tap: ${byMethod("tap")}`,
        "",
        "## event names (.emit - mods can listen with api.eventBus.on(name, fn))",
        `emit: ${byMethod("emit")}`,
        `on/once: ${byMethod("on")} | ${byMethod("once")}`,
        "",
        `## wire-protocol-looking names matching dice/roll/chat/aura/tracker/custom/propert/message (${wire.size})`,
        Array.from(wire).sort().join(", ") || "(none)",
        "",
        "## defaultValue contexts (the custom-data element kinds table lives around here)",
        ...(kinds.length ? kinds.slice(0, 10) : ["(none found)"]),
        "",
        "## how PA's own code calls the dice/chat API",
    );
    for (const a of ANCHORS) {
        lines.push(`### ${a}`, ...((anchorHits.get(a) ?? []).length ? (anchorHits.get(a) ?? []) : ["(no hits)"]));
    }
    lines.push(
        "",
        "## customData mentions inside the dice chunk (does dice use custom data?)",
        ...(customInDice.length ? customInDice : ["(none)"]),
        "",
        "## .reference usages (what a custom-data element's `reference` points at)",
        ...(referenceHits.length ? referenceHits.slice(0, 8) : ["(none)"]),
    );
    return lines.join("\n");
}

/** Opens 1d20+5 in PA's own dice panel (the "PA dice panel" roll mode). */
export async function runDicePanelTest(api: unknown): Promise<string[]> {
    const lines = [`=== DICE PANEL TEST ${new Date().toISOString()} ===`];
    const stateNow = (): string =>
        safeStringify({ uiState: get(sraw(api, "dice"), "uiState"), textInput: get(sraw(api, "dice"), "textInput") }, 300);
    lines.push(`PA dice state before: ${stateNow()}`);
    try {
        await openInDicePanel(api, "1d20+5");
        lines.push("openInDicePanel completed without error (loadSystems -> activateTool(\"Dice\") -> setInput)");
    } catch (e) {
        lines.push(`FAILED: ${String(e)}`);
    }
    lines.push(
        `PA dice state after: ${stateNow()}`,
        "Did PA's dice panel open with 1d20+5 in it? If the formula is there but no panel appeared, the tool name string is wrong.",
        "Press Enter in the panel to roll, then check a second account for the toast notification.",
    );
    return lines;
}

/**
 * Focused follow-up scan: how PA's native roll is shared, the dice-expression variable syntax
 * (how an expression references other Custom Data elements), and the tool-name enum behind
 * api.gameplay.activateTool. Also dumps the small dice-related chunks whole.
 */
export async function buildNativeDiceScan(): Promise<string> {
    const lines = [`=== NATIVE DICE / VARIABLE SCAN ${new Date().toISOString()} ===`];
    const urls = viteChunkUrls();
    lines.push(`scanning ${urls.length} chunk(s): ${urls.map((u) => u.split("/").pop() ?? u).join(", ")}`);

    // needle, radius, max hits overall
    const NEEDLES: [string, number, number][] = [
        ["isVariable", 450, 4],
        ["discriminator", 350, 3],
        ["shareWith", 380, 4],
        ["Dice.Roll", 260, 4],
        ["dice-expression", 260, 4],
        ["Dice=", 140, 4],
        ["Dice:`", 140, 4],
        ["selectTool", 260, 3],
    ];
    const hits = new Map<string, string[]>();
    const whole: string[] = [];

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
        try {
            if (/^(DiceFormat|ToggleFormat|dice)-/.test(file)) {
                whole.push(`### ${file} (first 9000 chars)`, text.slice(0, 9000), "");
            }
            for (const [needle, radius, max] of NEEDLES) {
                const arr = hits.get(needle) ?? [];
                for (const sn of snippets(text, needle, radius, max)) if (arr.length < max) arr.push(`[${file}] ${sn}`);
                hits.set(needle, arr);
            }
        } catch (e) {
            lines.push(`  ${file}: ANALYSIS FAILED ${String(e)}`);
        }
    }

    lines.push("");
    for (const [needle] of NEEDLES) {
        const arr = hits.get(needle) ?? [];
        lines.push(`### ${needle}`, ...(arr.length ? arr : ["(no hits)"]));
    }
    lines.push("", "## dice-related chunks, whole", ...(whole.length ? whole : ["(none loaded)"]));
    return lines.join("\n");
}

/** Console handle so specific things can be poked at by hand when asked. */
export function exposeDebugHandle(api: unknown, getShapeId: () => number | undefined): void {
    (window as unknown as Dict).pf1eApi = api;
    (window as unknown as Dict).pf1eDiag = {
        report: () => buildReport(api, getShapeId()),
        quick: () => quickSummary(api),
        state: diagState,
    };
}
