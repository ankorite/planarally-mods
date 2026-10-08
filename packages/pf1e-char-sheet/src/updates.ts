// Checks GitHub for a newer version of this mod, so the DM can be told on the sheet.
//
// The mod's mod.toml on the repository's main branch is read straight from raw.githubusercontent.com,
// which allows cross-origin reads of public repositories. It is fetched at most once per page load,
// and any failure (offline, repository made private, file moved) just means no message.

export const REPO_URL = "https://github.com/ankorite/planarally-mods";
const REMOTE_MOD_TOML =
    "https://raw.githubusercontent.com/ankorite/planarally-mods/main/packages/pf1e-char-sheet/mod.toml";

/** -1, 0 or 1: "0.21.0" vs "0.22.0" -> -1. Missing parts count as 0; non-numbers compare as 0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
}

/** The `version = "..."` of a mod.toml. */
export function tomlVersion(toml: string): string | undefined {
    return /^\s*version\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
}

let latest: Promise<string | undefined> | undefined;

/** The version on GitHub's main branch, fetched once per page load; undefined if unavailable. */
function latestVersion(): Promise<string | undefined> {
    latest ??= (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
            const r = await fetch(REMOTE_MOD_TOML, { signal: ctrl.signal });
            return r.ok ? tomlVersion(await r.text()) : undefined;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    })();
    return latest;
}

/** The newer version available on GitHub, or undefined when `installed` is current (or newer). */
export async function newerVersion(installed: string | undefined): Promise<string | undefined> {
    if (!installed) return undefined;
    const remote = await latestVersion();
    return remote && compareVersions(remote, installed) > 0 ? remote : undefined;
}
