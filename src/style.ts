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
    "air.light": "#2e7d32",
    "air.small": "#00838f",
    "air.large": "#1565c0",
    "air.turboprop": "#795548",
    "air.heavy": "#6a1b9a",
    "air.high_performance": "#c62828",
    "air.rotorcraft": "#ef6c00",
    "air.glider": "#f9a825",
    "air.balloon": "#d81b60",
    "air.drone": "#37474f",
    "air.other": "#546e7a",
    bird: "#2e7d32",
    other: "#546e7a",
};

const FAMILY_COLORS = { ship: "#546e7a", train: "#546e7a", transit: "#00796b", air: "#546e7a", road: "#546e7a", other: "#546e7a" } as const;

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

/**
 * Whether colouring by delay applies: to trains and public transport, and to anything that says it is late or
 * cancelled. A bird or a road work has no delay to show, so it keeps its own colour.
 */
export function canBeLate(point: Pick<FeedPoint, "kind" | "delayMinutes" | "cancelled">): boolean {
    const family = kindFamily(point.kind);
    return family === "train" || family === "transit" || point.delayMinutes !== null || point.cancelled;
}

export function pointColor(point: FeedPoint, colorBy: ColorBy, thresholds: readonly [number, number]): string {
    return colorBy === "delay" && canBeLate(point) ? DELAY_COLORS[delayClass(point, thresholds)] : kindColor(point);
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
 * Aircraft from above, nose up, in a 100 × 100 box, filled with the marker's colour and edged with --silhouette-edge.
 * Drawn for this card: tar1090's shapes are GPL.
 */
const SILHOUETTES: Readonly<Record<string, string>> = {
    "air.light": `<path d="M50 16 C53 16 54.5 20 54.5 26 L54.5 34 L96 34 L96 43 L54.5 43 L54 74 L67 76 L67 83 L50 82 L33 83 L33 76 L46 74 L45.5 43 L4 43 L4 34 L45.5 34 L45.5 26 C45.5 20 47 16 50 16 Z"/><rect x="39" y="11" width="22" height="4" rx="2"/>`,
    "air.small": `<path d="M50 8 C53 8 54 12 54 18 L54 38 L95 40 L95 48 L54 50 L54 78 L68 82 L68 88 L50 86 L32 88 L32 82 L46 78 L46 50 L5 48 L5 40 L46 38 L46 18 C46 12 47 8 50 8 Z"/><ellipse cx="31" cy="38" rx="4.5" ry="10"/><ellipse cx="69" cy="38" rx="4.5" ry="10"/>`,
    "air.large": `<path d="M50 8 C53 8 54.5 12 54.5 17 L54.5 37 L92 57 L92 64 L54.5 55 L54.5 76 L66 84 L66 89 L50 85.5 L34 89 L34 84 L45.5 76 L45.5 55 L8 64 L8 57 L45.5 37 L45.5 17 C45.5 12 47 8 50 8 Z"/>`,
    // An ATR or a Dash 8: a straight wing with its engines' propellers in front, which no other kind has.
    "air.turboprop": `<path d="M50 4 C53.5 4 55 8.5 55 15 L55 79 L68 84 L68 90 L50 87.5 L32 90 L32 84 L45 79 L45 15 C45 8.5 46.5 4 50 4 Z"/><rect x="2" y="36" width="96" height="9" rx="3"/><rect x="25" y="25" width="9" height="22" rx="4"/><rect x="66" y="25" width="9" height="22" rx="4"/><rect x="18" y="21" width="23" height="3.6" rx="1.8"/><rect x="59" y="21" width="23" height="3.6" rx="1.8"/>`,
    "air.heavy": `<path d="M50 3 C54.5 3 56.5 8 56.5 15 L56.5 36 L97 61 L97 68 L56.5 57 L56.5 80 L71 89 L71 94 L50 90 L29 94 L29 89 L43.5 80 L43.5 57 L3 68 L3 61 L43.5 36 L43.5 15 C43.5 8 45.5 3 50 3 Z"/><ellipse cx="28" cy="52" rx="4" ry="7"/><ellipse cx="72" cy="52" rx="4" ry="7"/>`,
    "air.high_performance": `<path d="M50 3 L54.5 20 L55.5 46 L89 70 L89 77 L56.5 71 L57.5 82 L69 92 L69 97 L50 93 L31 97 L31 92 L42.5 82 L43.5 71 L11 77 L11 70 L44.5 46 L45.5 20 Z"/>`,
    "air.rotorcraft": `<ellipse cx="50" cy="42" rx="11" ry="16"/><rect x="47" y="54" width="6" height="34" rx="2"/><rect x="39" y="84" width="22" height="6" rx="2"/><rect x="47" y="2" width="6" height="80" rx="3" transform="rotate(45 50 42)"/><rect x="47" y="2" width="6" height="80" rx="3" transform="rotate(-45 50 42)"/>`,
    "air.glider": `<path d="M50 24 C52 24 52.5 28 52.5 32 L52.5 38 L99 40.5 L99 44.5 L52.5 45 L52 80 L62 82 L62 86 L50 85 L38 86 L38 82 L48 80 L47.5 45 L1 44.5 L1 40.5 L47.5 38 L47.5 32 C47.5 28 48 24 50 24 Z"/>`,
    "air.balloon": `<circle cx="50" cy="50" r="30"/><path d="M50 20 V80 M24 35 Q50 50 76 35 M24 65 Q50 50 76 65" fill="none" opacity="0.5"/>`,
    "air.drone": `<path d="M24 24 L76 76 M76 24 L24 76" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/><circle cx="22" cy="22" r="13"/><circle cx="78" cy="22" r="13"/><circle cx="22" cy="78" r="13"/><circle cx="78" cy="78" r="13"/><rect x="40" y="40" width="20" height="20" rx="5"/>`,
};

/** An aircraft's silhouette, turned to its heading, or north when it has none. Kinds without a shape get an arrow. */
function silhouette(point: FeedPoint): string | null {
    const shape = Object.hasOwn(SILHOUETTES, point.kind) ? SILHOUETTES[point.kind] : undefined;
    if (!shape) return null;
    return `<svg class="silhouette" viewBox="0 0 100 100" style="transform:rotate(${Math.round(point.heading ?? 0)}deg)" aria-hidden="true">${shape}</svg>`;
}

/**
 * The marker's inner HTML: a badge with its text, an aircraft's silhouette, or a disc with an arrow, a symbol or
 * nothing. Every value from the feed is escaped.
 */
export function markerHtml(point: FeedPoint): { html: string; shape: "badge" | "disc" | "silhouette" } {
    const symbol = markerSymbol(point.kind);
    const moving = !point.stationary && point.heading !== null;
    if (point.badge) {
        const lead = moving ? ARROW(point.heading!) : symbol === "bird" ? BIRD : "";
        return { html: `${lead}<span>${escapeHtml(point.badge)}</span>`, shape: "badge" };
    }
    if (symbol === "warning") return { html: WARNING, shape: "disc" };
    if (symbol === "camera") return { html: CAMERA, shape: "disc" };
    if (symbol === "bird") return { html: BIRD, shape: "disc" };
    const aircraft = silhouette(point);
    if (aircraft) return { html: aircraft, shape: "silhouette" };
    if (moving) return { html: ARROW(point.heading!), shape: "disc" };
    return { html: "", shape: "disc" };
}

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
