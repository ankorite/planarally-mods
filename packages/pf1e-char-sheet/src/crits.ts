import type { GameApi } from "@planarally/mod-api";
import { watch } from "vue";

// A natural 20 or natural 1 on any d20 plays a short animation over the map.
//
// Every roll a player sees lands in PlanarAlly's dice history (`systemsState.dice.reactive.history`,
// read from its source): rolls from its dice panel (2d or 3d, after the 3d dice settle), rolls other
// players share with this player, and this sheet's quick rolls with the result card on. Each entry is
// `{ roll: { parts, result }, player, name }`, and a die part (dice library DX) has `die: "d20"` and
// `output: [{ roll, status? }]`, status "dropped"/"overridden" for dice that don't count (the lower d20
// of "keep highest"). So this watches the history and checks the d20s that count.
//
// It is the viewer's choice whether to see it (Config tab, kept per browser). It never blocks clicks,
// and with the system's "reduce motion" setting it fades instead of bursting and shaking.

const ENABLED_KEY = "pf1e-sheet-crit-fx";
const STYLE_ID = "pf1e-crit-style";
const DURATION_MS = 1800;

interface HistoryEntry {
    roll?: { parts?: unknown[]; result?: string };
    player?: string;
    name?: string;
}

export type Natural = "nat20" | "nat1";

let stopWatch: (() => void) | undefined;

/** Whether this browser shows the animation (on unless switched off on the Config tab). */
export function critFxEnabled(): boolean {
    try {
        return localStorage.getItem(ENABLED_KEY) !== "off";
    } catch {
        return true;
    }
}

export function setCritFxEnabled(on: boolean): void {
    try {
        localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
    } catch {
        /* not remembered; applies for now anyway */
    }
}

/**
 * Whether a roll has a natural 20 or 1 on a d20 that counts (kept). A 20 wins over a 1 when a roll has
 * both (two separate d20s in one formula).
 */
export function naturalOf(roll: unknown): Natural | undefined {
    const parts = (roll as { parts?: unknown[] } | undefined)?.parts;
    if (!Array.isArray(parts)) return undefined;
    let found: Natural | undefined;
    for (const part of parts) {
        const p = part as { die?: unknown; output?: unknown };
        if (p.die !== "d20" || !Array.isArray(p.output)) continue;
        for (const die of p.output as { roll?: unknown; status?: unknown }[]) {
            const face = typeof die === "number" ? die : die?.roll;
            const status = typeof die === "object" ? die?.status : undefined;
            if (status === "dropped" || status === "overridden") continue;
            if (face === 20) return "nat20";
            if (face === 1) found = "nat1";
        }
    }
    return found;
}

/** Starts watching PlanarAlly's dice history; call once from initGame. */
export function installCritWatcher(api: GameApi): void {
    stopWatch?.();
    const dice = (api.systemsState as unknown as Record<string, unknown>)["dice"] as
        | { reactive?: { history?: HistoryEntry[] } }
        | undefined;
    const history = dice?.reactive?.history;
    if (!dice?.reactive || !Array.isArray(history)) {
        console.info("[pf1e-sheet] natural 20/1 effect: this PlanarAlly has no dice history to watch");
        return;
    }
    // Rolls already in the history (made before the mod loaded) are not replayed.
    let seen = history.length;
    stopWatch = watch(
        () => dice.reactive?.history?.length ?? 0,
        (length) => {
            const list = dice.reactive?.history ?? [];
            if (length < seen) seen = 0; // the history was cleared (a new location loaded)
            const fresh = list.slice(seen);
            seen = length;
            for (const entry of fresh) {
                const natural = naturalOf(entry.roll);
                if (natural) playCrit(natural, entry.player ?? "", entry.name ?? "");
            }
        },
    );
}

export function disposeCritWatcher(): void {
    stopWatch?.();
    stopWatch = undefined;
    document.getElementById(STYLE_ID)?.remove();
    document.querySelectorAll(".pf1e-crit").forEach((el) => el.remove());
}

/** Shows the animation for a natural 20 or 1 (if this browser has it on). */
export function playCrit(natural: Natural, player: string, what: string): void {
    if (!critFxEnabled()) return;
    ensureStyle();
    const overlay = document.createElement("div");
    overlay.className = `pf1e-crit ${natural}`;
    overlay.setAttribute("aria-live", "polite");
    const title = document.createElement("div");
    title.className = "pf1e-crit-title";
    title.textContent = natural === "nat20" ? "NATURAL 20!" : "NATURAL 1";
    const sub = document.createElement("div");
    sub.className = "pf1e-crit-sub";
    sub.textContent = [player, what.trim()].filter(Boolean).join(" · ");
    overlay.append(title, sub);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), DURATION_MS);
}

/** The animation's styles, added to the page once (the overlay lives outside the sheet). */
function ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.pf1e-crit {
    position: fixed; inset: 0; z-index: 100000; pointer-events: none;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: Georgia, "Times New Roman", serif; text-align: center;
    animation: pf1e-crit-fade ${DURATION_MS}ms ease-out forwards;
}
.pf1e-crit-title { font-size: clamp(2.5rem, 9vw, 6.5rem); font-weight: 900; letter-spacing: 0.04em; line-height: 1; }
.pf1e-crit-sub { margin-top: 0.6rem; font-size: clamp(1rem, 2.4vw, 1.6rem); font-weight: 700; }
.pf1e-crit.nat20 { background: radial-gradient(circle, rgba(255, 215, 64, 0.55) 0%, rgba(255, 170, 0, 0.18) 35%, transparent 65%); }
.pf1e-crit.nat20 .pf1e-crit-title {
    color: #ffd84a; -webkit-text-stroke: 2px #6b3e00;
    text-shadow: 0 0 18px #fff3a0, 0 0 40px #ffb300, 0 4px 0 #6b3e00;
    animation: pf1e-crit-burst ${DURATION_MS}ms cubic-bezier(0.2, 1.4, 0.4, 1) forwards;
}
.pf1e-crit.nat20 .pf1e-crit-sub { color: #fff8d6; text-shadow: 0 2px 6px #000; }
.pf1e-crit.nat1 { background: radial-gradient(circle, rgba(120, 0, 0, 0.5) 0%, rgba(60, 0, 0, 0.25) 40%, transparent 70%); }
.pf1e-crit.nat1 .pf1e-crit-title {
    color: #ff3b30; -webkit-text-stroke: 2px #2a0000;
    text-shadow: 0 0 20px #8b0000, 0 4px 0 #2a0000;
    animation: pf1e-crit-shake ${DURATION_MS}ms ease-out forwards;
}
.pf1e-crit.nat1 .pf1e-crit-sub { color: #ffd6d6; text-shadow: 0 2px 6px #000; }
@keyframes pf1e-crit-fade { 0% { opacity: 0; } 8% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }
@keyframes pf1e-crit-burst {
    0% { transform: scale(0.2) rotate(-8deg); } 25% { transform: scale(1.15) rotate(2deg); }
    40% { transform: scale(1) rotate(0); } 100% { transform: scale(1.06); }
}
@keyframes pf1e-crit-shake {
    0% { transform: translateY(-40px) scale(1.3); } 15% { transform: translateY(0) scale(1); }
    20% { transform: translateX(-14px) rotate(-3deg); } 25% { transform: translateX(12px) rotate(2deg); }
    30% { transform: translateX(-9px) rotate(-1deg); } 35% { transform: translateX(6px); }
    40% { transform: translateX(0); } 100% { transform: translateY(12px) rotate(4deg); }
}
@media (prefers-reduced-motion: reduce) {
    .pf1e-crit .pf1e-crit-title { animation: none !important; }
}`;
    document.head.appendChild(style);
}
