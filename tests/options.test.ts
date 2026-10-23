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
                },
            ],
            mapStyle: "default",
            mapHeight: 300,
            legend: true,
            list: false,
            listHeight: 450,
            sort: null,
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

    it("reads the list's options", () => {
        expect(parseOptions({ entities: ["sensor.birds"], list: true, list_height: 600, sort: " distance " })).toMatchObject({
            list: true,
            listHeight: 600,
            sort: "distance",
        });
        expect(() => parseOptions({ entities: ["sensor.birds"], list_height: 50 })).toThrow(/list_height/);
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
});
