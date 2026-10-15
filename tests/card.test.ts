import { afterEach, describe, expect, it, vi } from "vitest";

import type { HomeAssistant } from "../src/hass";
import { feedState, shipFeature, trainFeature } from "./support/fakes";

// happy-dom has no WebGL, and the tile proxy is Home Assistant's; the card is tested without its map.
const drawn = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>>, fits: 0 }));
vi.mock("../src/map", () => ({
    FeedMap: class {
        async init() {}
        async setStyle() {}
        update(content: Record<string, unknown>) {
            drawn.updates.push(content);
        }
        fit() {
            drawn.fits += 1;
        }
        reveal() {}
        resize() {}
        destroy() {}
    },
}));
vi.mock("../src/map-tiles", () => ({ ensureToken: async () => {} }));

const { MapFeedCard } = await import("../src/map-feed-card");

function hass(states: Record<string, ReturnType<typeof feedState>>): HomeAssistant {
    return {
        states,
        entities: { "sensor.trains": { platform: "digitraffic_live" } },
        connection: { sendMessagePromise: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
        themes: { darkMode: true },
        locale: { language: "en" },
        callService: vi.fn(async () => ({ response: { details: [{ label: "Cars", value: "7" }] } })),
    };
}

async function mount(config: Record<string, unknown>, states: Record<string, ReturnType<typeof feedState>>) {
    const card = document.createElement("map-feed-card") as InstanceType<typeof MapFeedCard>;
    card.setConfig({ type: "custom:map-feed-card", ...config });
    card.hass = hass(states);
    document.body.append(card);
    await card.updateComplete;
    // The map starts after the first render, and draws on the next.
    await new Promise((resolve) => setTimeout(resolve));
    await card.updateComplete;
    return card;
}

function shadowText(card: HTMLElement): string {
    return card.shadowRoot!.textContent!.replace(/\s+/g, " ");
}

afterEach(() => {
    document.body.innerHTML = "";
    drawn.updates = [];
    drawn.fits = 0;
});

describe("map-feed-card", () => {
    it("offers the first map feed from the card picker", () => {
        const states = {
            "light.kitchen": { entity_id: "light.kitchen", state: "on", attributes: {} },
            "sensor.trains": feedState("sensor.trains", []),
        };
        expect(MapFeedCard.getStubConfig(hass(states))).toEqual({ entities: ["sensor.trains"] });
    });

    it("draws the feed's points, fits the map to them once, and asks for a tap", async () => {
        const card = await mount(
            { entities: [{ entity: "sensor.trains", color_by: "delay" }] },
            { "sensor.trains": feedState("sensor.trains", [trainFeature()]) },
        );
        const content = drawn.updates.at(-1)!;
        expect(content.points).toHaveLength(1);
        expect((content.points as Array<{ key: string; color: string }>)[0]).toMatchObject({
            key: "sensor.trains|train:2026-09-14/8",
            color: "#c62828",
        });
        expect(drawn.fits).toBe(1);
        expect(shadowText(card)).toContain("Select an item on the map");
        // The delay legend is the card's own, with the feed's thresholds.
        const legend = [...card.shadowRoot!.querySelectorAll(".legend span")].map((entry) => entry.textContent);
        expect(legend).toEqual(["on time", "3+ min", "10+ min"]);
    });

    it("shows the selected item's details and loads its detail action from its own integration", async () => {
        const states = { "sensor.trains": feedState("sensor.trains", [trainFeature()]) };
        const card = await mount({ entities: ["sensor.trains"] }, states);
        (card as unknown as { select(key: string): void }).select("sensor.trains|train:2026-09-14/8");
        await card.updateComplete;
        await new Promise((resolve) => setTimeout(resolve));
        await card.updateComplete;
        const text = shadowText(card);
        expect(text).toContain("Joensuu → Helsinki");
        expect(text).toContain("11 min late");
        expect(text).toContain("Juna on myöhässä ratatöiden vuoksi.");
        expect(text).toContain("Cars");
        expect(card.hass!.callService).toHaveBeenCalledWith(
            "digitraffic_live",
            "get_train_composition",
            expect.anything(),
            undefined,
            false,
            true,
        );
    });

    it("colours by delay only what can be late, and explains both colourings", async () => {
        const legend = [{ color: "#2e7d32", label: "Harbour" }];
        const both = await mount(
            { entities: [{ entity: "sensor.mixed", color_by: "delay" }] },
            { "sensor.mixed": feedState("sensor.mixed", [trainFeature(), shipFeature()], { legend }) },
        );
        const colours = (drawn.updates.at(-1)!.points as Array<{ color: string }>).map((point) => point.color);
        expect(colours).toEqual(["#c62828", "#ef6c00"]);
        const labels = [...both.shadowRoot!.querySelectorAll(".legend span")].map((entry) => entry.textContent!.trim());
        expect(labels).toEqual(["on time", "3+ min", "10+ min", "Harbour"]);

        document.body.innerHTML = "";
        const trains = await mount(
            { entities: [{ entity: "sensor.mixed", color_by: "delay" }] },
            { "sensor.mixed": feedState("sensor.mixed", [trainFeature()], { legend }) },
        );
        expect(trains.shadowRoot!.querySelector(".legend")!.textContent).not.toContain("Harbour");
    });

    it("explains its kind colours when the map has more than one kind and the feed no legend", async () => {
        const mixed = await mount(
            { entities: ["sensor.mixed"] },
            { "sensor.mixed": feedState("sensor.mixed", [trainFeature(), shipFeature(), shipFeature({ color: "#123456" })]) },
        );
        const labels = [...mixed.shadowRoot!.querySelectorAll(".legend span")].map((entry) => entry.textContent!.trim());
        expect(labels).toEqual(["Long-distance train", "Pilot boat"]);

        document.body.innerHTML = "";
        const ships = await mount({ entities: ["sensor.ships"] }, { "sensor.ships": feedState("sensor.ships", [shipFeature()]) });
        expect(ships.shadowRoot!.querySelector(".legend")).toBeNull();
    });

    it("says which feeds it can't draw", async () => {
        const card = await mount(
            { entities: ["sensor.gone", "sensor.plain"] },
            { "sensor.plain": { entity_id: "sensor.plain", state: "3", attributes: {} } },
        );
        const text = shadowText(card);
        expect(text).toContain("Entity not found: sensor.gone");
        expect(text).toContain("sensor.plain is not a map feed");
    });

    it("draws its map again when it is moved, though its feeds haven't changed", async () => {
        const card = await mount({ entities: ["sensor.trains"] }, { "sensor.trains": feedState("sensor.trains", [trainFeature()]) });
        const before = drawn.updates.length;
        // The dashboard's edit mode moves its cards, which disconnects and connects them again.
        document.body.append(document.createElement("div"));
        document.body.lastElementChild!.append(card);
        await card.updateComplete;
        await new Promise((resolve) => setTimeout(resolve));
        await card.updateComplete;
        expect(drawn.updates.length).toBeGreaterThan(before);
        expect(drawn.fits).toBe(2);
    });
});
