import { describe, expect, it } from "vitest";

import { besidesRow, delayText, formatAge, groups, speedText, statusLine, titleIsSubtitle, type Text } from "../src/details";
import type { FeedPoint } from "../src/feed";
import { delayClass, kindColor, markerHtml, textOn } from "../src/style";

/** English as the card has it, so the expectations read like the card. */
const text: Text = (key, values = {}) => {
    const texts: Record<string, string> = {
        "common.just_now": "just now",
        "common.min_ago": "{n} min ago",
        "common.hours_ago": "{n} h ago",
        "common.days_ago": "{n} d ago",
        "common.late": "{n} min late",
        "common.early": "{n} min early",
        "common.on_time": "on time",
        "common.cancelled": "Cancelled",
    };
    return (texts[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

const NOW = Date.parse("2026-10-15T09:00:00Z");

function point(overrides: Partial<FeedPoint> = {}): FeedPoint {
    return {
        id: "train:2026-10-15/8",
        name: "IC 8",
        kind: "train.long_distance",
        updatedMs: NOW - 60_000,
        subtitle: "Joensuu → Helsinki",
        color: null,
        details: [],
        notices: [],
        footer: "",
        images: [],
        link: null,
        opacity: 1,
        lon: 27.2,
        lat: 60.9,
        heading: 262,
        stationary: false,
        speedKmh: 148,
        delayMinutes: 11,
        cancelled: false,
        badge: "IC 8",
        label: "",
        detailAction: null,
        listRow: { title: null, text: null, value: null },
        sortValues: {},
        ...overrides,
    };
}

describe("texts", () => {
    it("tells the age in minutes, hours up to two days, then days", () => {
        expect(formatAge(null, text, NOW)).toBe("");
        expect(formatAge(NOW - 20_000, text, NOW)).toBe("just now");
        expect(formatAge(NOW - 50 * 60_000, text, NOW)).toBe("50 min ago");
        expect(formatAge(NOW - 30 * 3600_000, text, NOW)).toBe("30 h ago");
        expect(formatAge(NOW - 72 * 3600_000, text, NOW)).toBe("3 d ago");
    });

    it("rounds delays as they are coloured", () => {
        expect(delayText(2.6, text)).toBe("3 min late");
        expect(delayText(-1.2, text)).toBe("1 min early");
        expect(delayText(0.4, text)).toBe("on time");
        expect(delayText(null, text)).toBe("");
        expect(delayClass({ cancelled: false, delayMinutes: 2.6 }, [3, 10])).toBe("late");
    });

    it("gives ships knots and a direction, everything else km/h", () => {
        expect(speedText({ kind: "ship.cargo", speedKmh: 20.372, stationary: false, heading: 88 })).toBe("11.0 kn · 88°");
        expect(speedText({ kind: "train.commuter", speedKmh: 92.4, stationary: false, heading: null })).toBe("92 km/h");
        expect(speedText({ kind: "bus", speedKmh: null, stationary: false, heading: null })).toBe("");
    });

    it("builds a status line coloured by the delay", () => {
        const late = statusLine(point(), [3, 10], text, NOW);
        expect(late.text).toBe("11 min late · 148 km/h · 1 min ago");
        expect(late.color).toBe("#c62828");
        expect(statusLine(point({ cancelled: true }), [3, 10], text).text.startsWith("Cancelled")).toBe(true);
        expect(statusLine(point({ delayMinutes: null }), [3, 10], text).color).toBeNull();
    });

    it("titles a train by its route, but keeps a name its badge doesn't repeat", () => {
        expect(titleIsSubtitle(point(), point())).toBe(true);
        const site = point({ name: "13.8 km south-east", badge: "17", subtitle: "17 species" });
        expect(titleIsSubtitle(site, site)).toBe(false);
        expect(titleIsSubtitle(point({ subtitle: "" }), point())).toBe(false);
        expect(titleIsSubtitle(point(), null)).toBe(false);
    });
});

describe("details under a list row", () => {
    it("add the name, subtitle and age that the row's own parts left out", () => {
        const parts = { title: "13.8 km south-east", subtitle: "5 species · 14.10.", age: "1 d ago" };
        expect(besidesRow({ title: "13.8 km south-east", text: "5 species · 14.10.", value: "1 d ago" }, parts)).toEqual([]);
        expect(besidesRow({ title: "Kaislalahti", text: "5 species · 14.10.", value: "3.9 km" }, parts)).toEqual([
            "13.8 km south-east",
            "1 d ago",
        ]);
        expect(besidesRow({ title: "13.8 km south-east", text: "", value: "1 d ago" }, { ...parts, subtitle: "" })).toEqual([]);
    });
});

describe("detail rows", () => {
    it("groups rows with and without a picture in the order they come", () => {
        const image = { url: "https://example.com/a.jpg", caption: "", takenMs: null };
        const rows = [
            { label: "Waxwing", value: "24 birds", unit: "", image },
            { label: "Bullfinch", value: "3 birds", unit: "", image },
            { label: "Observers", value: "2", unit: "" },
            { label: "Mallard", value: "6 birds", unit: "", image },
        ];
        expect(groups(rows).map((group) => [group.media, group.rows.length])).toEqual([
            [true, 2],
            [false, 1],
            [true, 1],
        ]);
    });
});

describe("markers and colours", () => {
    it("escapes a feed's badge", () => {
        expect(markerHtml(point({ badge: '<img src=x onerror="alert(1)">' })).html).not.toContain("<img");
    });

    it("draws a badge, an arrow, a symbol or a plain dot", () => {
        expect(markerHtml(point()).shape).toBe("badge");
        expect(markerHtml(point({ badge: "" })).html).toContain("arrow");
        expect(markerHtml(point({ badge: "", kind: "road.camera" })).html).toContain("<svg");
        expect(markerHtml(point({ badge: "", heading: null })).html).toBe("");
    });

    it("never takes a kind's colour from an object's prototype", () => {
        expect(kindColor({ kind: "constructor", color: null })).toBe("#546e7a");
        expect(kindColor({ kind: "bird", color: "#d84315" })).toBe("#d84315");
    });

    it("picks readable text for a colour", () => {
        expect(textOn("#f9a825")).toBe("#1c1c1c");
        expect(textOn("#c62828")).toBe("#ffffff");
        expect(textOn("#fff")).toBe("#1c1c1c");
    });
});
