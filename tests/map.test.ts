import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedPoint, FeedShape, LngLat } from "../src/feed";
import type { DrawnShape, MapContent } from "../src/map";

// What the map was last given to draw, by source.
const sources = vi.hoisted(() => ({}) as Record<string, { data?: unknown; setData(data: unknown): void }>);
// The map's event handlers, so a test can move it as a hand would.
const handlers = vi.hoisted(() => ({}) as Record<string, (event: unknown) => void>);
// Where the map was moved to, and with what offset.
const eased = vi.hoisted(() => [] as Array<{ center: unknown; offset?: [number, number] }>);

// MapLibre needs WebGL, which happy-dom lacks. The fakes do only what matters here: a marker added to the map gets
// MapLibre's own class, which places it on the map, and a marker and a source remember what they were given.
vi.mock("maplibre-gl", () => {
    const noop = () => undefined;
    class FakeMap {
        touchZoomRotate = { disableRotation: noop };
        keyboard = { disableRotation: noop };
        on = (name: string, handler: (event: unknown) => void) => {
            handlers[name] = handler;
        };
        once = noop;
        addControl = noop;
        removeControl = noop;
        addSource = noop;
        addLayer = noop;
        isStyleLoaded = () => true;
        remove = noop;
        getSource = (id: string) =>
            (sources[id] ??= {
                setData(data: unknown) {
                    this.data = data;
                },
            });
        // A pixel to every 0.00001 degrees, about a metre.
        project = ([lon, lat]: LngLat) => ({ x: lon * 100_000, y: lat * 100_000 });
        getContainer = () => ({ clientWidth: 400, clientHeight: 300 });
        resize = () => undefined;
        fitBounds = () => undefined;
        easeTo = (options: { center: unknown; offset?: [number, number] }) => eased.push(options);
    }
    class Marker {
        private readonly element: HTMLElement;
        constructor({ element }: { element: HTMLElement }) {
            this.element = element;
        }
        setLngLat(position: LngLat) {
            this.element.dataset.position = position.map((value) => value.toFixed(5)).join(",");
            return this;
        }
        setOpacity(opacity: number) {
            this.element.dataset.opacity = String(opacity);
            return this;
        }
        addTo() {
            this.element.classList.add("maplibregl-marker");
            return this;
        }
        remove() {}
    }
    return { Map: FakeMap, Marker, Popup: class {}, AttributionControl: class {}, NavigationControl: class {}, setWorkerUrl: noop };
});
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?raw", () => ({ default: "" }));
vi.mock("../src/map-tiles", () => ({
    loadStyle: async () => ({ version: 8, sources: {}, layers: [] }),
    onTokenChange: () => () => undefined,
    refreshToken: async () => {},
    transformRequest: (url: string) => ({ url }),
}));

const { FeedMap } = await import("../src/map");

function ship(overrides: Partial<FeedPoint> = {}): FeedPoint {
    return {
        id: "ship:230000001",
        name: "Example",
        kind: "ship.cargo",
        updatedMs: null,
        subtitle: "",
        color: null,
        details: [],
        notices: [],
        footer: "",
        images: [],
        link: null,
        opacity: 1,
        lon: 25.5,
        lat: 60.2,
        heading: 90,
        stationary: false,
        speedKmh: 20,
        delayMinutes: null,
        cancelled: false,
        badge: "",
        label: "",
        detailAction: null,
        listRow: { title: null, text: null, value: null, tag: null },
        sortValues: {},
        ...overrides,
    };
}

describe("map markers", () => {
    it("keeps MapLibre's own classes when a marker changes", async () => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const container = document.createElement("div");
        const map = new FeedMap(container, "default", true, null, () => undefined);
        await map.init();
        const draw = (point: FeedPoint, selected: string | null) =>
            map.update({ points: [{ key: "a", point, color: "#1565c0" }], shapes: [], areas: [], attributions: [], selected });

        draw(ship(), null);
        // The ship stops: its arrow goes, and it is selected.
        draw(ship({ heading: null, stationary: true }), "a");
        const marker = map["markers"].get("a")!.element;
        expect([...marker.classList]).toEqual(expect.arrayContaining(["maplibregl-marker", "feed-marker", "plain", "selected"]));

        draw(ship(), null);
        expect(marker.classList.contains("maplibregl-marker")).toBe(true);
        expect(marker.classList.contains("selected")).toBe(false);
        expect(marker.classList.contains("plain")).toBe(false);
    });

    it("fades a marker through MapLibre, which owns the element's opacity", async () => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const map = new FeedMap(document.createElement("div"), "default", true, null, () => undefined);
        await map.init();
        map.update({
            points: [{ key: "a", point: ship({ opacity: 0.55 }), color: "#1565c0" }],
            shapes: [],
            areas: [],
            attributions: [],
            selected: null,
        });
        const marker = map["markers"].get("a")!.element;
        expect(marker.dataset.opacity).toBe("0.55");
        expect(marker.style.opacity).toBe("");
    });

    it("draws an aircraft as its silhouette in its colour, with no disc behind it, and a ship as a disc again", async () => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const map = new FeedMap(document.createElement("div"), "default", true, null, () => undefined);
        await map.init();
        const draw = (point: FeedPoint) =>
            map.update({ points: [{ key: "a", point, color: "#9b36f2" }], shapes: [], areas: [], attributions: [], selected: null });
        draw(ship({ kind: "air.large", heading: 94 }));
        const marker = map["markers"].get("a")!.element;
        expect(marker.classList.contains("silhouette")).toBe(true);
        expect(marker.style.background).toBe("");
        expect(marker.style.color).toBe("#9b36f2");
        expect(marker.querySelector("svg.silhouette")).not.toBeNull();

        draw(ship());
        expect(marker.classList.contains("silhouette")).toBe(false);
        expect(marker.classList.contains("disc")).toBe(true);
        expect(marker.style.background).toBe("#9b36f2");
    });

    it("draws a label beside the marker, escaped", async () => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const map = new FeedMap(document.createElement("div"), "default", true, null, () => undefined);
        await map.init();
        const point = ship({ heading: null, stationary: true });
        map.update({
            points: [{ key: "a", point, color: "#1565c0", label: "<b>KUMMELI</b>" }],
            shapes: [],
            areas: [],
            attributions: [],
            selected: null,
        });
        const marker = map["markers"].get("a")!.element;
        expect(marker.querySelector(".marker-label")!.textContent).toBe("<b>KUMMELI</b>");
        expect(marker.querySelector("b")).toBeNull();
        expect(marker.classList.contains("plain")).toBe(true);
    });
});

describe("gliding markers", () => {
    const A: LngLat = [25.0, 60.0];
    const B: LngLat = [25.1, 60.0];
    const C: LngLat = [25.2, 60.0];
    let now = 0;
    let reducedMotion = false;
    let frames: FrameRequestCallback[] = [];
    const cancelled = vi.fn();

    beforeEach(() => {
        now = 0;
        reducedMotion = false;
        frames = [];
        for (const id of Object.keys(sources)) delete sources[id];
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        vi.spyOn(Date, "now").mockImplementation(() => now);
        vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal("cancelAnimationFrame", cancelled);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        cancelled.mockClear();
    });

    async function feedMap() {
        const map = new FeedMap(document.createElement("div"), "default", true, null, () => undefined);
        await map.init();
        return map;
    }

    /** One point, at `position`, reported at `reportedMs`, with `shapes` belonging to it. */
    function content(position: LngLat, reportedMs: number | null, glide = true, shapes: DrawnShape[] = []): MapContent {
        const point = ship({ lon: position[0], lat: position[1] });
        return { points: [{ key: "a", point, color: "#1565c0", glide, reportedMs }], shapes, areas: [], attributions: [], selected: null };
    }

    function drawnAt(map: InstanceType<typeof FeedMap>): string {
        return map["markers"].get("a")!.element.dataset.position!;
    }

    /** Runs the next frame at `ms`. */
    function frameAt(ms: number): void {
        now = ms;
        for (const callback of frames.splice(0)) callback(ms);
    }

    const where = (position: LngLat) => position.map((value) => value.toFixed(5)).join(",");

    it.each<[string, boolean, boolean, number | null, LngLat, LngLat]>([
        ["glides from the position before, when the feed glides", true, false, 15_000, A, [25.05, 60.0]],
        ["jumps when the feed doesn't glide", false, false, 15_000, B, B],
        ["jumps when the system asks for reduced motion", true, true, 15_000, B, B],
        ["jumps when nobody knows when the position was reported", true, false, null, B, B],
    ])("%s", async (_, glide, reduced, reportedMs, atOnce, halfway) => {
        reducedMotion = reduced;
        const map = await feedMap();
        map.update(content(A, 0, glide));
        now = 15_000;
        map.update(content(B, reportedMs, glide));
        expect(drawnAt(map)).toBe(where(atOnce));
        frameAt(22_500);
        expect(drawnAt(map)).toBe(where(halfway));
    });

    it("glides over the time between the reports, however often the card is drawn in between", async () => {
        const map = await feedMap();
        map.update(content(A, 0));
        // The card is drawn again for other reasons, such as another feed, with the same report.
        now = 14_000;
        map.update(content(A, 0));
        now = 15_000;
        map.update(content(B, 15_000));
        now = 20_000;
        map.update(content(B, 15_000));
        frameAt(22_500);
        expect(drawnAt(map)).toBe(where([25.05, 60.0]));
        frameAt(30_000);
        expect(drawnAt(map)).toBe(where(B));
        // At the new report, the glide ends and the frames stop.
        expect(frames).toHaveLength(0);
    });

    /** The point's trail as the feed writes it, ending at the newest report. */
    const trailTo = (...path: LngLat[]): DrawnShape[] => [
        { key: "trail", selects: "a", shape: shape({ type: "line", paths: [[[24.9, 60.0], ...path]] }), color: "#1565c0", name: "" },
    ];
    /** The trail as drawn, rounded, as a glide's positions are worked out in floating point. */
    const trailDrawn = () =>
        (
            sources["feed-shapes"].data as { features: Array<{ geometry: { coordinates: LngLat[][] } }> }
        ).features[0].geometry.coordinates.map((path) => path.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)]));

    it("starts a new glide from where the marker is when a report comes before the last glide has ended", async () => {
        const map = await feedMap();
        map.update(content(A, 0, true, trailTo(A)));
        now = 15_000;
        map.update(content(B, 15_000, true, trailTo(A, B)));
        frameAt(22_500);
        map.update(content(C, 30_000, true, trailTo(A, B, C)));
        expect(drawnAt(map)).toBe(where([25.05, 60.0]));
        // The marker never reached B, so neither does its trail.
        expect(trailDrawn()).toEqual([[[24.9, 60.0], A, [25.05, 60.0]]]);
        frameAt(30_000);
        expect(drawnAt(map)).toBe(where([25.125, 60.0]));
    });

    it("brings a marker whose frames stopped, as in a hidden tab, to where its glide has got to when a report comes", async () => {
        const D: LngLat = [25.3, 60.0];
        const map = await feedMap();
        map.update(content(A, 0, true, trailTo(A)));
        now = 15_000;
        map.update(content(B, 15_000, true, trailTo(A, B)));
        frameAt(22_500);
        // No frames while the tab is hidden, and two reports come, each once the glide before it should have ended.
        now = 31_000;
        map.update(content(C, 30_000, true, trailTo(A, B, C)));
        expect(drawnAt(map)).toBe(where(B));
        expect(trailDrawn()).toEqual([[[24.9, 60.0], A, B]]);
        now = 46_000;
        map.update(content(D, 45_000, true, trailTo(A, B, C, D)));
        expect(drawnAt(map)).toBe(where(C));
        expect(trailDrawn()).toEqual([[[24.9, 60.0], A, B, C]]);
    });

    it("brings a marker whose frames stopped mid-glide to where its glide has got to when a report comes early", async () => {
        const map = await feedMap();
        map.update(content(A, 0, true, trailTo(A)));
        now = 15_000;
        map.update(content(B, 15_000, true, trailTo(A, B)));
        frameAt(22_500);
        now = 27_000;
        map.update(content(C, 30_000, true, trailTo(A, B, C)));
        expect(drawnAt(map)).toBe(where([25.08, 60.0]));
        expect(trailDrawn()).toEqual([[[24.9, 60.0], A, [25.08, 60.0]]]);
        frameAt(34_500);
        expect(drawnAt(map)).toBe(where([25.14, 60.0]));
    });

    it.each<[string, boolean, boolean]>([
        ["jumps to the newest report when its feed stops gliding mid-glide", false, false],
        ["jumps to the newest report when the system asks for reduced motion mid-glide", true, true],
    ])("%s, and draws its trail whole", async (_, glide, reduced) => {
        const map = await feedMap();
        map.update(content(A, 0, true, trailTo(A)));
        now = 15_000;
        map.update(content(B, 15_000, true, trailTo(A, B)));
        frameAt(22_500);
        reducedMotion = reduced;
        map.update(content(B, 15_000, glide, trailTo(A, B)));
        expect(drawnAt(map)).toBe(where(B));
        expect(trailDrawn()).toEqual([[[24.9, 60.0], A, B]]);
    });

    it("cuts the point's trail at the marker while it glides, leaves its areas alone, and draws the trail whole after", async () => {
        const map = await feedMap();
        const before: LngLat = [24.9, 60.0];
        const trail = shape({ type: "line", paths: [[before, A, B]] });
        const area = shape({ type: "polygon", polygons: [[[A, B, [25.1, 60.1], A]]] });
        const shapes: DrawnShape[] = [
            { key: "trail", selects: "a", shape: trail, color: "#1565c0", name: "" },
            { key: "area", selects: "a", shape: area, color: "#1565c0", name: "" },
        ];
        map.update(content(A, 0, true, shapes));
        now = 15_000;
        map.update(content(B, 15_000, true, shapes));
        frameAt(22_500);
        const drawn = () => (sources["feed-shapes"].data as { features: Array<{ geometry: { coordinates: unknown } }> }).features;
        expect(drawn()[0].geometry.coordinates).toEqual([[before, A, [25.05, 60.0]]]);
        expect(drawn()[1].geometry.coordinates).toEqual([[[A, B, [25.1, 60.1], A]]]);
        frameAt(30_000);
        expect(drawn()[0].geometry.coordinates).toEqual([[before, A, B]]);
    });

    it("stops its frames when it is destroyed mid-glide", async () => {
        const map = await feedMap();
        map.update(content(A, 0));
        now = 15_000;
        map.update(content(B, 15_000));
        expect(frames).toHaveLength(1);
        map.destroy();
        expect(cancelled).toHaveBeenCalledTimes(1);
    });
});

function shape(geometry: FeedShape["geometry"]): FeedShape {
    return {
        id: "shape",
        name: "",
        kind: "air.large",
        updatedMs: null,
        subtitle: "",
        color: null,
        details: [],
        notices: [],
        footer: "",
        images: [],
        link: null,
        opacity: 1,
        listRow: { title: null, text: null, value: null, tag: null },
        sortValues: {},
        geometry,
        pointId: "ship:230000001",
    };
}

describe("revealing the selected item", () => {
    // A map 400 × 300 px, where a pixel is 0.00001 degrees: an item moves into view when it is within 32 px of an edge,
    // the details' sheet over the map's bottom counting as its bottom edge, and lands in the middle of the part left clear.
    it.each<[string, [number, number], number, number | null]>([
        ["in the middle, with no sheet", [200, 150], 0, null],
        ["near the bottom edge, with no sheet", [200, 280], 0, 0],
        ["near the left edge", [10, 150], 0, 0],
        ["in the middle, under a sheet covering 140 px", [200, 150], 140, -70],
        ["above the sheet, clear of it", [200, 100], 140, null],
        ["just above the sheet, within the margin", [200, 140], 140, -70],
        ["near the right edge", [390, 150], 0, 0],
        ["near the top edge", [200, 10], 0, 0],
        ["outside the map", [500, 150], 0, 0],
        ["near the left edge, with a sheet open", [10, 100], 140, -70],
        ["right at the margin from the bottom", [200, 268], 0, null],
        ["a pixel past the margin from the bottom", [200, 269], 0, 0],
        ["right at the margin above a sheet covering 140 px", [200, 128], 140, null],
        ["a pixel past the margin above a sheet covering 140 px", [200, 129], 140, -70],
        ["near the top edge, with a sheet open", [200, 10], 140, -70],
        ["right at the margin from the left", [32, 150], 0, null],
        ["a pixel past the margin from the left", [31, 150], 0, 0],
        ["right at the margin from the right", [368, 150], 0, null],
        ["a pixel past the margin from the right", [369, 150], 0, 0],
        ["right at the margin from the top", [200, 32], 0, null],
        ["a pixel past the margin from the top", [200, 31], 0, 0],
        ["near the right edge, with a sheet open", [390, 100], 140, -70],
        ["anywhere, under a sheet that leaves less than two margins clear", [200, 40], 250, -125],
    ])("moves an item into view when it is %s", async (_name, [x, y], covered, offset) => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const map = new FeedMap(document.createElement("div"), "default", true, null, () => undefined);
        await map.init();
        eased.length = 0;
        map.reveal([x / 100_000, y / 100_000], covered);
        expect(eased.map((options) => (options.offset?.[1] ?? NaN) + 0)).toEqual(offset === null ? [] : [offset]);
        expect(eased.map((options) => options.center)).toEqual(offset === null ? [] : [[x / 100_000, y / 100_000]]);
        expect(map.moved).toBe(offset !== null);
    });
});

describe("laying the map out for a new size", () => {
    // It frames itself again for the new size only when it was framed and nobody has moved it since, by hand or to
    // show an item.
    type Step = "framed" | "moved by hand" | "moved by the card" | "moved to show an item" | "an item shown with no move" | "tapped";
    const BOUNDS: [[number, number], [number, number]] = [
        [0, 0],
        [0.004, 0.003],
    ];
    const step = (map: InstanceType<typeof FeedMap>, done: Step) => {
        if (done === "framed") map.fit(BOUNDS);
        // A move someone makes carries the pointer's or the keyboard's event; one the card makes doesn't.
        if (done === "moved by hand") handlers.movestart!({ originalEvent: new Event("pointerdown") });
        if (done === "moved by the card") handlers.movestart!({});
        if (done === "moved to show an item") map.reveal([10 / 100_000, 150 / 100_000]);
        if (done === "an item shown with no move") map.reveal([200 / 100_000, 150 / 100_000]);
        if (done === "tapped") map.tapped();
    };
    it.each<[string, boolean, Step[], boolean]>([
        ["never framed", true, [], false],
        ["framed and not moved since", true, ["framed"], true],
        ["framed, then moved to show an item", true, ["framed", "moved to show an item"], false],
        ["framed, then an item shown that needed no move", true, ["framed", "an item shown with no move"], true],
        ["framed, then moved by hand", true, ["framed", "moved by hand"], false],
        ["framed, then moved by the card's own framing or easing", true, ["framed", "moved by the card"], true],
        ["moved by hand, then framed again", true, ["framed", "moved by hand", "framed"], true],
        ["framed, then an item tapped", true, ["framed", "tapped"], true],
        ["moved by hand, then an item tapped", true, ["framed", "moved by hand", "tapped"], false],
        ["moved to show an item, then framed again", true, ["framed", "moved to show an item", "framed"], true],
        ["not started yet", false, [], false],
    ])("frames itself again when %s", async (_name, started, steps, again) => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const map = new FeedMap(document.createElement("div"), "default", true, null, () => undefined);
        if (started) await map.init();
        for (const done of steps) step(map, done);
        const fit = vi.spyOn(map, "fit");
        map.resize();
        expect(fit).toHaveBeenCalledTimes(again ? 1 : 0);
    });

    // After a tap, the map shows the item whenever the card asks, until someone moves the map; the next tap shows it again.
    it.each<[string, Step[], boolean, boolean]>([
        ["with nothing moved", [], false, true],
        ["after the card's own move", ["moved by the card"], false, true],
        ["after a move by hand", ["moved by hand"], false, false],
        ["after a move by hand and another tap", ["moved by hand"], true, true],
    ])("decides whether to show a hidden item %s", async (_name, steps, tappedAgain, shown) => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const map = new FeedMap(document.createElement("div"), "default", true, null, () => undefined);
        await map.init();
        map.tapped();
        for (const done of steps) step(map, done);
        if (tappedAgain) map.tapped();
        eased.length = 0;
        map.reveal([10 / 100_000, 150 / 100_000]);
        expect(eased).toHaveLength(shown ? 1 : 0);
    });
});
