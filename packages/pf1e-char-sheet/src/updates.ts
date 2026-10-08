// Checks GitHub for a newer version of this mod, so the DM can be told on the sheet.
//
// The mod's mod.toml on the repository's main branch is read straight from raw.githubusercontent.com,
// which allows cross-origin reads of public repositories. It is fetched at most once per page load.
// A failure (offline, blocked by the server's Content-Security-Policy or a browser extension,
// repository made private, file moved) means no banner, but the outcome is always written to the
// browser console as "[pf1e-sheet] update check: ...", so a missing banner can be explained.

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

const LOG = "[pf1e-sheet] update check:";

let latest: Promise<string | undefined> | undefined;

/** The version on GitHub's main branch, fetched once per page load; undefined if unavailable. */
function latestVersion(): Promise<string | undefined> {
    latest ??= (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
            const r = await fetch(REMOTE_MOD_TOML, { signal: ctrl.signal });
            if (!r.ok) {
                console.warn(`${LOG} GitHub answered ${r.status} ${r.statusText} for ${REMOTE_MOD_TOML}`);
                return undefined;
            }
            const version = tomlVersion(await r.text());
            if (!version) console.warn(`${LOG} no version found in ${REMOTE_MOD_TOML}`);
            return version;
        } catch (e) {
            const reason = ctrl.signal.aborted ? "no answer within 8 seconds" : String(e);
            console.warn(
                `${LOG} couldn't reach GitHub (${REMOTE_MOD_TOML}): ${reason}. ` +
                    "If the browser console also shows a Content-Security-Policy (connect-src) or CORS error, " +
                    "the PlanarAlly server or a browser extension is blocking the request.",
            );
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    })();
    return latest;
}

let logged = false;
/** Logs the outcome once per page load (the check runs each time a DM opens a sheet). */
function logOnce(fn: () => void): void {
    if (logged) return;
    logged = true;
    fn();
}

/** The newer version available on GitHub, or undefined when `installed` is current (or newer). */
export async function newerVersion(installed: string | undefined): Promise<string | undefined> {
    if (!installed) {
        logOnce(() => console.warn(`${LOG} the installed version is unknown, so there is nothing to compare.`));
        return undefined;
    }
    const remote = await latestVersion();
    if (!remote) return undefined; // the reason was logged by latestVersion
    const newer = compareVersions(remote, installed) > 0;
    logOnce(() =>
        console.info(
            `${LOG} installed ${installed}, GitHub has ${remote} - ` +
                (newer ? "update available." : "up to date (the banner only shows for a newer version)."),
        ),
    );
    return newer ? remote : undefined;
}

/** Logs that a found update isn't shown because it was dismissed with the banner's ✕. */
let loggedDismissed = false;
export function logDismissed(version: string, storageKey: string): void {
    if (loggedDismissed) return;
    loggedDismissed = true;
    console.info(
        `${LOG} ${version} was dismissed with the banner's ✕, so it isn't shown again. To bring it back, run ` +
            `localStorage.removeItem("${storageKey}") in this console and reload.`,
    );
}
