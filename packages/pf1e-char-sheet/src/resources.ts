import type { GameApi, LocalId, Sync, TrackerId } from "@planarally/mod-api";

import type { SheetResource } from "./data";
import { isHpTrackerName, newUuid, realTrackers } from "./trackers";

// Keeps the character's limited-use abilities (Hero Lab's tracked resources: x/day, x/round) and
// spell slots per day as PlanarAlly trackers on the token, so uses can be ticked off in play.
//
// Like auras, the trackers the sheet manages are remembered by key -> PA uuid (stored with the
// character). A tracker's current value is play state, so syncing only creates missing trackers,
// updates the maximum (and the name, unless it was renamed in PA), and removes trackers the sheet
// manages for resources that are gone - it never refills or overwrites the current value (except to
// clamp it to a lower maximum).
//
// The sheet keeps every resource's uses left itself (`left`), tracker or not, so switching a tracker
// off and on again doesn't lose count. A tracker that exists is the truth for its resource (it may
// have been changed in PlanarAlly); a new tracker starts from the sheet's count.
//
// A resource the sheet doesn't manage yet first adopts an existing tracker with exactly its name, so
// a token that already has a hand-made "Darkness (3/day)" doesn't get a second one. Every other
// tracker made by hand, and the HP tracker, is never touched.

export interface ResourceSyncOutcome {
    /** `desired`, each carrying the PA uuid of its tracker. Store this with the character. */
    resources: SheetResource[];
    /** Human-readable result; empty when there was nothing to do. */
    summary: string;
}

/**
 * Brings the token's resource trackers in line with `desired`. `visible` decides whether other
 * players see them (true for characters, false for the DM's monsters and NPCs). The trackers are
 * not drawn as bars on the token, which would bury it under a pile of bars.
 */
export function syncResources(
    api: GameApi,
    shape: LocalId,
    desired: SheetResource[],
    previous: SheetResource[],
    visible: boolean,
): ResourceSyncOutcome {
    const strip = (list: SheetResource[]): SheetResource[] => list.map((r) => ({ ...r, uuid: "" }));
    if (desired.length === 0 && previous.length === 0) return { resources: [], summary: "" };

    const trackers = realTrackers(api);
    if (!trackers) {
        return { resources: strip(desired), summary: "This server doesn't support creating trackers from mods." };
    }

    const sync: Sync = { ui: true, server: true };
    const live = trackers.getAll(shape).filter((t) => t.temporary !== true);
    const previousByKey = new Map(previous.map((r) => [r.key, r]));
    const created: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const out: SheetResource[] = [];

    // Trackers that belong to some resource already, so name adoption can't steal one of them.
    const owned = new Set([...previous, ...desired].map((r) => r.uuid).filter(Boolean));

    for (const want of desired) {
        const prev = previousByKey.get(want.key);
        const prevUuid = prev?.uuid;
        let existing = prevUuid ? live.find((t) => t.uuid === prevUuid) : undefined;
        if (!existing) {
            const sameName = want.name.trim().toLowerCase();
            existing = live.find((t) => !owned.has(t.uuid) && t.name.trim().toLowerCase() === sameName);
            if (existing) owned.add(existing.uuid);
        }
        if (existing) {
            const delta: { maxvalue?: number; value?: number; name?: string } = {};
            let left = existing.value;
            if (existing.maxvalue !== want.max) {
                delta.maxvalue = want.max;
                if (existing.value > want.max) delta.value = left = want.max;
            }
            // Follow Hero Lab's name ("20 rounds/day" -> "22 rounds/day") unless it was renamed in PA.
            if (prev && existing.name === prev.name && existing.name !== want.name) delta.name = want.name;
            if (Object.keys(delta).length) {
                trackers.update(shape, existing.uuid, delta, sync);
                updated.push(`${want.name} (max ${want.max})`);
            }
            out.push({
                ...want,
                uuid: existing.uuid,
                left: Number.isFinite(left) ? Math.max(0, left) : usesLeft(want),
            });
        } else {
            // A resource named "HP" would be adopted as the HP tracker by name; never create one.
            if (isHpTrackerName(want.name)) continue;
            const uuid = newUuid() as TrackerId;
            trackers.add(
                shape,
                {
                    uuid,
                    name: want.name,
                    value: usesLeft(want),
                    maxvalue: want.max,
                    visible,
                    draw: false,
                    primaryColor: "#3B82F6",
                    secondaryColor: "#888888",
                    temporary: false,
                },
                sync,
            );
            created.push(want.name);
            out.push({ ...want, uuid });
        }
    }

    const wanted = new Set(desired.map((r) => r.key));
    for (const prev of previous) {
        if (wanted.has(prev.key) || !prev.uuid) continue;
        if (live.some((t) => t.uuid === prev.uuid)) {
            api.systems.trackers.remove(shape, prev.uuid as TrackerId, sync);
            removed.push(prev.name);
        }
    }

    // Name a few; past that just count them (the Resources tab lists every one).
    const list = (names: string[]): string => (names.length <= 5 ? ` (${names.join(", ")})` : "");
    const parts: string[] = [];
    if (created.length) parts.push(`created ${created.length}${list(created)}`);
    if (updated.length) parts.push(`updated ${updated.length}${list(updated)}`);
    if (removed.length) parts.push(`removed ${removed.length}${list(removed)}`);
    const many = created.length > 5 || updated.length > 5 || removed.length > 5;
    return {
        resources: out,
        summary: parts.length ? `Trackers: ${parts.join("; ")}${many ? " - listed on the Resources tab" : ""}.` : "",
    };
}

/** The resource key a Hero Lab name maps to (the parser's rule): "Darkness (3/day)" -> "res:darkness". */
export function resourceKeyForName(name: string): string {
    return `res:${name
        .replace(/\s*\(.*$/, "")
        .trim()
        .toLowerCase()}`;
}

/**
 * syncResources for the resources that are switched on (not in `untracked`): a switched-off resource
 * that has a tracker loses it, a switched-on one without a tracker gets one. Returns every resource -
 * switched-off ones with an empty uuid - so the full list stays stored with the character.
 */
export function syncTrackedResources(
    api: GameApi,
    shape: LocalId,
    all: SheetResource[],
    previous: SheetResource[],
    untracked: string[],
    visible: boolean,
): ResourceSyncOutcome {
    const off = new Set(untracked);
    // A tracker about to be removed hands its count to the sheet first.
    const live = new Map<string, number>((realTrackers(api)?.getAll(shape) ?? []).map((t) => [t.uuid, t.value]));
    all = all.map((r) => {
        const value = r.uuid ? live.get(r.uuid) : undefined;
        return value !== undefined && Number.isFinite(value) ? { ...r, left: Math.max(0, Math.min(r.max, value)) } : r;
    });
    const result = syncResources(
        api,
        shape,
        all.filter((r) => !off.has(r.key)),
        previous,
        visible,
    );
    const synced = new Map(result.resources.map((r) => [r.key, r]));
    return { resources: all.map((r) => synced.get(r.key) ?? { ...r, uuid: "" }), summary: result.summary };
}

/**
 * How a resource's uses come back, for labels: "4 per day", "20 rounds per day", "50 charges". Hero
 * Lab's tracked resources mix daily abilities with items that have charges (wands), which never
 * recharge, so the label follows the name rather than assuming "per day". Trackers never refill on
 * their own either way: only a fresh tracker starts full.
 */
export function resourceLabel(r: Pick<SheetResource, "key" | "name" | "max">): string {
    const name = r.name.toLowerCase();
    if (r.key.startsWith("slots:")) return `${r.max} per day`;
    if (/rounds?\s*(?:\/|per\s+)day/.test(name)) return `${r.max} rounds per day`;
    if (/(?:\/|per\s+)day\b/.test(name)) return `${r.max} per day`;
    if (/(?:\/|per\s+)week\b/.test(name)) return `${r.max} per week`;
    if (/\bcharges?\b|\bwand\b|\bstaff\b|\brod\b/.test(name)) return `${r.max} charges`;
    return `${r.max} uses`;
}

/** Uses left on the sheet: the kept count, or what Hero Lab exported, within 0..max. */
export function usesLeft(r: Pick<SheetResource, "max" | "used" | "left">): number {
    const left = r.left ?? r.max - r.used;
    return Math.min(r.max, Math.max(0, Number.isFinite(left) ? left : r.max));
}

/**
 * On a re-import, keeps the uses left of the resources the character already had (matched by key):
 * full stays full at the new maximum, otherwise the count is kept, capped at the new maximum. New
 * resources start from Hero Lab's numbers.
 */
export function carryUsesLeft(next: SheetResource[], prev: SheetResource[]): SheetResource[] {
    const byKey = new Map(prev.map((r) => [r.key, r]));
    return next.map((r) => {
        const old = byKey.get(r.key);
        if (!old || old.left === undefined) return r;
        const was = usesLeft(old);
        return { ...r, left: was >= old.max ? r.max : Math.min(was, r.max) };
    });
}

/** Whether a resource comes back after a night's rest (x/day, rounds/day, spell slots), not charges. */
export function refillsDaily(r: Pick<SheetResource, "key" | "name" | "max">): boolean {
    return resourceLabel(r).endsWith(" per day");
}

/** Sets a resource's tracker on the token to `left`, if it has one. Returns whether it did. */
export function pushUsesLeft(api: GameApi, shape: LocalId, r: SheetResource, left: number): boolean {
    if (!r.uuid) return false;
    const trackers = realTrackers(api);
    const live = trackers?.getAll(shape).find((t) => t.uuid === r.uuid);
    if (!trackers || !live) return false;
    if (live.value !== left) trackers.update(shape, r.uuid as TrackerId, { value: left }, { ui: true, server: true });
    return true;
}
