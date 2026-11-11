import { describe, expect, it } from "vitest";

import { parseOptions } from "../src/options";

describe("parseOptions", () => {
    it("fills in the defaults for a feed given as a plain entity id", () => {
        expect(parseOptions({ entities: ["sensor.trains"] })).toEqual({
            title: "",
            feeds: [
                {
                    entity: "sensor.trains",
                    colorBy: "kind",
                    delayThresholds: [3, 10],
                    maxAgeMinutes: null,
                    showArea: false,
                    areaColor: null,
                    labels: false,
                    glide: false,
                    frame: "area",
                    inList: true,
                },
            ],
            mapStyle: "default",
            mapHeight: 300,
            legend: true,
            list: false,
            listHeight: 450,
            sort: null,
            start: null,
        });
    });

    it("reads each feed's own options", () => {
        const { feeds } = parseOptions({
            entities: [
                { entity: "sensor.trains", color_by: "delay", late_minutes: 2, very_late_minutes: "15", max_age_minutes: 10 },
                { entity: "sensor.birds", show_area: true, area_color: "#ff6f00", glide: true },
            ],
        });
        expect(feeds[0]).toMatchObject({ colorBy: "delay", delayThresholds: [2, 15], maxAgeMinutes: 10, glide: false });
        expect(feeds[1]).toMatchObject({ showArea: true, areaColor: "#ff6f00", glide: true });
    });

    it("frames the map to a feed's area unless told otherwise, and reads true and false as area and off", () => {
        const { feeds } = parseOptions({
            entities: [
                "sensor.aircraft",
                { entity: "sensor.airspace", frame: "off" },
                { entity: "sensor.ships", frame: "items" },
                { entity: "sensor.birds", frame: true },
                { entity: "sensor.planes", frame: false },
            ],
        });
        expect(feeds.map((feed) => feed.frame)).toEqual(["area", "off", "items", "area", "off"]);
        expect(() => parseOptions({ entities: [{ entity: "sensor.ships", frame: "points" }] })).toThrow(/frame must be one of/);
    });

    it("reads the list's options", () => {
        expect(parseOptions({ entities: ["sensor.birds"], list: true, list_height: 600, sort: " distance " })).toMatchObject({
            list: true,
            listHeight: 600,
            sort: "distance",
        });
        expect(() => parseOptions({ entities: ["sensor.birds"], list_height: 50 })).toThrow(/list_height/);
        const { feeds } = parseOptions({ entities: ["sensor.notams", { entity: "sensor.standing", in_list: false }] });
        expect(feeds.map((feed) => feed.inList)).toEqual([true, false]);
    });

    it("refuses what it can't draw, saying what is wrong", () => {
        expect(() => parseOptions({})).toThrow(/entities is required/);
        expect(() => parseOptions({ entities: ["Trains"] })).toThrow(/isn't an entity id/);
        expect(() => parseOptions({ entities: ["sensor.x"], map_style: "satellite" })).toThrow(/map_style/);
        expect(() => parseOptions({ entities: ["sensor.x"], map_height: 20 })).toThrow(/map_height/);
        expect(() => parseOptions({ entities: [{ entity: "sensor.x", color_by: "speed" }] })).toThrow(/color_by/);
        expect(() => parseOptions({ entities: [{ entity: "sensor.x", late_minutes: 10, very_late_minutes: 5 }] })).toThrow(/late_minutes/);
        expect(() => parseOptions({ entities: [{ entity: "sensor.x", max_age_minutes: 0 }] })).toThrow(/max_age_minutes/);
        expect(() => parseOptions({ entities: [{ entity: "sensor.x", area_color: "var(--x)" }] })).toThrow(/area_color/);
    });

    it("reads the view the map starts in when all three of its fields are set, and no view from one or two", () => {
        const start = (config: Record<string, unknown>) => parseOptions({ entities: ["sensor.x"], ...config }).start;
        expect(start({ latitude: 61.05, longitude: "28.19", zoom: 7.5 })).toEqual({ center: [28.19, 61.05], zoom: 7.5 });
        expect(start({ latitude: 0, longitude: 0, zoom: 0 })).toEqual({ center: [0, 0], zoom: 0 });
        // A form half filled in.
        expect(start({ latitude: 61.05, longitude: 28.19 })).toBeNull();
        expect(start({ latitude: 61.05, longitude: "", zoom: null })).toBeNull();
        expect(() => start({ latitude: 91, longitude: 28.19, zoom: 7 })).toThrow(/latitude/);
        expect(() => start({ latitude: 61.05, longitude: -181, zoom: 7 })).toThrow(/longitude/);
        expect(() => start({ latitude: 61.05, longitude: 28.19, zoom: 19 })).toThrow(/zoom/);
        expect(() => start({ latitude: "north", longitude: 28.19, zoom: 7 })).toThrow(/latitude/);
    });
});
