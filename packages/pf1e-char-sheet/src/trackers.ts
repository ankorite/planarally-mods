import type { GameApi, LocalId, Sync, Tracker, TrackerId } from "@planarally/mod-api";

// HP <-> tracker sync. The tracker system is typed by @planarally/mod-api (get / update / remove, and
// "tracker:added" / "tracker:updated" / "tracker:removed" on `api.eventBus`, emitted AFTER the change
// has been applied). Finding the HP tracker by name on any token, and creating one, also need `getAll`
// and `add`: PlanarAlly has them at runtime but the published types don't list them yet, so they are
// checked before use and a server without them degrades gracefully.

/** The HP tracker is matched by name (case-insensitive) so it also adopts a hand-made one. */
export const HP_TRACKER_NAME = "hp";

export function isHpTrackerName(name: unknown): boolean {
    return typeof name === "string" && name.trim().toLowerCase() === HP_TRACKER_NAME;
}

/** A tracker as listed by `getAll`; `temporary` is only set on records PA's UI created. */
export type ListedTracker = Tracker & { temporary?: boolean };

/** The runtime-only tracker functions the published types don't list (yet). */
interface TrackerExtras {
    getAll(shape: LocalId): ListedTracker[];
    add(shape: LocalId, tracker: Tracker & { temporary: boolean }, sync: Sync): void;
}

type FullTrackerSystem = GameApi["systems"]["trackers"] & TrackerExtras;

/** The tracker system with `getAll` / `add`, or undefined if this server doesn't have them. */
export function realTrackers(api: GameApi): FullTrackerSystem | undefined {
    const t = api.systems.trackers as GameApi["systems"]["trackers"] & Partial<TrackerExtras>;
    const ok = typeof t.getAll === "function" && typeof t.add === "function" && typeof t.update === "function";
    return ok ? (t as FullTrackerSystem) : undefined;
}

export function newUuid(): string {
    try {
        // randomUUID only exists on secure contexts; a dev server on plain http lacks it.
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {
        /* fall through to the manual version */
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export function findHpTracker(api: GameApi, shape: LocalId): ListedTracker | undefined {
    return realTrackers(api)
        ?.getAll(shape)
        .find((t) => isHpTrackerName(t.name));
}

export type HpPushResult = "updated" | "created" | "no-tracker" | "unsupported";

/**
 * Pushes the sheet's HP onto the token's HP tracker. With `createIfMissing`, makes the tracker
 * (name "HP", drawn as a bar on the token) when the token doesn't have one yet.
 */
export function pushHp(
    api: GameApi,
    shape: LocalId,
    current: number,
    max: number,
    createIfMissing: boolean,
): HpPushResult {
    const trackers = realTrackers(api);
    if (!trackers) return "unsupported";
    const sync: Sync = { ui: true, server: true };

    const existing = trackers.getAll(shape).find((t) => isHpTrackerName(t.name));
    if (existing) {
        trackers.update(shape, existing.uuid, { value: current, maxvalue: max }, sync);
        return "updated";
    }
    if (!createIfMissing) return "no-tracker";

    trackers.add(
        shape,
        {
            uuid: newUuid() as TrackerId,
            name: "HP",
            value: current,
            maxvalue: max,
            visible: true,
            draw: true,
            // PA's own defaults for a new tracker's colours
            primaryColor: "#00FF00",
            secondaryColor: "#888888",
            temporary: false,
        },
        sync,
    );
    return "created";
}
