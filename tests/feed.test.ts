import { describe, expect, it } from "vitest";
import { areaOutline, boundsOf, isMoving, kindFamily, readDetailRows, readFeed } from "../src/feed";
import { aircraftFeature, cameraFeature, feedState, roadworkLine, shipFeature, trainFeature } from "./support/fakes";

function okFeed(state: ReturnType<typeof feedState>) {
    const result = readFeed(state);
    if (result.status !== "ok") throw new Error(`expected a feed, got ${result.status}`);
    return result.feed;
}

describe("readFeed", () => {
    it("reads points with GeoJSON coordinates read as longitude and latitude", () => {
        const feed = okFeed(feedState("sensor.ships", [shipFeature()], { attribution: "Fintraffic" }));
        expect(feed.attribution).toBe("Fintraffic");
        expect(feed.points).toHaveLength(1);
        const [point] = feed.points;
        expect(point).toMatchObject({
            id: "ship:230113940",
            lat: 60.53044,
            lon: 27.17012,
            name: "PILOT L117",
            kind: "ship.pilot",
            heading: 88,
            stationary: false,
            speedKmh: 20.4,
            footer: "MMSI 230113940",
        });
        expect(point?.details).toEqual([
            { label: "Tyyppi", value: "Luotsivene", unit: "" },
            { label: "Syväys", value: "2.2", unit: "m" },
        ]);
    });

    it("reads the optional train properties and detail action", () => {
        const [point] = okFeed(feedState("sensor.trains", [trainFeature()])).points;
        expect(point).toMatchObject({
            badge: "IC 8",
            label: "→ Helsinki",
            subtitle: "Joensuu → Helsinki",
            delayMinutes: 11,
            cancelled: false,
            notices: ["Juna on myöhässä ratatöiden vuoksi."],
            detailAction: {
                domain: "digitraffic_live",
                service: "get_train_composition",
                data: { departure_date: "2026-09-14", train_number: 8 },
            },
        });
    });

    it("reports entities that are not usable feeds", () => {
        expect(readFeed(undefined)).toEqual({ status: "missing" });
        expect(readFeed({ entity_id: "sensor.x", state: "unavailable", attributes: {} })).toEqual({
            status: "unavailable",
        });
        expect(readFeed({ entity_id: "sensor.x", state: "3", attributes: {} })).toEqual({ status: "not_a_feed" });
        expect(readFeed(feedState("sensor.x", [], { map_feed_version: 2 }))).toEqual({
            status: "unsupported_version",
            version: 2,
        });
    });

    it("skips invalid features and ignores invalid values", () => {
        const feed = okFeed(
            feedState("sensor.x", [
                shipFeature({
                    color: "red;background:url(x)",
                    heading: -90,
                    detail_action: { action: "not an action" },
                }),
                { ...shipFeature(), id: undefined },
                { ...shipFeature(), geometry: { type: "Point", coordinates: [27, 95] } },
                "not a feature",
            ]),
        );
        expect(feed.skipped).toBe(3);
        expect(feed.points[0]).toMatchObject({ color: null, heading: 270, detailAction: null });
    });

    it("accepts a hex colour and a GeoJSON string", () => {
        const state = feedState("sensor.x", []);
        state.attributes.geojson = JSON.stringify({
            type: "FeatureCollection",
            features: [shipFeature({ color: "#ff8800" })],
        });
        expect(okFeed(state).points[0]?.color).toBe("#ff8800");
    });

    it("reads areas, lines and polygons", () => {
        const feed = okFeed(
            feedState(
                "sensor.x",
                [
                    {
                        type: "Feature",
                        geometry: {
                            type: "LineString",
                            coordinates: [
                                [27, 60],
                                [28, 61],
                            ],
                        },
                        properties: { name: "Route" },
                    },
                    {
                        type: "Feature",
                        id: "works",
                        geometry: {
                            type: "Polygon",
                            coordinates: [
                                [
                                    [27, 60],
                                    [28, 60],
                                    [28, 61],
                                    [27, 60],
                                ],
                            ],
                        },
                    },
                ],
                { area: { center: [60.569, 27.198], radius_km: 15 } },
            ),
        );
        expect(feed.area).toEqual({ type: "circle", lat: 60.569, lon: 27.198, radiusKm: 15 });
        expect(feed.shapes).toMatchObject([
            {
                id: "shape:0",
                name: "Route",
                kind: "other",
                pointId: "",
                geometry: {
                    type: "line",
                    paths: [
                        [
                            [27, 60],
                            [28, 61],
                        ],
                    ],
                },
            },
            {
                id: "works",
                name: "",
                geometry: {
                    type: "polygon",
                    polygons: [
                        [
                            [
                                [27, 60],
                                [28, 60],
                                [28, 61],
                                [27, 60],
                            ],
                        ],
                    ],
                },
            },
        ]);

        const box = okFeed(feedState("sensor.x", [], { area: { bbox: [60, 26, 61, 28] } }));
        expect(box.area).toEqual({ type: "bbox", south: 60, west: 26, north: 61, east: 28 });
        expect(okFeed(feedState("sensor.x", [], { area: { bbox: [61, 26, 60, 28] } })).area).toBeNull();
    });
});

describe("readFeed: versions", () => {
    it("takes the version as text too, and names the value it doesn't support", () => {
        expect(readFeed(feedState("sensor.x", [shipFeature()], { map_feed_version: "1" })).status).toBe("ok");
        expect(readFeed(feedState("sensor.x", [shipFeature()], { map_feed_version: "2" }))).toEqual({
            status: "unsupported_version",
            version: "2",
        });
    });
});

describe("readFeed: road features", () => {
    it("reads multi-part lines with their properties and the point they belong to", () => {
        const [shape] = okFeed(feedState("sensor.x", [roadworkLine({ name: "Tie 26", details: [{ label: "A", value: "B" }] })])).shapes;
        expect(shape).toMatchObject({
            id: "roadwork:1/line",
            kind: "road.roadwork",
            name: "Tie 26",
            pointId: "roadwork:1",
            details: [{ label: "A", value: "B", unit: "" }],
            geometry: {
                type: "line",
                paths: [
                    [
                        [27.2, 60.6],
                        [27.21, 60.61],
                    ],
                    [
                        [27.25, 60.65],
                        [27.26, 60.66],
                    ],
                ],
            },
        });
    });

    it("reads multi-part polygons", () => {
        const ring = (lon: number, lat: number) => [
            [lon, lat],
            [lon + 1, lat],
            [lon + 1, lat + 1],
            [lon, lat],
        ];
        const [shape] = okFeed(
            feedState("sensor.x", [
                {
                    type: "Feature",
                    id: "a",
                    geometry: { type: "MultiPolygon", coordinates: [[ring(27, 60)], [ring(29, 62)]] },
                },
            ]),
        ).shapes;
        expect(shape?.geometry.type).toBe("polygon");
        expect(shape?.geometry.type === "polygon" && shape.geometry.polygons.length).toBe(2);
    });

    it("reads a link, only with an https address, and a clamped opacity", () => {
        const feed = okFeed(
            feedState("sensor.x", [
                shipFeature({ link: { url: "https://example.com/place/1", label: "On Example" }, opacity: 0.5 }),
                { ...shipFeature({ link: { url: "https://example.com/a" }, opacity: 0.05 }), id: "b" },
                { ...shipFeature({ link: { url: "javascript:alert(1)" }, opacity: 7 }), id: "c" },
                { ...shipFeature(), id: "d" },
            ]),
        );
        expect(feed.points.map((point) => [point.link, point.opacity])).toEqual([
            [{ url: "https://example.com/place/1", label: "On Example" }, 0.5],
            [{ url: "https://example.com/a", label: "example.com" }, 0.3],
            [null, 1],
            [null, 1],
        ]);
    });

    it("keeps only https images", () => {
        const [point] = okFeed(
            feedState("sensor.x", [
                cameraFeature({
                    images: [
                        {
                            url: "https://weathercam.digitraffic.fi/C0355801.jpg",
                            caption: "Imatralle",
                            time: "2026-09-15T11:47:33Z",
                        },
                        { url: "javascript:alert(1)" },
                        { url: "http://example.com/x.jpg" },
                        "x",
                    ],
                }),
            ]),
        ).points;
        expect(point?.images).toEqual([
            {
                url: "https://weathercam.digitraffic.fi/C0355801.jpg",
                caption: "Imatralle",
                takenMs: Date.parse("2026-09-15T11:47:33Z"),
                link: null,
            },
        ]);
    });
});

describe("readDetailRows", () => {
    it("keeps rows with a label and a value", () => {
        expect(readDetailRows([{ label: "Train", value: "5 cars" }, { label: "Empty", value: "" }, { value: 3 }, "x"])).toEqual([
            { label: "Train", value: "5 cars", unit: "" },
        ]);
        expect(readDetailRows(undefined)).toEqual([]);
    });

    it("keeps a row picture only with an https address", () => {
        const [pictured, plain] = readDetailRows([
            { label: "sinisorsa", value: "6", image: { url: "https://example.org/duck.jpg", caption: "Duck" } },
            { label: "naakka", value: "2", image: { url: "javascript:alert(1)" } },
        ]);
        expect(pictured?.image).toEqual({ url: "https://example.org/duck.jpg", caption: "Duck", takenMs: null, link: null });
        expect(plain?.image).toBeUndefined();
    });
});

describe("readFeed: legend and tags", () => {
    it("reads the feed's legend and leaves out entries without a hex colour or a label", () => {
        const feed = okFeed(
            feedState("sensor.birds", [], {
                legend: [{ color: "#2e7d32", label: "Sighting" }, { color: "red", label: "Not hex" }, { color: "#d84315" }, "nonsense"],
            }),
        );
        expect(feed.legend).toEqual([{ color: "#2e7d32", label: "Sighting" }]);
    });

    it("reads a row's tag, and an unknown tone as neutral", () => {
        expect(
            readDetailRows([
                { label: "Velvet scoter", value: "2 birds", tag: { text: "VU", tone: "warning" } },
                { label: "Waxwing", value: "24 birds", tag: { text: "Notable", tone: "item" } },
                { label: "Bullfinch", value: "3 birds", tag: { text: "Odd", tone: "purple" } },
                { label: "Mallard", value: "6 birds", tag: { tone: "info" } },
            ]).map((row) => row.tag),
        ).toEqual([{ text: "VU", tone: "warning" }, { text: "Notable", tone: "item" }, { text: "Odd", tone: "neutral" }, undefined]);
    });
});

describe("readFeed: area", () => {
    it("takes only an area the map can draw", () => {
        const area = (value: unknown) => okFeed(feedState("sensor.x", [], { area: value })).area;
        expect(area({ center: [61.0, 28.2], radius_km: 15 })).toEqual({ type: "circle", lat: 61.0, lon: 28.2, radiusKm: 15 });
        // Longitude first, as GeoJSON writes it, puts the latitude out of range.
        expect(area({ center: [120.5, 30.2], radius_km: 15 })).toBeNull();
        expect(area({ center: [61.0, 28.2], radius_km: 5000 })).toBeNull();
        expect(area({ bbox: [60.9, 27.9, 61.2, 28.5] })).toMatchObject({ type: "bbox" });
        expect(area({ bbox: [60.9, 27.9, 95, 28.5] })).toBeNull();
    });
});

describe("readFeed: type", () => {
    it("reads the feed's type, and nothing it doesn't know", () => {
        expect(okFeed(feedState("sensor.birds", [], { feed_type: "nature" })).type).toBe("nature");
        expect(okFeed(feedState("sensor.x", [], { feed_type: "birds" })).type).toBeNull();
        expect(okFeed(feedState("sensor.x", [])).type).toBeNull();
    });
});

describe("readFeed: list", () => {
    const list = {
        sort: [
            { key: "distance", label: "Distance", property: "distance_km" },
            { key: "recent", label: "Most recent", property: "updated", order: "desc" },
            { key: "distance", label: "Again", property: "other" },
            { key: "broken", label: "No property" },
            { key: "proto", label: "Prototype", property: "constructor" },
        ],
        default: "missing",
        count: "sites",
    };

    it("reads sort keys, leaving out duplicates and keys without a property, and falls back to the first key", () => {
        const feed = okFeed(feedState("sensor.birds", [], { list }));
        expect(feed.list.sort.map((key) => [key.key, key.property, key.descending])).toEqual([
            ["distance", "distance_km", false],
            ["recent", "updated", true],
            ["proto", "constructor", false],
        ]);
        expect(feed.list.defaultKey).toBe("distance");
        expect(feed.list.count).toBe("sites");
        expect(okFeed(feedState("sensor.birds", [])).list).toEqual({ sort: [], defaultKey: null, count: "", countOne: "" });
    });

    it("keeps the values sort keys name, as numbers, times or text, and never a prototype's", () => {
        const feed = okFeed(
            feedState(
                "sensor.birds",
                [shipFeature({ distance_km: 3.9, updated: "2026-10-12T07:30:00Z", list: { title: "Kaislalahti", text: "" } })],
                {
                    list,
                },
            ),
        );
        const [point] = feed.points;
        expect(point!.sortValues).toEqual({ distance_km: 3.9, updated: Date.parse("2026-10-12T07:30:00Z") });
        expect(point!.listRow).toEqual({ title: "Kaislalahti", text: "", value: null, tag: null });
    });

    it("reads a row's parts only as text", () => {
        const feed = okFeed(feedState("sensor.x", [shipFeature({ list: { title: { html: "<b>" }, value: 3.9 } })]));
        expect(feed.points[0]!.listRow).toEqual({ title: null, text: null, value: "3.9", tag: null });
    });

    it("reads a row's tag as a detail row's: text, and a tone it knows or neutral", () => {
        const rowOf = (tag: unknown) => okFeed(feedState("sensor.x", [shipFeature({ list: { tag } })])).points[0]!.listRow.tag;
        expect(rowOf({ text: "NEW", tone: "warning" })).toEqual({ text: "NEW", tone: "warning" });
        expect(rowOf({ text: "NEW", tone: "loud" })).toEqual({ text: "NEW", tone: "neutral" });
        expect(rowOf({ text: "NEW" })).toEqual({ text: "NEW", tone: "neutral" });
        expect(rowOf({ text: "", tone: "warning" })).toBeNull();
        expect(rowOf({ text: { html: "<b>NEW</b>" } })).toBeNull();
        expect(rowOf("NEW")).toBeNull();
    });
});

describe("geometry", () => {
    it("outlines a bbox as a closed ring", () => {
        expect(areaOutline({ type: "bbox", south: 60, west: 27, north: 61, east: 28 })).toEqual([
            [27, 60],
            [28, 60],
            [28, 61],
            [27, 61],
            [27, 60],
        ]);
    });

    it("outlines a circle with points at its radius", () => {
        const outline = areaOutline({ type: "circle", lat: 61, lon: 28, radiusKm: 10 });
        expect(outline).toHaveLength(65);
        expect(outline[0]![1]).toBeCloseTo(61 + 10 / 111.2, 2);
        expect(outline[0]).toEqual(outline[64]);
    });

    it("gives the bounds of positions, or null when there are none", () => {
        expect(
            boundsOf([
                [27.5, 61.2],
                [28.1, 60.9],
                [27.9, 61.0],
            ]),
        ).toEqual([
            [27.5, 60.9],
            [28.1, 61.2],
        ]);
        expect(boundsOf([])).toBeNull();
    });
});

describe("readFeed: aircraft", () => {
    it("reads an air feed with its attribution's link and the singular of its count", () => {
        const feed = okFeed(
            feedState("sensor.aircraft", [aircraftFeature()], {
                feed_type: "air",
                attribution: "adsb.fi",
                attribution_url: "https://adsb.fi/",
                list: { count: "ilma-alusta", count_one: "ilma-alus" },
            }),
        );
        expect(feed.type).toBe("air");
        expect(feed.attributionUrl).toBe("https://adsb.fi/");
        expect(feed.list.count).toBe("ilma-alusta");
        expect(feed.list.countOne).toBe("ilma-alus");
    });

    it("keeps the attribution's link only with an https address", () => {
        const feed = (url: unknown) => okFeed(feedState("sensor.aircraft", [], { attribution: "adsb.fi", attribution_url: url }));
        expect(feed("http://adsb.fi/").attributionUrl).toBe("");
        expect(feed("javascript:alert(1)").attributionUrl).toBe("");
        expect(feed(42).attributionUrl).toBe("");
        expect(feed("http://adsb.fi/").attribution).toBe("adsb.fi");
    });

    it("keeps a picture's link only with an https address", () => {
        const images = (link: unknown) =>
            okFeed(feedState("sensor.aircraft", [aircraftFeature({ images: [{ url: "https://example.org/a.jpg", link }] })])).points[0]!
                .images[0]!.link;
        expect(images("https://example.org/photos/a320")).toBe("https://example.org/photos/a320");
        expect(images("javascript:alert(1)")).toBeNull();
        expect(images(undefined)).toBeNull();
    });

    it("counts air kinds as a family that moves", () => {
        expect(kindFamily("air.large")).toBe("air");
        expect(kindFamily("air.hovercraft")).toBe("air");
        expect(kindFamily("aircraft")).toBe("other");
        expect(isMoving("air.balloon")).toBe(true);
    });
});
