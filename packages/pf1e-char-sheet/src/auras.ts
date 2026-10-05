import type { GameApi, LocalId } from "@planarally/mod-api";

import type { SheetAura } from "./data";
import { newUuid } from "./trackers";

// Creates / updates / removes the auras derived from the Hero Lab specials on the token.
//
// Written against PlanarAlly's real runtime aura system, verified with the diagnostics build (the
// published mod-api types don't describe auras at all): getAll / add / update / remove, no events.
// The record shape below is PA's own default "New aura" as dumped from a live server.
//
// Auras the sheet creates are tracked by key -> PA uuid (stored with the character), never by
// name, so renaming one in PA is fine and auras you made by hand are never touched.

interface Sync {
    ui: boolean;
    server: boolean;
}

interface RealAura {
    uuid: string;
    active: boolean;
    visionSource: boolean;
    visible: boolean;
    name: string;
    value: number;
    dim: number;
    colour: string;
    borderColour: string;
    angle: number;
    direction: number;
    floodLight: boolean;
    temporary?: boolean;
}

interface RealAuraSystem {
    getAll(shape: number): RealAura[];
    add(shape: number, aura: RealAura, sync: Sync): void;
    update(shape: number, uuid: string, delta: Partial<RealAura>, sync: Sync): void;
    remove(shape: number, uuid: string, sync: Sync): void;
}

export function realAuras(api: GameApi): RealAuraSystem | undefined {
    const a = (api.systems as unknown as { auras?: Partial<RealAuraSystem> }).auras;
    if (!a) return undefined;
    const ok =
        typeof a.getAll === "function" &&
        typeof a.add === "function" &&
        typeof a.update === "function" &&
        typeof a.remove === "function";
    return ok ? (a as RealAuraSystem) : undefined;
}

/**
 * `value` is the radius in the location's map unit - feet in PA's default setup, which is what
 * Hero Lab uses. A table whose location unit isn't feet would need the radius converted.
 */
function makeAura(want: SheetAura, uuid: string): RealAura {
    const base = {
        uuid,
        active: true,
        name: want.name,
        value: want.radius,
        dim: 0,
        angle: 360,
        direction: 0,
        floodLight: false,
        temporary: false,
    };
    return want.kind === "vision"
        ? // Darkvision: a vision source nobody sees drawn - exactly PA's default aura, with our radius.
          { ...base, visionSource: true, visible: false, colour: "rgba(0,0,0,0)", borderColour: "rgba(0,0,0,0)" }
        : // Aura of Courage etc.: a visible radius so the table can see who is inside it.
          {
              ...base,
              visionSource: false,
              visible: true,
              colour: "rgba(66, 135, 245, 0.18)",
              borderColour: "rgba(66, 135, 245, 0.7)",
          };
}

export interface AuraSyncOutcome {
    /** `desired`, each carrying the PA uuid of its aura on the token. Store this with the character. */
    auras: SheetAura[];
    /** Human-readable result; empty when there was nothing to do. */
    summary: string;
}

/**
 * Brings the token's auras in line with `desired`:
 *   - a desired aura that exists (found by the uuid we stored last time) only has its radius updated;
 *   - one that is missing (first import, or you deleted it) is created;
 *   - one we created before that Hero Lab no longer has is removed.
 * To hide an aura without it coming back on the next import, switch it off in PA instead of deleting it.
 */
export function syncAuras(
    api: GameApi,
    shape: LocalId,
    desired: SheetAura[],
    previous: SheetAura[],
): AuraSyncOutcome {
    const strip = (list: SheetAura[]): SheetAura[] => list.map((a) => ({ ...a, uuid: "" }));
    if (desired.length === 0 && previous.length === 0) return { auras: [], summary: "" };

    const sys = realAuras(api);
    if (!sys) {
        return { auras: strip(desired), summary: "This server doesn't support creating auras from mods." };
    }

    const sync: Sync = { ui: true, server: true };
    const live = sys.getAll(shape);
    const previousByKey = new Map(previous.map((a) => [a.key, a]));
    const created: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const out: SheetAura[] = [];

    for (const want of desired) {
        const prevUuid = previousByKey.get(want.key)?.uuid;
        const existing = prevUuid ? live.find((a) => a.uuid === prevUuid) : undefined;
        if (existing) {
            if (existing.value !== want.radius) {
                sys.update(shape, existing.uuid, { value: want.radius }, sync);
                updated.push(`${want.name} ${want.radius} ft`);
            }
            out.push({ ...want, uuid: existing.uuid });
        } else {
            const uuid = newUuid();
            sys.add(shape, makeAura(want, uuid), sync);
            created.push(`${want.name} ${want.radius} ft`);
            out.push({ ...want, uuid });
        }
    }

    const wanted = new Set(desired.map((a) => a.key));
    for (const prev of previous) {
        if (wanted.has(prev.key) || !prev.uuid) continue;
        if (live.some((a) => a.uuid === prev.uuid)) {
            sys.remove(shape, prev.uuid, sync);
            removed.push(prev.name);
        }
    }

    const parts: string[] = [];
    if (created.length) parts.push(`created ${created.join(", ")}`);
    if (updated.length) parts.push(`updated ${updated.join(", ")}`);
    if (removed.length) parts.push(`removed ${removed.join(", ")}`);
    return { auras: out, summary: parts.length ? `Auras: ${parts.join("; ")}.` : "" };
}
