/** Colours, texts and markers: how an item looks on the map and in its details. */
import { kindFamily, markerSymbol, type FeedItem, type FeedPoint, type FeedShape } from "./feed";
import type { ColorBy } from "./options";

/** A feed's area, when its options give no colour: dark blue would vanish into the dark map's water. */
export function areaColor(dark: boolean): string {
    return dark ? "#64b5f6" : "#1565c0";
}

/** Default colours by feed kind. A feed's own `color` replaces them. */
export const KIND_COLORS: Readonly<Record<string, string>> = {
    "ship.cargo": "#2e7d32",
    "ship.tanker": "#c62828",
    "ship.passenger": "#1565c0",
    "ship.pilot": "#ef6c00",
    "ship.tug": "#6d4c41",
    "ship.fishing": "#00838f",
    "ship.pleasure": "#8e24aa",
    "ship.other": "#546e7a",
    "ship.icebreaker": "#212121",
    "train.long_distance": "#1565c0",
    "train.commuter": "#6a1b9a",
    "train.cargo": "#5d4037",
    "train.other": "#546e7a",
    bus: "#00796b",
    tram: "#2e7d32",
    metro: "#e65100",
    ferry: "#0277bd",
    "road.roadwork": "#ef6c00",
    "road.announcement": "#d32f2f",
    "road.accident": "#b71c1c",
    "road.weight_restriction": "#6d4c41",
    "road.exempted_transport": "#6a1b9a",
    "road.maintenance": "#f9a825",
    "road.maintenance_track": "#f9a825",
    "road.condition.normal": "#2e7d32",
    "road.condition.poor": "#f9a825",
    "road.condition.extremely_poor": "#c62828",
    "road.condition.unknown": "#9e9e9e",
    "road.weather_station": "#0277bd",
    "road.camera": "#37474f",
    bird: "#2e7d32",
    other: "#546e7a",
};

const FAMILY_COLORS = { ship: "#546e7a", train: "#546e7a", transit: "#00796b", road: "#546e7a", other: "#546e7a" } as const;

export type DelayClass = "on_time" | "late" | "very_late" | "cancelled" | "unknown";

export const DELAY_COLORS: Readonly<Record<DelayClass, string>> = {
    on_time: "#2e7d32",
    late: "#f9a825",
    very_late: "#c62828",
    cancelled: "#757575",
    unknown: "#546e7a",
};

/** Lines and polygons without a kind or colour. */
const SHAPE_COLOR = "#1565c0";

/** thresholds: [late from, very late from] in minutes. */
export function delayClass(point: Pick<FeedPoint, "cancelled" | "delayMinutes">, thresholds: readonly [number, number]): DelayClass {
    if (point.cancelled) return "cancelled";
    if (point.delayMinutes === null) return "unknown";
    // Rounded as the details show it, so "3 min late" is never drawn as on time.
    const minutes = Math.round(point.delayMinutes);
    if (minutes >= thresholds[1]) return "very_late";
    if (minutes >= thresholds[0]) return "late";
    return "on_time";
}

/** The feed's own colour, falling back to the kind's default colour. */
export function kindColor(item: Pick<FeedItem, "kind" | "color">): string {
    // A kind is any string from the feed, such as "constructor", which a plain object would answer from its prototype.
    return (
        item.color ?? (Object.hasOwn(KIND_COLORS, item.kind) ? KIND_COLORS[item.kind] : undefined) ?? FAMILY_COLORS[kindFamily(item.kind)]
    );
}

export function pointColor(point: FeedPoint, colorBy: ColorBy, thresholds: readonly [number, number]): string {
    return colorBy === "delay" ? DELAY_COLORS[delayClass(point, thresholds)] : kindColor(point);
}

export function shapeColor(shape: FeedShape): string {
    return !shape.color && shape.kind === "other" ? SHAPE_COLOR : kindColor(shape);
}

/** Black or white text, whichever reads better on the colour. */
export function textOn(hex: string): string {
    const value = hex.length <= 5 ? hex.replace(/^#(.)(.)(.).?$/, "#$1$1$2$2$3$3") : hex;
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16) / 255);
    const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    return luminance > 0.55 ? "#1c1c1c" : "#ffffff";
}

/* ---------------- markers ---------------- */

/** A perched songbird facing right, drawn in the marker's text colour. */
const BIRD = `<svg class="glyph" viewBox="6 19 86 65" aria-hidden="true"><path d="M8 62 L34 56 C40 70 58 74 70 62 C76 56 78 49 77 43 L90 39 L77 34 C75 24 61 21 56 31 C52 40 42 45 33 50 L12 54 Z" fill="currentColor"/><path d="M55 70 L53 82 M63 68 L64 81" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>`;

const ARROW = (heading: number) =>
    `<svg class="arrow" viewBox="-12 -12 24 24" style="transform:rotate(${Math.round(heading)}deg)" aria-hidden="true"><path d="M0,-10 L6.5,9 L0,5 L-6.5,9 Z" fill="currentColor"/></svg>`;

const WARNING = `<svg class="glyph" viewBox="-11 -11 22 22" aria-hidden="true"><path d="M0,-3.5 V2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cy="5.5" r="1.3" fill="currentColor"/></svg>`;

const CAMERA = `<svg class="glyph" viewBox="-11 -9 22 18" aria-hidden="true"><rect x="-9" y="-5" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cy="1" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;

/**
 * The marker's inner HTML: a badge with its text, or a disc with an arrow, a symbol or nothing. Every value from the
 * feed is escaped.
 */
export function markerHtml(point: FeedPoint): { html: string; shape: "badge" | "disc" } {
    const symbol = markerSymbol(point.kind);
    const moving = !point.stationary && point.heading !== null;
    if (point.badge) {
        const lead = moving ? ARROW(point.heading!) : symbol === "bird" ? BIRD : "";
        return { html: `${lead}<span>${escapeHtml(point.badge)}</span>`, shape: "badge" };
    }
    if (symbol === "warning") return { html: WARNING, shape: "disc" };
    if (symbol === "camera") return { html: CAMERA, shape: "disc" };
    if (symbol === "bird") return { html: BIRD, shape: "disc" };
    if (moving) return { html: ARROW(point.heading!), shape: "disc" };
    return { html: "", shape: "disc" };
}

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
