import { afterEach, describe, expect, it, vi } from "vitest";

import type { HomeAssistant } from "../src/hass";
import { aircraftFeature, feedState, roadworkLine, shipFeature, trainFeature } from "./support/fakes";

// happy-dom has no WebGL, and the tile proxy is Home Assistant's; the card is tested without its map.
const drawn = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>>, fits: 0, bounds: null as unknown, moved: false }));
vi.mock("../src/map", () => ({
    FeedMap: class {
        async init() {}
        async setStyle() {}
        update(content: Record<string, unknown>) {
            drawn.updates.push(content);
        }
        get moved() {
            return drawn.moved;
        }
        fit(bounds: unknown) {
            drawn.fits += 1;
            drawn.bounds = bounds;
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
    drawn.bounds = null;
    drawn.moved = false;
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

    it("offers a choice of order only when the feeds offer more than one", async () => {
        const key = (name: string) => ({ key: name, label: name, property: name });
        const one = await mount(
            { list: true, entities: ["sensor.buses"] },
            { "sensor.buses": feedState("sensor.buses", [trainFeature()], { list: { sort: [key("line")] } }) },
        );
        expect(one.shadowRoot!.querySelector(".sort")).toBeNull();

        document.body.innerHTML = "";
        const two = await mount(
            { list: true, entities: ["sensor.trains"] },
            { "sensor.trains": feedState("sensor.trains", [trainFeature()], { list: { sort: [key("delay"), key("number")] } }) },
        );
        expect(two.shadowRoot!.querySelectorAll(".sort option")).toHaveLength(2);
    });

    it("hands the map a feed's attribution as text, never as markup", async () => {
        await mount(
            { entities: ["sensor.trains"] },
            { "sensor.trains": feedState("sensor.trains", [trainFeature()], { attribution: '<img src="http://tracker.example/p.gif">' }) },
        );
        const [attribution] = drawn.updates.at(-1)!.attributions as string[];
        expect(attribution).not.toContain("<");
        expect(attribution).toMatch(/^&#60;img/);
    });

    it("links a feed's attribution to its page, with both escaped", async () => {
        await mount(
            { entities: ["sensor.aircraft"] },
            {
                "sensor.aircraft": feedState("sensor.aircraft", [aircraftFeature()], {
                    attribution: "adsb.fi <b>",
                    attribution_url: 'https://adsb.fi/?a="x"',
                }),
            },
        );
        const [attribution] = drawn.updates.at(-1)!.attributions as string[];
        expect(attribution).toBe(
            '<a href="https://adsb.fi/?a=&#34;x&#34;" target="_blank" rel="noopener noreferrer">adsb.fi &#60;b&#62;</a>',
        );
    });

    it("opens a linked picture's page instead of showing it large", async () => {
        const card = await mount(
            { entities: ["sensor.aircraft"] },
            { "sensor.aircraft": feedState("sensor.aircraft", [aircraftFeature()]) },
        );
        (card as unknown as { select(key: string): void }).select("sensor.aircraft|aircraft:4ca8e1");
        await card.updateComplete;
        const link = card.shadowRoot!.querySelector<HTMLAnchorElement>("a.picture")!;
        expect(link.getAttribute("href")).toBe("https://example.org/photos/a320");
        expect(link.target).toBe("_blank");
        expect(link.querySelector("img")!.getAttribute("src")).toBe("https://example.org/photos/a320.jpg");
        expect(card.shadowRoot!.querySelector("button.picture")).toBeNull();
    });

    it.each<[string, boolean, Record<string, unknown>, string | undefined, boolean, number | null]>([
        [
            "glides a moving item, from the time its position was measured",
            true,
            { updated: "2026-09-14T21:09:41Z" },
            "2026-09-14T21:10:03Z",
            true,
            Date.parse("2026-09-14T21:09:41Z"),
        ],
        [
            "takes the time its feed last changed when the item has none",
            true,
            { updated: undefined },
            "2026-09-14T21:10:03Z",
            true,
            Date.parse("2026-09-14T21:10:03Z"),
        ],
        ["knows no time when neither has one", true, { updated: undefined }, undefined, true, null],
        ["doesn't glide a stationary item", true, { stationary: true }, "2026-09-14T21:10:03Z", false, Date.parse("2026-09-14T21:10:05Z")],
        ["doesn't glide when its feed doesn't", false, {}, "2026-09-14T21:10:03Z", false, Date.parse("2026-09-14T21:10:05Z")],
    ])("%s", async (_, glide, properties, lastUpdated, glides, reportedMs) => {
        const state = {
            ...feedState("sensor.ships", [shipFeature({ updated: "2026-09-14T21:10:05Z", ...properties })]),
            last_updated: lastUpdated,
        };
        await mount({ entities: [{ entity: "sensor.ships", glide }] }, { "sensor.ships": state });
        const [point] = drawn.updates.at(-1)!.points as Array<{ glide: boolean; reportedMs: number | null }>;
        expect(point.glide).toBe(glides);
        expect(point.reportedMs).toBe(reportedMs);
    });

    it("times each feed's items by when their own feed last changed", async () => {
        const state = (entity: string, lastUpdated: string) => ({
            ...feedState(entity, [shipFeature({ updated: undefined })]),
            last_updated: lastUpdated,
        });
        await mount(
            {
                entities: [
                    { entity: "sensor.ships", glide: true },
                    { entity: "sensor.boats", glide: true },
                ],
            },
            {
                "sensor.ships": state("sensor.ships", "2026-09-14T21:10:03Z"),
                "sensor.boats": state("sensor.boats", "2026-09-14T21:10:09Z"),
            },
        );
        const points = drawn.updates.at(-1)!.points as Array<{ key: string; reportedMs: number | null }>;
        expect(points.map(({ key, reportedMs }) => [key.split("|")[0], reportedMs])).toEqual([
            ["sensor.ships", Date.parse("2026-09-14T21:10:03Z")],
            ["sensor.boats", Date.parse("2026-09-14T21:10:09Z")],
        ]);
    });

    it("counts one item in the singular", async () => {
        const card = await mount(
            { list: true, entities: ["sensor.aircraft"] },
            {
                "sensor.aircraft": feedState("sensor.aircraft", [aircraftFeature()], {
                    list: { count: "ilma-alusta", count_one: "ilma-alus" },
                }),
            },
        );
        expect(card.shadowRoot!.querySelector(".count")!.textContent).toBe("1 ilma-alus");
    });

    it("frames a feed of lines by its lines, and offers only those that have something to show", async () => {
        const route = roadworkLine({ point: undefined, kind: "road.maintenance_track" });
        const named = { ...roadworkLine({ point: undefined, name: "Road 6" }), id: "road:6" };
        const card = await mount(
            { list: true, entities: ["sensor.routes"] },
            { "sensor.routes": feedState("sensor.routes", [route, named]) },
        );
        expect(drawn.fits).toBe(1);
        expect(drawn.updates.at(-1)!.shapes).toHaveLength(2);
        expect([...card.shadowRoot!.querySelectorAll(".row-title")].map((title) => title.textContent)).toEqual(["Road 6"]);
    });

    it("explains a cancelled train's grey in the delay legend", async () => {
        const card = await mount(
            { entities: [{ entity: "sensor.trains", color_by: "delay" }] },
            { "sensor.trains": feedState("sensor.trains", [trainFeature({ cancelled: true })]) },
        );
        const labels = [...card.shadowRoot!.querySelectorAll(".legend span")].map((entry) => entry.textContent!.trim());
        expect(labels).toContain("cancelled");
        expect(labels).not.toContain("no delay information");
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

    describe("a feed left out of the framing", () => {
        const area = (id: string, list: Record<string, unknown> = {}) => ({
            type: "Feature",
            id,
            geometry: {
                type: "MultiPolygon",
                coordinates: [
                    [
                        [
                            [20, 60],
                            [30, 60],
                            [30, 70],
                            [20, 70],
                            [20, 60],
                        ],
                    ],
                ],
            },
            properties: { name: "Korpivaara", kind: "air.area", details: [{ label: "Heights", value: "SFC – FL 95" }], list },
        });

        it("frames the map to the other feeds only", async () => {
            await mount(
                { entities: ["sensor.ships", { entity: "sensor.airspace", frame: false }] },
                {
                    "sensor.ships": feedState("sensor.ships", [shipFeature()]),
                    "sensor.airspace": feedState("sensor.airspace", [area("area:EFD910")]),
                },
            );
            expect(drawn.fits).toBe(1);
            expect(drawn.bounds).toEqual([
                [27.17012, 60.53044],
                [27.17012, 60.53044],
            ]);
            // Still drawn.
            expect(drawn.updates.at(-1)!.shapes).toHaveLength(1);
        });

        it("drops a fit still waiting for something to frame once the map has been moved", async () => {
            const states = (ships: unknown[]) => ({
                "sensor.ships": feedState("sensor.ships", ships),
                "sensor.airspace": feedState("sensor.airspace", [area("area:EFD910")]),
            });
            const entities = ["sensor.ships", { entity: "sensor.airspace", frame: false }];
            const waiting = await mount({ entities }, states([]));
            expect(drawn.fits).toBe(0);
            // Not moved: the first ship frames the map.
            waiting.hass = hass(states([shipFeature()]));
            await waiting.updateComplete;
            expect(drawn.fits).toBe(1);

            waiting.remove();
            drawn.fits = 0;
            const moved = await mount({ entities }, states([]));
            drawn.moved = true;
            moved.hass = hass(states([shipFeature()]));
            await moved.updateComplete;
            expect(drawn.fits).toBe(0);
        });

        it("leaves the map where it opens when every feed is left out", async () => {
            await mount(
                { entities: [{ entity: "sensor.airspace", frame: false }] },
                { "sensor.airspace": feedState("sensor.airspace", [area("area:EFD910")]) },
            );
            expect(drawn.fits).toBe(0);
        });
    });

    describe("a list row's tag", () => {
        const area = (id: string, list: Record<string, unknown> = {}) => ({
            type: "Feature",
            id,
            geometry: {
                type: "MultiPolygon",
                coordinates: [
                    [
                        [
                            [20, 60],
                            [30, 60],
                            [30, 70],
                            [20, 70],
                            [20, 60],
                        ],
                    ],
                ],
            },
            properties: { name: "Korpivaara", kind: "air.area", details: [{ label: "Heights", value: "SFC – FL 95" }], list },
        });

        it("shows a list row's tag after its title", async () => {
            const card = await mount(
                { entities: ["sensor.airspace"], list: true },
                {
                    "sensor.airspace": feedState("sensor.airspace", [
                        area("area:EFR1880", { title: "Restricted area EFR1880", tag: { text: "NEW", tone: "warning" } }),
                        {
                            ...area("area:EFD910", { title: "Korpivaara", tag: { text: "TODAY", tone: "item" } }),
                            properties: {
                                ...area("x").properties,
                                color: "#8f9aab",
                                list: { title: "Korpivaara", tag: { text: "TODAY", tone: "item" } },
                            },
                        },
                    ]),
                },
            );
            const title = card.shadowRoot!.querySelector(".row .row-title")!;
            expect(title.textContent!.replace(/\s+/g, " ").trim()).toBe("Restricted area EFR1880 NEW");
            expect(title.querySelector(".tag.warning")!.textContent).toBe("NEW");
            // The item tone takes the item's own colour.
            const own = card.shadowRoot!.querySelector<HTMLElement>(".row .tag.item")!;
            expect(own.textContent).toBe("TODAY");
            expect(own.getAttribute("style")).toContain("background:#8f9aab");
        });
    });
});

describe("redrawing for a new hass", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    // Home Assistant hands the card every change in the house. Its own sensors, the language and the locale (the time
    // format and time zone with it) are what change what the card shows.
    it.each<[string, (state: HomeAssistant) => HomeAssistant, number]>([
        [
            "another entity's change",
            (state) => ({
                ...state,
                states: {
                    ...state.states,
                    "sensor.elsewhere": { entity_id: "sensor.elsewhere", state: "2", last_changed: "", attributes: {} },
                },
            }),
            0,
        ],
        ["a new language", (state) => ({ ...state, locale: { ...state.locale!, language: "en" }, language: "en" }), 1],
        ["a new locale alone", (state) => ({ ...state, locale: { ...state.locale! } }), 1],
        ["a new language in the older field alone", (state) => ({ ...state, language: "sv" }), 1],
    ])("redraws as it should for %s", async (_name, change, renders) => {
        const element = await mount({ entities: ["sensor.trains"] }, { "sensor.trains": feedState("sensor.trains", [trainFeature()]) });
        const render = vi.spyOn(element as unknown as { render(): unknown }, "render");
        element.hass = change(element.hass!);
        await element.updateComplete;
        expect(render).toHaveBeenCalledTimes(renders);
    });
});
