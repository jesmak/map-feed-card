import { describe, expect, it } from "vitest";

import { compactFeeds, feedFields, MapFeedCardEditor } from "../src/editor";
import type { HomeAssistant } from "../src/hass";
import { feedState, shipFeature, trainFeature } from "./support/fakes";

describe("a feed's options in the editor", () => {
    it("offers delays only for what can be late, and no age limit for sightings", () => {
        expect(feedFields("train", false, {})).toEqual(["color_by", "max_age_minutes", "labels", "glide", "frame"]);
        expect(feedFields("transit", false, { color_by: "delay" })).toEqual([
            "color_by",
            "late_minutes",
            "very_late_minutes",
            "max_age_minutes",
            "labels",
            "glide",
            "frame",
        ]);
        expect(feedFields("ship", false, {})).toEqual(["max_age_minutes", "labels", "glide", "frame"]);
        expect(feedFields("air", false, {})).toEqual(["max_age_minutes", "labels", "glide", "frame"]);
        expect(feedFields("road", false, {})).toEqual(["max_age_minutes", "labels", "frame"]);
        expect(feedFields("nature", false, {})).toEqual(["labels", "frame"]);
        expect(feedFields("sea", false, {})).toEqual(["labels", "frame"]);
        expect(feedFields("weather", false, {})).toEqual(["labels", "frame"]);
    });

    it("offers a place in the list only when the card has a list, or one is set anyway", () => {
        expect(feedFields("air", false, {}, true)).toEqual(["max_age_minutes", "labels", "glide", "frame", "in_list"]);
        expect(feedFields("air", false, {})).not.toContain("in_list");
        expect(feedFields("air", false, { in_list: false })).toContain("in_list");
        // The default, left in the entry by the form, is no reason to show it.
        expect(feedFields("air", false, { in_list: true })).not.toContain("in_list");
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
            "frame",
        ]);
        expect(feedFields("other", false, {})).toEqual(["color_by", "max_age_minutes", "labels", "glide", "frame"]);
    });

    it("offers the area only to a feed that has one, and its colour once it is shown", () => {
        expect(feedFields("nature", true, {})).toEqual(["labels", "show_area", "frame"]);
        expect(feedFields("nature", true, { show_area: true })).toEqual(["labels", "show_area", "area_color", "frame"]);
    });

    it("still shows an option that doesn't make sense for the feed but is set, so it can be cleared", () => {
        expect(feedFields("nature", false, { color_by: "delay", max_age_minutes: 30 })).toEqual([
            "color_by",
            "late_minutes",
            "very_late_minutes",
            "max_age_minutes",
            "labels",
            "frame",
        ]);
        expect(feedFields("ship", false, { late_minutes: 5 })).toEqual(["max_age_minutes", "late_minutes", "labels", "glide", "frame"]);
        expect(feedFields("ship", false, { color_by: "kind", show_area: false })).toEqual(["max_age_minutes", "labels", "glide", "frame"]);
        expect(feedFields("road", false, { glide: true })).toEqual(["max_age_minutes", "labels", "glide", "frame"]);
        expect(feedFields("road", false, { glide: false })).toEqual(["max_age_minutes", "labels", "frame"]);
    });
});

describe("a feed's options in the configuration", () => {
    it("leaves out gliding switched off, which is the default, and keeps it switched on", () => {
        expect(compactFeeds([{ entity: "sensor.aircraft", glide: false }])).toEqual(["sensor.aircraft"]);
        expect(compactFeeds([{ entity: "sensor.aircraft", glide: true }])).toEqual([{ entity: "sensor.aircraft", glide: true }]);
        // Framing is on unless turned off.
        expect(compactFeeds([{ entity: "sensor.airspace", frame: "area" }])).toEqual(["sensor.airspace"]);
        expect(compactFeeds([{ entity: "sensor.airspace", frame: "off" }])).toEqual([{ entity: "sensor.airspace", frame: "off" }]);
    });
});

describe("the editor's feeds", () => {
    async function editor(entities: unknown[], parent: ParentNode = document.body) {
        const element = document.createElement("map-feed-card-editor") as MapFeedCardEditor;
        element.hass = {
            states: {
                "sensor.trains": feedState("sensor.trains", [trainFeature()], { feed_type: "train" }),
                "sensor.ships": feedState("sensor.ships", [shipFeature()], { feed_type: "ship" }),
            },
        } as unknown as HomeAssistant;
        element.setConfig({ type: "custom:map-feed-card", entities });
        parent.append(element);
        await element.updateComplete;
        const configs: Array<Record<string, unknown>> = [];
        element.addEventListener("config-changed", (event) => configs.push((event as CustomEvent).detail.config));
        const form = element.shadowRoot!.querySelector("ha-form") as HTMLElement & { data: Record<string, unknown> };
        const change = (value: Record<string, unknown>) =>
            form.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...form.data, ...value } } }));
        return { form, change, configs, element };
    }

    it("writes its preview's view as the view the map starts in, when its button is pressed", async () => {
        // As in the edit dialog: the editor in a shadow tree of its own, its preview in the dialog's, around it.
        const host = document.createElement("div");
        document.body.append(host);
        const dialog = host.attachShadow({ mode: "open" });
        const pane = document.createElement("div");
        const previewPane = document.createElement("div");
        dialog.append(pane, previewPane);
        const { form, configs, element } = await editor(["sensor.trains"], pane.attachShadow({ mode: "open" }));
        const button = form.parentNode!.querySelector("ha-button") as HTMLElement;
        // No preview yet, or one whose map couldn't be drawn.
        button.click();
        const card = Object.assign(document.createElement("map-feed-card"), { mapView: null as unknown });
        previewPane.attachShadow({ mode: "open" }).append(card);
        button.click();
        expect(configs).toEqual([]);
        card.mapView = { center: [28.19, 61.05], zoom: 7.5 };
        // The dashboard's own card, outside the dialog, isn't the preview.
        document.body.append(Object.assign(document.createElement("map-feed-card"), { mapView: { center: [0, 0], zoom: 1 } }));
        button.click();
        expect(configs).toEqual([
            { type: "custom:map-feed-card", entities: ["sensor.trains"], latitude: 61.05, longitude: 28.19, zoom: 7.5 },
        ]);
        expect(element.isConnected).toBe(true);
    });

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
