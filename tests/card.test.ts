import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeAssistant } from "../src/hass";
import { aircraftFeature, cameraFeature, feedState, roadworkLine, shipFeature, trainFeature } from "./support/fakes";

// happy-dom has no WebGL, and the tile proxy is Home Assistant's; the card is tested without its map.
const drawn = vi.hoisted(() => ({
    updates: [] as Array<Record<string, unknown>>,
    fits: 0,
    bounds: null as unknown,
    moved: false,
    reveals: [] as Array<[unknown, number]>,
    /** Fits and reveals in the order the card asked for them. */
    order: [] as string[],
}));
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
            drawn.order.push("fit");
            drawn.fits += 1;
            drawn.bounds = bounds;
        }
        reveal(position: unknown, covered: number) {
            drawn.order.push("reveal");
            drawn.reveals.push([position, covered]);
        }
        resize() {}
        tapped() {
            drawn.order.push("tapped");
        }
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

describe("the details", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        drawn.reveals = [];
        drawn.order = [];
    });

    const trains = { "sensor.trains": feedState("sensor.trains", [trainFeature()]) };
    type Card = InstanceType<typeof MapFeedCard>;
    const first = (card: Card) => [...card["view"]!.items.keys()][0]!;
    const parts = (card: Card) => {
        const root = card.shadowRoot!;
        return {
            note: !!root.querySelector(".map-wrap > .map-note"),
            sheet: !!root.querySelector(".map-wrap > .sheet"),
            panel: !!root.querySelector(".body > .panel"),
        };
    };

    // Narrow and without the list, the details go over the map so the card keeps its size; wide, beside it; with the
    // list, in it.
    it.each<[string, Record<string, unknown>, boolean, boolean, ReturnType<typeof parts>]>([
        ["narrow without the list, nothing selected", {}, false, false, { note: true, sheet: false, panel: false }],
        ["narrow without the list, an item selected", {}, false, true, { note: false, sheet: true, panel: false }],
        ["wide without the list, nothing selected", {}, true, false, { note: false, sheet: false, panel: true }],
        ["wide without the list, an item selected", {}, true, true, { note: false, sheet: false, panel: true }],
        ["narrow with the list, nothing selected", { list: true }, false, false, { note: false, sheet: false, panel: false }],
        ["narrow with the list, an item selected", { list: true }, false, true, { note: false, sheet: false, panel: false }],
        ["wide with the list, nothing selected", { list: true }, true, false, { note: false, sheet: false, panel: false }],
        ["wide with the list, an item selected", { list: true }, true, true, { note: false, sheet: false, panel: false }],
    ])("puts the details where they belong for %s", async (_name, extra, wide, selected, expected) => {
        const card = await mount({ entities: ["sensor.trains"], ...extra }, trains);
        card["wide"] = wide;
        if (selected) card["select"](first(card));
        await card.updateComplete;
        expect(parts(card)).toEqual(expected);
    });

    // The note over the map says what to do when there is something to tap, what is wrong with a feed it can't draw,
    // and that there is nothing to show when there is neither.
    it.each<[string, string[], Record<string, ReturnType<typeof feedState>>, string[]]>([
        ["items to tap", ["sensor.trains"], trains, ["Select an item on the map to see more about it."]],
        ["no items", ["sensor.trains"], { "sensor.trains": feedState("sensor.trains", []) }, ["Nothing to show right now."]],
        ["a feed it can't draw", ["sensor.missing"], {}, ["Entity not found: sensor.missing"]],
        [
            "a feed it can't draw beside items to tap",
            ["sensor.trains", "sensor.missing"],
            trains,
            ["Entity not found: sensor.missing", "Select an item on the map to see more about it."],
        ],
    ])("says on the map what there is with %s", async (_name, entities, states, texts) => {
        const card = await mount({ entities }, states);
        const note = card.shadowRoot!.querySelector(".map-note")!;
        expect([...note.children].map((child) => child.textContent!.replace(/\s+/g, " ").trim())).toEqual(texts);
    });

    it("shows the selected item's details in the panel beside a wide map, not the hint", async () => {
        const card = await mount({ entities: ["sensor.trains"] }, trains);
        card["wide"] = true;
        card["select"](first(card));
        await card.updateComplete;
        const panel = card.shadowRoot!.querySelector(".panel")!;
        expect(panel.querySelector(".head")).not.toBeNull();
        expect(panel.textContent).not.toContain("Select an item on the map");
    });

    it("closes the sheet with its button, and asks for a tap again", async () => {
        const card = await mount({ entities: ["sensor.trains"] }, trains);
        card["select"](first(card));
        await card.updateComplete;
        const close = card.shadowRoot!.querySelector<HTMLButtonElement>(".sheet .sheet-close")!;
        expect(close.getAttribute("aria-label")).toBe("Close details");
        close.click();
        await card.updateComplete;
        expect(parts(card)).toEqual({ note: true, sheet: false, panel: false });
        expect(card.shadowRoot!.querySelector(".map-note")!.textContent).toContain("Select an item on the map");
        expect(drawn.updates.at(-1)?.selected).toBeNull();
    });

    it("asks for a tap again when the selected item leaves its feed", async () => {
        const card = await mount({ entities: ["sensor.trains"] }, trains);
        card["select"](first(card));
        await card.updateComplete;
        card.hass = { ...card.hass!, states: { "sensor.trains": feedState("sensor.trains", [{ ...trainFeature(), id: "train:9" }]) } };
        await card.updateComplete;
        expect(parts(card)).toEqual({ note: true, sheet: false, panel: false });
    });

    it("starts another item's details from their top, and shows that item clear of the sheet", async () => {
        const states = { "sensor.trains": feedState("sensor.trains", [trainFeature(), { ...trainFeature(), id: "train:9" }]) };
        const card = await mount({ entities: ["sensor.trains"] }, states);
        const [one, other] = [...card["view"]!.items.keys()];
        card["select"](one!);
        await card.updateComplete;
        const scrollTo = vi.spyOn(card.shadowRoot!.querySelector(".sheet")!, "scrollTo");
        card["select"](other!);
        await card.updateComplete;
        expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
        expect(drawn.reveals).toHaveLength(2);
    });

    it.each<[string, boolean, string]>([
        ["the sheet", false, ".sheet"],
        ["the panel beside a wide map", true, ".panel"],
    ])("scrolls %s to a picture opened at the top of the details", async (_name, wide, part) => {
        const card = await mount({ entities: ["sensor.cameras"] }, { "sensor.cameras": feedState("sensor.cameras", [cameraFeature()]) });
        card["wide"] = wide;
        card["select"](first(card));
        await card.updateComplete;
        const details = card.shadowRoot!.querySelector(part)!;
        const scrollTo = vi.spyOn(details, "scrollTo");
        details.querySelector<HTMLButtonElement>("button.picture")!.click();
        await card.updateComplete;
        expect(details.querySelector(".featured")).not.toBeNull();
        expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    });

    it("opens a picture in a list row where it is, with no sheet or panel to scroll", async () => {
        const card = await mount(
            { entities: ["sensor.cameras"], list: true },
            { "sensor.cameras": feedState("sensor.cameras", [cameraFeature()]) },
        );
        card["select"](first(card));
        await card.updateComplete;
        const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo");
        card.shadowRoot!.querySelector<HTMLButtonElement>(".item.open button.picture")!.click();
        await card.updateComplete;
        expect(card.shadowRoot!.querySelector(".item.open .featured")).not.toBeNull();
        expect(scrollTo).not.toHaveBeenCalledWith({ top: 0 });
    });

    // An item tapped while the map was starting is shown once the map is up, after any framing, which a move would stop.
    it.each<[string, Array<string | Record<string, unknown>>, Record<string, ReturnType<typeof feedState>>, boolean, string[], boolean?]>([
        ["the map is framed to its feeds", ["sensor.trains"], trains, true, ["fit", "reveal"]],
        ["the map is framed to its feeds, with the details in the sheet", ["sensor.trains"], trains, false, ["fit", "reveal"]],
        ["the map is framed to its feeds, with the details beside a wide map", ["sensor.trains"], trains, false, ["fit", "reveal"], true],
        ["nothing frames the map", [{ entity: "sensor.trains", frame: false }], trains, true, ["reveal"]],
        ["nothing frames the map, with the details in the sheet", [{ entity: "sensor.trains", frame: false }], trains, false, ["reveal"]],
        [
            "the feeds that frame the map are still empty",
            ["sensor.empty", { entity: "sensor.trains", frame: false }],
            { ...trains, "sensor.empty": feedState("sensor.empty", []) },
            true,
            ["reveal"],
        ],
        [
            "the feeds that frame the map are still empty, with the details in the sheet",
            ["sensor.empty", { entity: "sensor.trains", frame: false }],
            { ...trains, "sensor.empty": feedState("sensor.empty", []) },
            false,
            ["reveal"],
        ],
    ])("shows an item tapped while the map was still starting when %s", async (_name, entities, states, list, order, wide = false) => {
        vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
        const card = document.createElement("map-feed-card") as Card;
        card.setConfig({ type: "custom:map-feed-card", entities, list });
        card.hass = hass(states);
        document.body.append(card);
        card["wide"] = wide;
        await card.updateComplete;
        card["select"](first(card));
        await new Promise((resolve) => setTimeout(resolve));
        await card.updateComplete;
        expect(drawn.order).toEqual(order);
        // In the sheet, the item is shown clear of it; in the list or the panel, anywhere on the map.
        expect(drawn.reveals.map(([, covered]) => covered)).toEqual([list || wide ? 0 : 140]);
    });

    it("shows the selected item again after framing the map to the feeds a new configuration gives", async () => {
        const card = await mount({ entities: ["sensor.trains"], list: true }, trains);
        card["select"](first(card));
        await card.updateComplete;
        drawn.order = [];
        card.setConfig({ type: "custom:map-feed-card", entities: ["sensor.trains", "sensor.ships"], list: true });
        card.hass = hass({ ...trains, "sensor.ships": feedState("sensor.ships", [shipFeature()]) });
        await card.updateComplete;
        expect(drawn.order).toEqual(["fit", "reveal"]);
    });

    it("shows nothing when the item tapped left its feed before the map was up", async () => {
        const card = document.createElement("map-feed-card") as Card;
        card.setConfig({ type: "custom:map-feed-card", entities: ["sensor.trains"], list: true });
        card.hass = hass(trains);
        document.body.append(card);
        await card.updateComplete;
        card["select"](first(card));
        card.hass = hass({ "sensor.trains": feedState("sensor.trains", [{ ...trainFeature(), id: "train:9" }]) });
        await new Promise((resolve) => setTimeout(resolve));
        await card.updateComplete;
        expect(drawn.order).toEqual(["fit"]);
    });

    it("shows the selected item again when the feeds that frame the map fill later, and the framing moves the map", async () => {
        const states = { ...trains, "sensor.empty": feedState("sensor.empty", []) };
        const card = await mount({ entities: ["sensor.empty", { entity: "sensor.trains", frame: false }], list: true }, states);
        card["select"](first(card));
        await card.updateComplete;
        expect(drawn.order).toEqual(["tapped", "reveal"]);
        card.hass = hass({ ...trains, "sensor.empty": feedState("sensor.empty", [shipFeature()]) });
        await card.updateComplete;
        expect(drawn.order).toEqual(["tapped", "reveal", "fit", "reveal"]);
    });

    describe("as the card and the sheet change size", () => {
        let observed: Map<Element, (entries: unknown[]) => void>;
        let sheetHeight = 120;
        beforeEach(() => {
            observed = new Map();
            sheetHeight = 120;
            vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => sheetHeight);
            // A resize observer reports a target's size once it is laid out after being observed, and again on every change.
            vi.stubGlobal(
                "ResizeObserver",
                class {
                    constructor(private readonly callback: (entries: unknown[]) => void) {}
                    observe(target: Element) {
                        observed.set(target, this.callback);
                        setTimeout(() => this.callback([{ target, contentRect: { width: 480 } }]));
                    }
                    unobserve(target: Element) {
                        observed.delete(target);
                    }
                    disconnect() {
                        observed.clear();
                    }
                },
            );
        });
        const resize = async (card: Card, target: Element, width = 480) => {
            observed.get(target)!([{ target, contentRect: { width } }]);
            await card.updateComplete;
        };
        const selected = async () => {
            const card = await mount({ entities: ["sensor.trains"] }, trains);
            card["select"](first(card));
            await card.updateComplete;
            await new Promise((resolve) => setTimeout(resolve));
            await card.updateComplete;
            return card;
        };
        const sheet = (card: Card) => card.shadowRoot!.querySelector(".sheet")!;
        // The card asks the map to show the selected item whenever something may have hidden it, measuring the sheet as
        // it is then. The map itself leaves the item alone once someone has moved the map (map.test.ts).
        const covered = () => drawn.reveals.map(([, height]) => height);

        it("shows the item clear of the sheet when tapped, measuring the sheet as drawn", async () => {
            await selected();
            expect(covered().length).toBeGreaterThan(0);
            expect(new Set(covered())).toEqual(new Set([120]));
        });

        it("shows the item clear of the sheet again whenever the sheet changes size, as its pictures load, however late", async () => {
            const card = await selected();
            card["selectedAt"] = Date.now() - 60_000;
            sheetHeight = 200;
            await resize(card, sheet(card));
            expect(covered().at(-1)).toBe(200);
        });

        it("shows the item again when the card changes size, which can frame the map anew", async () => {
            const card = await selected();
            const before = drawn.reveals.length;
            await resize(card, card, 460);
            expect(drawn.reveals.length).toBe(before + 1);
        });

        it("shows the item clear of the sheet when the card narrows and the details move from beside the map into it", async () => {
            const card = await selected();
            await resize(card, card, 700);
            await card.updateComplete;
            expect([card.shadowRoot!.querySelector(".panel") !== null, covered().at(-1)]).toEqual([true, 0]);
            await resize(card, card, 480);
            await card.updateComplete;
            expect([card.shadowRoot!.querySelector(".sheet") !== null, covered().at(-1)]).toEqual([true, 120]);
        });

        it("moves nothing when the card changes size with nothing selected", async () => {
            const card = await mount({ entities: ["sensor.trains"] }, trains);
            await resize(card, card, 460);
            expect(drawn.reveals).toHaveLength(0);
        });

        it("tells the map of a tap before showing the item", async () => {
            const card = await mount({ entities: ["sensor.trains"] }, trains);
            drawn.order = [];
            card["select"](first(card));
            await card.updateComplete;
            expect(drawn.order.slice(0, 2)).toEqual(["tapped", "reveal"]);
        });

        it("shows the selected item again when it is tapped again", async () => {
            const card = await mount({ entities: ["sensor.trains"] }, trains);
            card["select"](first(card));
            await card.updateComplete;
            drawn.order = [];
            card["select"](first(card));
            await card.updateComplete;
            expect(drawn.order).toEqual(["tapped", "reveal"]);
            expect(card["selected"]).toBe(first(card));
        });

        it("brings the selected item's row back into view when it is tapped again on the map", async () => {
            const card = await mount({ entities: ["sensor.trains"], list: true }, trains);
            card["select"](first(card));
            await card.updateComplete;
            // The first tap's details finish loading, and fit their row, before the second tap.
            await new Promise((resolve) => setTimeout(resolve));
            await card.updateComplete;
            const fitRow = vi.spyOn(card as unknown as { fitRow(): void }, "fitRow");
            card["select"](first(card));
            await card.updateComplete;
            expect(fitRow).toHaveBeenCalledTimes(1);
        });

        it.each<[string, [number, number], number]>([
            ["follows it as it moves, clear of the sheet", [27.4, 60.95], 1],
            ["leaves the map alone when it hasn't moved", [27.30011, 60.90204], 0],
        ])("when the selected item's feed updates the map %s", async (_name, coordinates, reveals) => {
            const card = await mount({ entities: ["sensor.trains"] }, trains);
            card["select"](first(card));
            await card.updateComplete;
            drawn.reveals = [];
            const moved = { ...trainFeature({ speed_kmh: 90 }), geometry: { type: "Point", coordinates } };
            card.hass = hass({ "sensor.trains": feedState("sensor.trains", [moved]) });
            await card.updateComplete;
            expect(drawn.reveals).toEqual(reveals ? [[coordinates, 120]] : []);
        });

        it("never follows an item with no point to follow, such as a road work's line", async () => {
            const roads = (overrides: Record<string, unknown>) => ({
                "sensor.roads": feedState("sensor.roads", [roadworkLine(overrides)]),
            });
            const card = await mount({ entities: ["sensor.roads"] }, roads({}));
            card["select"](first(card));
            await card.updateComplete;
            drawn.reveals = [];
            card.hass = hass(roads({ name: "Moved" }));
            await card.updateComplete;
            expect(drawn.reveals).toEqual([]);
        });

        // Coming back, the card's first report of its size shows the item; with nothing to frame and no sheet, nothing else does.
        it.each<[string, Array<string | Record<string, unknown>>, boolean, string[]]>([
            ["a map framed to its feeds", ["sensor.trains"], false, ["fit", "reveal"]],
            ["a map with nothing to frame", [{ entity: "sensor.trains", frame: false }], false, ["reveal"]],
            ["a map with nothing to frame and the details in the list", [{ entity: "sensor.trains", frame: false }], true, ["reveal"]],
            ["a map whose framing feeds are still empty", ["sensor.empty", { entity: "sensor.trains", frame: false }], false, ["reveal"]],
        ])("shows the item again when the card comes back to the page with %s", async (_name, entities, list, first2) => {
            const card = await mount({ entities, list }, { ...trains, "sensor.empty": feedState("sensor.empty", []) });
            card["select"](first(card));
            await card.updateComplete;
            card.remove();
            drawn.order = [];
            document.body.append(card);
            await card.updateComplete;
            await new Promise((resolve) => setTimeout(resolve));
            await card.updateComplete;
            expect(drawn.order.slice(0, first2.length)).toEqual(first2);
            expect(drawn.order.slice(first2.length).every((call) => call === "reveal")).toBe(true);
        });
    });

    it("shows the selected item clear of the sheet, measured once the sheet is drawn", async () => {
        vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
        const card = await mount({ entities: ["sensor.trains"] }, trains);
        card["select"](first(card));
        await card.updateComplete;
        expect(drawn.reveals.map(([, covered]) => covered)).toEqual([140]);
    });

    it("shows the selected item anywhere on the map when the details aren't over it", async () => {
        const card = await mount({ entities: ["sensor.trains"], list: true }, trains);
        card["select"](first(card));
        await card.updateComplete;
        expect(drawn.reveals.map(([, covered]) => covered)).toEqual([0]);
    });
});

describe("the height", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const trains = { "sensor.trains": feedState("sensor.trains", [trainFeature()]) };
    const style = (card: HTMLElement) => card.shadowRoot!.querySelector("ha-card")!.getAttribute("style")!.split(";").at(-1)!.trim();

    // Held, the card keeps its title and room for the details' sheet over a map of 200 px; with the list, the map at its
    // own height and the list's header and two rows (162 px).
    it.each<[string, Record<string, unknown>, string | undefined, string, number]>([
        ["by its content", {}, undefined, "", 4],
        ["to a height", { title: "Trains", height: 400 }, undefined, "height: 400px", 4],
        ["to a height below its minimum", { title: "Trains", height: 120 }, undefined, "height: 248px", 4],
        ["to a height below its minimum, with no title", { height: 120 }, undefined, "height: 200px", 4],
        ["up to a limit", { title: "Trains", max_height: 600 }, undefined, "max-height: 600px", 4],
        [
            "with the list, to a height below the map and two rows",
            { title: "Trains", list: true, map_height: 340, height: 300 },
            undefined,
            "height: 550px",
            9,
        ],
        [
            "with the list up to a limit",
            { title: "Trains", list: true, map_height: 340, max_height: 700 },
            undefined,
            "max-height: 700px",
            9,
        ],
        [
            "with the list, no title and the map's own height, to a height below them",
            { list: true, height: 100 },
            undefined,
            "height: 462px",
            8,
        ],
        ["up to a limit below its minimum", { title: "Trains", max_height: 120 }, undefined, "max-height: 248px", 4],
        ["by nothing in the auto mode over a height", { height_mode: "auto", height: 400 }, undefined, "", 4],
        ["by nothing in the fixed mode with no height", { height_mode: "fixed" }, undefined, "", 4],
        ["by rows in a sections view", { height: 400, grid_options: { rows: 6 } }, "grid", "height: 100%", 4],
        ["by the older layout options' rows in a sections view", { layout_options: { grid_rows: 6 } }, "grid", "height: 100%", 4],
        ["with the list, by rows in a sections view", { list: true, grid_options: { rows: 9 } }, "grid", "height: 100%", 8],
        [
            "by grid rows outside a sections view, which leave the mode",
            { height: 400, grid_options: { rows: 6 } },
            undefined,
            "height: 400px",
            4,
        ],
    ])("is held %s", async (_name, extra, layout, expected, minRows) => {
        const card = await mount({ entities: ["sensor.trains"], ...extra }, trains);
        card.layout = layout;
        await card.updateComplete;
        expect(style(card)).toBe(expected);
        expect(card.shadowRoot!.querySelector("ha-card")!.classList.contains("held")).toBe(expected !== "");
        expect(card.getGridOptions().min_rows).toBe(minRows);
    });

    // A card is 64k − 8 px tall on k rows. The map's part (the body beside the list when wide) has grown by the given
    // pixels past map_height, which the measure leaves out.
    it.each<[string, Record<string, unknown>, string | undefined, boolean, number, number, string]>([
        ["a title and the map, to the next row", { title: "Trains" }, "grid", false, 350, 0, "min-height: 376px"],
        ["once filled, on the same row", { title: "Trains" }, "grid", false, 376, 26, "min-height: 376px"],
        ["once filled, a row less when the map gives it back", { title: "Trains" }, "grid", false, 440, 90, "min-height: 376px"],
        ["narrow turned wide, the rows of the list below given back", { list: true }, "grid", true, 700, 388, "min-height: 312px"],
        ["the list beside the map, 2 px short", { list: true, map_height: 500 }, "grid", true, 502, 0, "min-height: 504px"],
        ["the list beside the map, once filled", { list: true, map_height: 500 }, "grid", true, 504, 2, "min-height: 504px"],
        ["already on a row", { map_height: 438 }, "grid", false, 440, 0, "min-height: 440px"],
        ["the list below, shrunk past a row", { list: true, map_height: 340 }, "grid", false, 504, 104, "min-height: 440px"],
        ["not outside a sections view", { title: "Trains" }, undefined, false, 350, 0, ""],
        ["not when held to a height", { title: "Trains", height: 400 }, "grid", false, 400, 52, "height: 400px"],
        ["not when held by rows", { grid_options: { rows: 6 } }, "grid", false, 376, 76, "height: 100%"],
    ])("ends on a whole row with %s", async (_name, extra, layout, wide, height, grown, expected) => {
        const card = await mount({ entities: ["sensor.trains"], ...extra }, trains);
        const internals = card as unknown as { wide: boolean; fillRows(): void };
        card.layout = layout;
        internals.wide = wide;
        await card.updateComplete;
        const root = card.shadowRoot!;
        const haCard = root.querySelector<HTMLElement>("ha-card")!;
        const part = root.querySelector<HTMLElement>(wide ? ".body" : ".map-wrap")!;
        const mapHeight = Number(extra.map_height ?? 300);
        Object.defineProperty(haCard, "clientWidth", { value: wide ? 1000 : 500, configurable: true });
        haCard.getBoundingClientRect = () => ({ height }) as DOMRect;
        part.getBoundingClientRect = () => ({ height: mapHeight + grown }) as DOMRect;
        internals.fillRows();
        await card.updateComplete;
        expect(style(card)).toBe(expected);
        expect(haCard.classList.contains("filled")).toBe(expected.startsWith("min-height"));
    });

    it.each<[string, (card: HTMLElement, haCard: HTMLElement) => void]>([
        ["leaving a sections view", (card) => ((card as unknown as { layout?: string }).layout = undefined)],
        ["hidden", (_card, haCard) => Object.defineProperty(haCard, "clientWidth", { value: 0, configurable: true })],
    ])("lets go of its rows when %s", async (_name, change) => {
        const card = await mount({ entities: ["sensor.trains"], title: "Trains" }, trains);
        const internals = card as unknown as { fillRows(): void };
        card.layout = "grid";
        await card.updateComplete;
        const haCard = card.shadowRoot!.querySelector<HTMLElement>("ha-card")!;
        Object.defineProperty(haCard, "clientWidth", { value: 500, configurable: true });
        haCard.getBoundingClientRect = () => ({ height: 350 }) as DOMRect;
        internals.fillRows();
        await card.updateComplete;
        expect(style(card)).toBe("min-height: 376px");
        change(card, haCard);
        await card.updateComplete;
        internals.fillRows();
        await card.updateComplete;
        expect(style(card)).toBe("");
        expect(haCard.classList.contains("filled")).toBe(false);
    });

    it("leaves a hidden card's rows alone", async () => {
        const card = await mount({ entities: ["sensor.trains"], title: "Trains" }, trains);
        card.layout = "grid";
        await card.updateComplete;
        (card as unknown as { fillRows(): void }).fillRows();
        await card.updateComplete;
        expect(style(card)).toBe("");
    });

    it("refuses a height that isn't a positive number of pixels", () => {
        const card = document.createElement("map-feed-card") as InstanceType<typeof MapFeedCard>;
        expect(() => card.setConfig({ entities: ["sensor.trains"], height: -5 })).toThrow(/height/);
        expect(() => card.setConfig({ entities: ["sensor.trains"], height_mode: "tall" })).toThrow(/height_mode/);
    });

    const scrolled = (part: Element) => {
        Object.defineProperty(part, "scrollHeight", { value: 500, configurable: true });
        Object.defineProperty(part, "clientHeight", { value: 200, configurable: true });
    };
    const fades = (part: Element) => ["fades", "fade-top", "fade-bottom"].filter((name) => part.classList.contains(name));

    it.each<[string, Record<string, unknown>, string | undefined, string[]]>([
        ["held to a height", { height: 600 }, undefined, ["fades", "fade-bottom"]],
        ["held up to a limit", { max_height: 600 }, undefined, ["fades", "fade-bottom"]],
        ["held by rows in a sections view", { grid_options: { rows: 10 } }, "grid", ["fades", "fade-bottom"]],
        [
            "held to a height with automatic rows in a sections view",
            { height: 600, grid_options: { rows: "auto" } },
            "grid",
            ["fades", "fade-bottom"],
        ],
        ["held by the older layout options' rows", { layout_options: { grid_rows: 10 } }, "grid", ["fades", "fade-bottom"]],
        ["never in auto", {}, undefined, []],
        ["never in auto with automatic rows in a sections view", { grid_options: { rows: "auto" } }, "grid", []],
        ["never by grid rows outside a sections view", { grid_options: { rows: 10 } }, undefined, []],
        ["never in the auto mode over a height", { height_mode: "auto", height: 600 }, undefined, []],
        ["never with automatic rows and no mode", { grid_options: { rows: "auto" } }, undefined, []],
    ])("fades the list's bottom edge %s", async (_name, extra, layout, expected) => {
        const card = await mount({ entities: ["sensor.trains"], list: true, ...extra }, trains);
        card.layout = layout;
        await card.updateComplete;
        scrolled(card.shadowRoot!.querySelector(".list .rows")!);
        card.requestUpdate();
        await card.updateComplete;
        expect(fades(card.shadowRoot!.querySelector(".list .rows")!)).toEqual(expected);
    });

    it.each<[string, Record<string, unknown>, string | undefined, string]>([
        ["sized by its content", {}, undefined, ""],
        ["held to a height", { height: 600 }, undefined, "height: 600px"],
        ["held up to a limit", { max_height: 600 }, undefined, "max-height: 600px"],
        ["held by rows in a sections view", { grid_options: { rows: 8 } }, "grid", "height: 100%"],
        [
            "held to a height with automatic rows in a sections view",
            { height: 600, grid_options: { rows: "auto" } },
            "grid",
            "height: 600px",
        ],
    ])("never fades the details' sheet when it is %s", async (_name, extra, layout, held) => {
        const card = await mount({ entities: ["sensor.trains"], ...extra }, trains);
        card.layout = layout;
        await card.updateComplete;
        expect(style(card)).toBe(held);
        card["select"]([...card["view"]!.items.keys()][0]!);
        await card.updateComplete;
        scrolled(card.shadowRoot!.querySelector(".sheet")!);
        card.requestUpdate();
        await card.updateComplete;
        expect(fades(card.shadowRoot!.querySelector(".sheet")!)).toEqual([]);
    });

    it("lets go of its height and the list's fade when set back to its content, and holds them again", async () => {
        const card = await mount({ entities: ["sensor.trains"], list: true, height: 600 }, trains);
        const rows = () => card.shadowRoot!.querySelector(".list .rows")!;
        scrolled(rows());
        card.requestUpdate();
        await card.updateComplete;
        expect([style(card), fades(rows())]).toEqual(["height: 600px", ["fades", "fade-bottom"]]);
        card.setConfig({ type: "custom:map-feed-card", entities: ["sensor.trains"], list: true });
        await card.updateComplete;
        expect([style(card), fades(rows())]).toEqual(["", []]);
        card.setConfig({ type: "custom:map-feed-card", entities: ["sensor.trains"], list: true, height: 600 });
        await card.updateComplete;
        expect([style(card), fades(rows())]).toEqual(["height: 600px", ["fades", "fade-bottom"]]);
    });

    // A masonry view's size in units of 50 px: the title, the map and the list by their heights, or the height held to.
    it.each<[string, Record<string, unknown>, number]>([
        ["by its content", {}, 9],
        ["by its content with the list", { list: true }, 18],
        ["held to a height", { height: 400 }, 8],
        ["up to a limit above its content", { max_height: 900 }, 9],
        ["up to a limit below its content", { max_height: 300 }, 6],
        ["with the list, held to a height below its minimum", { list: true, height: 300 }, 9],
    ])("tells a masonry view its size %s", async (_name, extra, size) => {
        const card = await mount({ entities: ["sensor.trains"], ...extra }, trains);
        expect(card.getCardSize()).toBe(size);
    });
});
