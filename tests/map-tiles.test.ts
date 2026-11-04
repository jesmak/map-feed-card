import { describe, expect, it, vi } from "vitest";

import type { HomeAssistant } from "../src/hass";
import { ensureToken, transformRequest } from "../src/map-tiles";

function hass(hassUrl?: string): HomeAssistant {
    return {
        states: {},
        connection: {
            sendMessagePromise: vi.fn(async () => ({ token: "abc123" })),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        },
        ...(hassUrl ? { auth: { data: { hassUrl } } } : {}),
    } as unknown as HomeAssistant;
}

// The token is shared by every card on the page, so the cases run in this order on one module.
describe("a tile request", () => {
    it("carries the token in a header on the page's own origin, so the tile cache survives a new token", async () => {
        await ensureToken(hass());
        expect(transformRequest("/api/map_tiles/tiles/5/17/9.pbf")).toEqual({
            url: `${location.origin}/api/map_tiles/tiles/5/17/9.pbf`,
            headers: { "X-Map-Tiles-Token": "abc123" },
        });
    });

    it("is only made absolute when it isn't the proxy's", () => {
        expect(transformRequest("/static/map/sprites/base.json")).toEqual({ url: `${location.origin}/static/map/sprites/base.json` });
    });

    it("carries the token in the query from another origin, as when cast", async () => {
        await ensureToken(hass("http://ha.example:8123/"));
        expect(transformRequest("/api/map_tiles/tilejson.json?v=2")).toEqual({
            url: "http://ha.example:8123/api/map_tiles/tilejson.json?v=2&token=abc123",
        });
    });
});
