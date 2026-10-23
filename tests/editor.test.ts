import { describe, expect, it } from "vitest";

import { compactFeeds, feedFields, MapFeedCardEditor } from "../src/editor";
import type { HomeAssistant } from "../src/hass";
import { feedState, shipFeature, trainFeature } from "./support/fakes";

describe("a feed's options in the editor", () => {
    it("offers delays only for what can be late, and no age limit for sightings", () => {
        expect(feedFields("train", false, {})).toEqual(["color_by", "max_age_minutes", "labels", "glide"]);
        expect(feedFields("transit", false, { color_by: "delay" })).toEqual([
            "color_by",
            "late_minutes",
            "very_late_minutes",
            "max_age_minutes",
            "labels",
            "glide",
        ]);
        expect(feedFields("ship", false, {})).toEqual(["max_age_minutes", "labels", "glide"]);
        expect(feedFields("air", false, {})).toEqual(["max_age_minutes", "labels", "glide"]);
        expect(feedFields("road", false, {})).toEqual(["max_age_minutes", "labels"]);
        expect(feedFields("nature", false, {})).toEqual(["labels"]);
    });

    it("offers everything to a feed that doesn't say what it is", () => {
        expect(feedFields(null, true, { color_by: "delay", show_area: true })).toEqual([
            "color_by",
            "late_minutes",
            "very_late_minutes",
            "max_age_minutes",
            "labels",
            "glide",
            "show_area",
            "area_color",
        ]);
        expect(feedFields("other", false, {})).toEqual(["color_by", "max_age_minutes", "labels", "glide"]);
    });

    it("offers the area only to a feed that has one, and its colour once it is shown", () => {
        expect(feedFields("nature", true, {})).toEqual(["labels", "show_area"]);
        expect(feedFields("nature", true, { show_area: true })).toEqual(["labels", "show_area", "area_color"]);
    });

    it("still shows an option that doesn't make sense for the feed but is set, so it can be cleared", () => {
        expect(feedFields("nature", false, { color_by: "delay", max_age_minutes: 30 })).toEqual([
            "color_by",
            "late_minutes",
            "very_late_minutes",
            "max_age_minutes",
            "labels",
        ]);
        expect(feedFields("ship", false, { late_minutes: 5 })).toEqual(["max_age_minutes", "late_minutes", "labels", "glide"]);
        expect(feedFields("ship", false, { color_by: "kind", show_area: false })).toEqual(["max_age_minutes", "labels", "glide"]);
        expect(feedFields("road", false, { glide: true })).toEqual(["max_age_minutes", "labels", "glide"]);
        expect(feedFields("road", false, { glide: false })).toEqual(["max_age_minutes", "labels"]);
    });
});

describe("a feed's options in the configuration", () => {
    it("leaves out gliding switched off, which is the default, and keeps it switched on", () => {
        expect(compactFeeds([{ entity: "sensor.aircraft", glide: false }])).toEqual(["sensor.aircraft"]);
        expect(compactFeeds([{ entity: "sensor.aircraft", glide: true }])).toEqual([{ entity: "sensor.aircraft", glide: true }]);
    });
});

describe("the editor's feeds", () => {
    async function editor(entities: unknown[]) {
        const element = document.createElement("map-feed-card-editor") as MapFeedCardEditor;
        element.hass = {
            states: {
                "sensor.trains": feedState("sensor.trains", [trainFeature()], { feed_type: "train" }),
                "sensor.ships": feedState("sensor.ships", [shipFeature()], { feed_type: "ship" }),
            },
        } as unknown as HomeAssistant;
        element.setConfig({ type: "custom:map-feed-card", entities });
        document.body.append(element);
        await element.updateComplete;
        const configs: Array<Record<string, unknown>> = [];
        element.addEventListener("config-changed", (event) => configs.push((event as CustomEvent).detail.config));
        const form = element.shadowRoot!.querySelector("ha-form") as HTMLElement & { data: Record<string, unknown> };
        const change = (value: Record<string, unknown>) =>
            form.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...form.data, ...value } } }));
        return { form, change, configs };
    }

    it("writes a feed's section back to that feed", async () => {
        const { form, change, configs } = await editor(["sensor.trains", { entity: "sensor.ships", max_age_minutes: 10 }]);
        change({ feed_0: { ...(form.data.feed_0 as object), color_by: "delay" } });
        expect(configs.at(-1)!.entities).toEqual([
            { entity: "sensor.trains", color_by: "delay" },
            { entity: "sensor.ships", max_age_minutes: 10 },
        ]);
    });

    it("keeps each feed's options with it when the list is reordered, whatever the sections still say", async () => {
        const { form, change, configs } = await editor(["sensor.trains", { entity: "sensor.ships", max_age_minutes: 10 }]);
        const [trains, ships] = form.data.entities as unknown[];
        change({ entities: [ships, trains] });
        expect(configs.at(-1)!.entities).toEqual([{ entity: "sensor.ships", max_age_minutes: 10 }, "sensor.trains"]);
    });
});
