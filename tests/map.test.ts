import { describe, expect, it, vi } from "vitest";

import type { FeedPoint } from "../src/feed";

// MapLibre needs WebGL, which happy-dom lacks. The fakes do only what matters here: a marker added to the map gets
// MapLibre's own class, which places it on the map.
vi.mock("maplibre-gl", () => {
    const noop = () => undefined;
    class FakeMap {
        touchZoomRotate = { disableRotation: noop };
        keyboard = { disableRotation: noop };
        on = noop;
        once = noop;
        addControl = noop;
        removeControl = noop;
        addSource = noop;
        addLayer = noop;
        isStyleLoaded = () => true;
        getSource = () => ({ setData: noop });
    }
    class Marker {
        private readonly element: HTMLElement;
        constructor({ element }: { element: HTMLElement }) {
            this.element = element;
        }
        setLngLat() {
            return this;
        }
        addTo() {
            this.element.classList.add("maplibregl-marker");
            return this;
        }
        remove() {}
    }
    return { Map: FakeMap, Marker, AttributionControl: class {}, NavigationControl: class {}, setWorkerUrl: noop };
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
        ...overrides,
    };
}

describe("map markers", () => {
    it("keeps MapLibre's own classes when a marker changes", async () => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as RenderingContext);
        const container = document.createElement("div");
        const map = new FeedMap(container, "default", true, () => undefined);
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
});
