import type { GameApi, LocalId } from "@planarally/mod-api";

// HP <-> tracker sync, written against what a live PlanarAlly server (release 2026.2) ACTUALLY
// exposes, verified by running the diagnostics build against it - not against the published
// @planarally/mod-api types, which describe `getOrCreate` / `preTrackerUpdate` and similar names
// that don't exist at runtime. The real tracker system has add / getAll / get / update / remove,
// and PA announces changes on `api.eventBus` ("tracker:added" / "tracker:updated" /
// "tracker:removed"), emitted AFTER the change has been applied.

/** The HP tracker is matched by name (case-insensitive) so it also adopts a hand-made one. */
export const HP_TRACKER_NAME = "hp";

export function isHpTrackerName(name: unknown): boolean {
    return typeof name === "string" && name.trim().toLowerCase() === HP_TRACKER_NAME;
}

interface Sync {
    ui: boolean;
    server: boolean;
}

/** A tracker record as stored by PA. `temporary` is only set on records the UI created. */
export interface RealTracker {
    uuid: string;
    name: string;
    value: number;
    maxvalue: number;
    visible: boolean;
    draw: boolean;
    primaryColor: string;
    secondaryColor: string;
    temporary?: boolean;
}

interface RealTrackerSystem {
    getAll(shape: number): RealTracker[];
    get(shape: number, uuid: string): RealTracker | undefined;
    add(shape: number, tracker: RealTracker, sync: Sync): void;
    update(shape: number, uuid: string, delta: Partial<RealTracker>, sync: Sync): void;
}

/** The real tracker system, or undefined if this server doesn't have the methods we need. */
export function realTrackers(api: GameApi): RealTrackerSystem | undefined {
    const t = api.systems.trackers as unknown as Partial<RealTrackerSystem>;
    const ok = typeof t.getAll === "function" && typeof t.add === "function" && typeof t.update === "function";
    return ok ? (t as RealTrackerSystem) : undefined;
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

export function findHpTracker(api: GameApi, shape: LocalId): RealTracker | undefined {
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
            uuid: newUuid(),
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

/** Subscribes to a PA event-bus event. Returns false if this server has no usable event bus. */
export function subscribeToBus(api: GameApi, event: string, cb: (payload: unknown) => void): boolean {
    const bus = (api as unknown as { eventBus?: { on?: (name: string, cb: (payload: unknown) => void) => unknown } })
        .eventBus;
    if (!bus || typeof bus.on !== "function") return false;
    bus.on(event, cb);
    return true;
}
