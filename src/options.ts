/**
 * The card's configuration (README.md#options), checked when it is set. A value that can't be used throws, so
 * Home Assistant shows what is wrong in place of the card instead of a map quietly drawn some other way.
 */
import { number } from "./feed";

export const MAP_STYLES = ["default", "colorful", "natural", "muted", "gray", "toner"] as const;
export type MapStyle = (typeof MAP_STYLES)[number];

export type ColorBy = "kind" | "delay";
const COLOR_BY: readonly ColorBy[] = ["kind", "delay"];

export const DEFAULT_DELAY_THRESHOLDS: [number, number] = [3, 10];
export const DEFAULT_MAP_HEIGHT = 300;

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

/** How one feed is drawn, set per feed. */
export interface FeedOptions {
    entity: string;
    colorBy: ColorBy;
    /** Minutes late from which an item is [late, very late]. */
    delayThresholds: [number, number];
    /** Items with an older position are hidden; null = show everything the feed has. */
    maxAgeMinutes: number | null;
    showArea: boolean;
    /** null = the theme's own, from style.ts. */
    areaColor: string | null;
}

export interface CardOptions {
    title: string;
    feeds: FeedOptions[];
    mapStyle: MapStyle;
    mapHeight: number;
    legend: boolean;
}

export function parseOptions(raw: unknown): CardOptions {
    const config = isRecord(raw) ? raw : {};
    const entries = Array.isArray(config.entities) ? config.entities : [];
    if (entries.length === 0) {
        throw new Error("entities is required: the map feed sensors to draw, e.g. entities: [sensor.ships_near_the_cabin]");
    }
    // A feed with nothing but its entity can be written as the plain entity id.
    const feeds = entries.map((entry) => parseFeed(typeof entry === "string" ? { entity: entry } : isRecord(entry) ? entry : {}));
    return {
        title: typeof config.title === "string" ? config.title : "",
        feeds,
        mapStyle: parseMapStyle(config.map_style),
        mapHeight: parseMapHeight(config.map_height),
        legend: config.legend !== false,
    };
}

function parseFeed(options: Record<string, unknown>): FeedOptions {
    const entity = typeof options.entity === "string" ? options.entity.trim() : "";
    if (!ENTITY_ID.test(entity)) {
        throw new Error(`entities: "${String(options.entity ?? "")}" isn't an entity id such as sensor.ships_near_the_cabin`);
    }
    return {
        entity,
        colorBy: parseColorBy(options.color_by),
        delayThresholds: parseDelayThresholds(options.late_minutes, options.very_late_minutes),
        maxAgeMinutes: parseMaxAge(options.max_age_minutes),
        showArea: options.show_area === true,
        areaColor: parseAreaColor(options.area_color),
    };
}

function parseMapStyle(value: unknown): MapStyle {
    if (value === undefined) return "default";
    if ((MAP_STYLES as readonly unknown[]).includes(value)) return value as MapStyle;
    throw new Error(`map_style must be one of ${MAP_STYLES.join(", ")}`);
}

function parseMapHeight(value: unknown): number {
    if (value === undefined) return DEFAULT_MAP_HEIGHT;
    const height = number(value);
    if (height !== null && height >= 100) return height;
    throw new Error("map_height must be a number of pixels, at least 100");
}

function parseColorBy(value: unknown): ColorBy {
    if (value === undefined) return "kind";
    if ((COLOR_BY as readonly unknown[]).includes(value)) return value as ColorBy;
    throw new Error(`color_by must be ${COLOR_BY.join(" or ")}`);
}

function parseDelayThresholds(lateValue: unknown, veryLateValue: unknown): [number, number] {
    const late = lateValue === undefined ? DEFAULT_DELAY_THRESHOLDS[0] : number(lateValue);
    const veryLate = veryLateValue === undefined ? DEFAULT_DELAY_THRESHOLDS[1] : number(veryLateValue);
    if (late !== null && veryLate !== null && late >= 0 && late < veryLate) return [late, veryLate];
    throw new Error("late_minutes and very_late_minutes must be minutes, late_minutes the smaller, e.g. 3 and 10");
}

function parseMaxAge(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    const minutes = number(value);
    if (minutes !== null && minutes > 0) return minutes;
    throw new Error("max_age_minutes must be a number of minutes greater than 0");
}

/** Hex only: the colour is drawn by MapLibre, which can't read CSS variables. */
function parseAreaColor(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())) return value.trim();
    throw new Error("area_color must be a hex colour such as #ff6f00");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
