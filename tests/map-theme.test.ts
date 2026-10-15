import { describe, expect, it } from "vitest";
import type { StyleSpecification } from "maplibre-gl";

import { withLatinLabels } from "../src/map-theme";

describe("English names", () => {
    const style = {
        version: 8,
        sources: {},
        layers: [
            { id: "place", type: "symbol", source: "x", layout: { "text-field": ["get", "name"] } },
            { id: "street", type: "symbol", source: "x", layout: { "text-field": ["get", "name"], "symbol-placement": "line" } },
            { id: "number", type: "symbol", source: "x", layout: { "text-field": ["get", "housenumber"] } },
            { id: "land", type: "fill", source: "x" },
        ],
    } as unknown as StyleSpecification;

    it("adds them under names, in brackets on streets, and leaves other labels and layers alone", () => {
        const [place, street, number, land] = withLatinLabels(style).layers as unknown as Array<{ layout?: Record<string, unknown> }>;
        const placeField = JSON.stringify(place!.layout!["text-field"]);
        expect(placeField).toContain('"format"');
        expect(placeField).toContain('"name_en"');
        expect(JSON.stringify(street!.layout!["text-field"])).toContain('" ("');
        expect(number!.layout!["text-field"]).toEqual(["get", "housenumber"]);
        expect(land!.layout).toBeUndefined();
    });
});
