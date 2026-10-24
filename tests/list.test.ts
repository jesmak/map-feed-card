import { describe, expect, it } from "vitest";

import type { Text } from "../src/details";
import type { FeedItem, FeedList, FeedPoint } from "../src/feed";
import { countText, rowOf, sortOptions, sortRows, startingSort } from "../src/list";

const text: Text = (key, values = {}) => {
    const texts: Record<string, string> = {
        "common.just_now": "just now",
        "common.min_ago": "{n} min ago",
        "common.on_time": "on time",
        "common.cancelled": "cancelled",
        "list.delay": "{n} min",
        "list.count": "{n} items",
        "list.count_one": "{n} item",
    };
    return (texts[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

const NOW = Date.parse("2026-10-15T09:00:00Z");

function point(overrides: Partial<FeedPoint> = {}): FeedPoint {
    return {
        id: "train:2026-10-15/8",
        name: "IC 8",
        kind: "train.long_distance",
        updatedMs: NOW - 5 * 60_000,
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
        delayMinutes: 4,
        cancelled: false,
        badge: "IC 8",
        label: "",
        detailAction: null,
        listRow: { title: null, text: null, value: null, tag: null },
        sortValues: {},
        ...overrides,
    };
}

describe("rows", () => {
    it("titles a train by its route and gives its delay as the value", () => {
        expect(rowOf(point(), point(), text, NOW)).toEqual({
            title: "Joensuu → Helsinki",
            text: "",
            value: "4 min",
            valueIsDelay: true,
            tag: null,
        });
        expect(rowOf(point({ delayMinutes: -2.4 }), point({ delayMinutes: -2.4 }), text, NOW).value).toBe("−2 min");
        expect(rowOf(point({ delayMinutes: 0.2 }), point({ delayMinutes: 0.2 }), text, NOW).value).toBe("on time");
        expect(rowOf(point({ cancelled: true }), point({ cancelled: true }), text, NOW).value).toBe("cancelled");
    });

    it("takes the feed's own parts, and the age as the value of something that can't be late", () => {
        const site = point({
            name: "4.6 km east",
            kind: "bird",
            badge: "1",
            subtitle: "1 species · 12.10.",
            delayMinutes: null,
            listRow: { title: "Kaislalahti", text: null, value: "3.9 km", tag: null },
        });
        expect(rowOf(site, site, text, NOW)).toEqual({
            title: "Kaislalahti",
            text: "1 species · 12.10.",
            value: "3.9 km",
            valueIsDelay: false,
            tag: null,
        });
        const plain = point({ name: "Roadwork", kind: "road.roadwork", badge: "", subtitle: "", delayMinutes: null });
        expect(rowOf(plain, plain, text, NOW)).toEqual({ title: "Roadwork", text: "", value: "5 min ago", valueIsDelay: false, tag: null });
    });
});

describe("count", () => {
    const list = (count: string, countOne: string): FeedList => ({ sort: [], defaultKey: null, count, countOne });

    it("counts in the feed's word, with its singular for one", () => {
        expect(countText(1, [list("ilma-alusta", "ilma-alus")], text)).toBe("1 ilma-alus");
        expect(countText(2, [list("ilma-alusta", "ilma-alus")], text)).toBe("2 ilma-alusta");
        expect(countText(0, [list("ilma-alusta", "ilma-alus")], text)).toBe("0 ilma-alusta");
        expect(countText(1, [list("junaa", "")], text)).toBe("1 junaa");
    });

    it("counts in the card's own word, with its singular, when the feeds have none or differ", () => {
        expect(countText(1, [list("", "")], text)).toBe("1 item");
        expect(countText(3, [list("", "")], text)).toBe("3 items");
        expect(countText(1, [list("ilma-alusta", "ilma-alus"), list("junaa", "juna")], text)).toBe("1 item");
        expect(countText(2, [list("ilma-alusta", "ilma-alus"), list("ilma-alusta", "")], text)).toBe("2 items");
        expect(countText(2, [list("ilma-alusta", "ilma-alus"), list("ilma-alusta", "ilma-alus")], text)).toBe("2 ilma-alusta");
    });
});

describe("sorting", () => {
    const birds: FeedList = {
        sort: [
            { key: "distance", label: "Distance", property: "distance_km", descending: false },
            { key: "recent", label: "Most recent", property: "updated", descending: true },
        ],
        defaultKey: "distance",
        count: "",
        countOne: "",
    };
    const trains: FeedList = {
        sort: [{ key: "number", label: "Number", property: "badge", descending: false }],
        defaultKey: "number",
        count: "",
        countOne: "",
    };
    const entry = (name: string, list: FeedList, sortValues: FeedItem["sortValues"]) => ({ item: point({ name, sortValues }), list });

    it("sorts numbers and times, and puts items without the value, or from a feed without the key, last", () => {
        const entries = [
            entry("far", birds, { distance_km: 5.4, updated: 3 }),
            entry("unknown", birds, {}),
            entry("train", trains, { badge: "IC 8" }),
            entry("near", birds, { distance_km: 2.1, updated: 1 }),
            entry("middle", birds, { distance_km: 3.9, updated: 2 }),
        ];
        expect(sortRows(entries, "distance", "fi").map((e) => e.item.name)).toEqual(["near", "middle", "far", "unknown", "train"]);
        expect(sortRows(entries, "recent", "fi").map((e) => e.item.name)).toEqual(["far", "middle", "near", "unknown", "train"]);
        expect(sortRows(entries, null, "fi")).toBe(entries);
    });

    it("sorts text by its numbers, as a person would", () => {
        const entries = [
            entry("a", trains, { badge: "IC 10" }),
            entry("b", trains, { badge: "IC 8" }),
            entry("c", trains, { badge: "IC 111" }),
        ];
        expect(sortRows(entries, "number", "fi").map((e) => e.item.sortValues.badge)).toEqual(["IC 8", "IC 10", "IC 111"]);
    });

    it("offers every feed's keys once, and starts in the card's own key only when some feed has it", () => {
        expect(sortOptions([birds, trains, birds]).map((option) => option.key)).toEqual(["distance", "recent", "number"]);
        expect(startingSort("number", [birds, trains])).toBe("number");
        expect(startingSort("missing", [birds, trains])).toBe("distance");
        expect(startingSort(null, [{ sort: [], defaultKey: null, count: "", countOne: "" }])).toBeNull();
    });
});
