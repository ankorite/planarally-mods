// Which PlanarAlly a bug report came from, for the Diagnostics reports.
//
// PlanarAlly has two versions (server/src/api/http/version.py, GET /api/version, which the client keeps
// in its `coreStore.state.version`):
//   * release - the VERSION file's first line, e.g. "2026.2". A dev build says the same as the release
//     it follows, so this alone doesn't tell dev from stable;
//   * env     - the build: the PA_GIT_INFO environment variable, else `git describe --tags`, else the
//     release. The Docker image sets PA_GIT_INFO to "docker:<tag>-<commit>" (dev images:
//     "docker:dev-<sha>"); images built without the tag and commit say "docker:-".
// The mod API's features say what the server can do for mods, whatever its version says.

export interface ServerVersion {
    release: string;
    env: string;
    /** Where it was read: PlanarAlly's client state, or the server. */
    from: "coreStore" | "/api/version";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The version PlanarAlly loaded at startup (it puts `coreStore` on window), else asked from the server. */
export async function readServerVersion(): Promise<ServerVersion | { error: string }> {
    const store = (window as unknown as { coreStore?: { state?: { version?: unknown } } }).coreStore;
    const loaded = store?.state?.version as { release?: unknown; env?: unknown } | undefined;
    if (str(loaded?.release)) return { release: str(loaded?.release), env: str(loaded?.env), from: "coreStore" };
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch("/api/version", { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) return { error: `GET /api/version -> ${r.status}` };
        const data = (await r.json()) as { release?: unknown; env?: unknown };
        return { release: str(data.release), env: str(data.env), from: "/api/version" };
    } catch (e) {
        return { error: `GET /api/version failed: ${String(e)}` };
    }
}

/** What PlanarAlly's build string says: "docker:dev-0fda2152…" -> Docker image "dev", commit 0fda215. */
export function describeBuild(release: string, env: string): string {
    if (!env) return "no build info";
    const docker = /^docker:(.*?)-([0-9a-f]*)$/i.exec(env);
    if (docker) {
        const [, tag, commit] = docker;
        if (!tag && !commit) return "Docker image built without its tag and commit (no build info)";
        return `Docker image "${tag || "?"}"${commit ? `, commit ${commit.slice(0, 7)}` : ""}`;
    }
    // git describe: "2026.2" on a release tag, "2026.2-15-gabc1234" fifteen commits after it.
    const described = /^v?(.+?)-(\d+)-g([0-9a-f]+)$/i.exec(env);
    if (described) return `git checkout, ${described[2]} commits after ${described[1]} (commit ${described[3]})`;
    if (env === release || env === `v${release}`) return "release build (no commit info)";
    return env;
}

/** One line for the reports: "2026.2 - Docker image "dev", commit 0fda215 (build docker:dev-0fda2152…)". */
export function formatServerVersion(v: ServerVersion | { error: string }): string {
    if ("error" in v) return `unknown (${v.error})`;
    const build = describeBuild(v.release, v.env);
    return `${v.release || "?"} - ${build}${v.env && build !== v.env ? ` (build "${v.env}")` : ""}`;
}

const isFn = (v: unknown): boolean => typeof v === "function";
const at = (root: unknown, ...path: string[]): unknown =>
    path.reduce<unknown>(
        (x, k) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined),
        root,
    );

/** The mod API features the server has, and the oldest mod API version that has them all. */
export function modApiFeatures(api: unknown): { level: string; features: string[] } {
    const features: string[] = [];
    let level = "before 0.2";
    if (isFn(at(api, "compendium", "register"))) {
        features.push("compendium");
        level = "0.2+";
    }
    if (at(api, "components", "Modal") !== undefined) {
        features.push("Modal");
        level = "0.4+";
    }
    if (isFn(at(api, "dice", "roll"))) features.push("dice API");
    if (isFn(at(api, "compendium", "getEntries"))) features.push("compendium.getEntries");
    if (isFn(at(api, "systems", "customData", "loadAndDropState"))) features.push("customData.loadAndDropState");
    if (isFn(at(api, "dice", "roll")) && isFn(at(api, "compendium", "getEntries"))) level = "0.6+";
    return { level, features };
}

export function formatModApi(api: unknown): string {
    const { level, features } = modApiFeatures(api);
    return `${level}${features.length ? ` (${features.join(", ")})` : ""}`;
}
