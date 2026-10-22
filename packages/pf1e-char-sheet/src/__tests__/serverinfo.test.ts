import { afterEach, describe, expect, it, vi } from "vitest";

import { describeBuild, formatModApi, formatServerVersion, readServerVersion } from "../serverinfo";

afterEach(() => {
    delete (window as unknown as { coreStore?: unknown }).coreStore;
    vi.unstubAllGlobals();
});

describe("server version", () => {
    it("explains PlanarAlly's build string", () => {
        expect(describeBuild("2026.2", "docker:dev-0fda2152c1e8a9b7")).toBe('Docker image "dev", commit 0fda215');
        expect(describeBuild("2026.2", "docker:v2026.2-abc1234def")).toBe('Docker image "v2026.2", commit abc1234');
        expect(describeBuild("2026.2", "docker:docker-pr-12-abc1234")).toBe(
            'Docker image "docker-pr-12", commit abc1234',
        );
        expect(describeBuild("2026.2", "docker:-")).toBe(
            "Docker image built without its tag and commit (no build info)",
        );
        expect(describeBuild("2026.2", "2026.2-15-gc9146b2")).toBe(
            "git checkout, 15 commits after 2026.2 (commit c9146b2)",
        );
        expect(describeBuild("2026.2", "2026.2")).toBe("release build (no commit info)");
        expect(describeBuild("2026.2", "")).toBe("no build info");
        expect(describeBuild("2026.2", "my-own-build")).toBe("my-own-build");
    });

    it("formats one line for the reports", () => {
        expect(formatServerVersion({ release: "2026.2", env: "docker:dev-0fda2152", from: "coreStore" })).toBe(
            '2026.2 - Docker image "dev", commit 0fda215 (build "docker:dev-0fda2152")',
        );
        expect(formatServerVersion({ release: "2026.2", env: "my-own-build", from: "coreStore" })).toBe(
            "2026.2 - my-own-build",
        );
        expect(formatServerVersion({ error: "GET /api/version -> 404" })).toBe("unknown (GET /api/version -> 404)");
    });

    it("reads PlanarAlly's loaded version first, else asks the server", async () => {
        (window as unknown as { coreStore: unknown }).coreStore = {
            state: { version: { release: "2026.2", env: "docker:dev-abc" } },
        };
        expect(await readServerVersion()).toEqual({ release: "2026.2", env: "docker:dev-abc", from: "coreStore" });

        delete (window as unknown as { coreStore?: unknown }).coreStore;
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response(JSON.stringify({ release: "2026.2", env: "2026.2" }), { status: 200 })),
        );
        vi.stubGlobal("fetch", fetchMock);
        expect(await readServerVersion()).toEqual({ release: "2026.2", env: "2026.2", from: "/api/version" });
        expect(fetchMock).toHaveBeenCalledWith("/api/version", expect.anything());

        vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 500 })));
        expect(await readServerVersion()).toEqual({ error: "GET /api/version -> 500" });
    });

    it("tells the mod API level from its features", () => {
        const fn = () => undefined;
        expect(formatModApi({})).toBe("before 0.2");
        expect(formatModApi({ compendium: { register: fn }, components: { Modal: {} } })).toBe(
            "0.4+ (compendium, Modal)",
        );
        expect(
            formatModApi({
                compendium: { register: fn, getEntries: fn },
                components: { Modal: {} },
                dice: { roll: fn },
                systems: { customData: { loadAndDropState: fn } },
            }),
        ).toBe("0.6+ (compendium, Modal, dice API, compendium.getEntries, customData.loadAndDropState)");
    });
});
