/**
 * The card's configuration (README.md#options), checked when it is set. A value that can't be used throws, so
 * Home Assistant shows what is wrong in place of the card instead of a map quietly drawn some other way.
 */
import { number } from "./feed";

export const MAP_STYLES = ["default", "colorful", "natural", "muted", "gray", "toner"] as const;
export type MapStyle = (typeof MAP_STYLES)[number];

export type ColorBy = "kind" | "delay";
const COLOR_BY: readonly ColorBy[] = ["kind", "delay"];

/** What frames the map when the card opens: the feed's area, its items, or nothing of this feed. */
export const FRAMES = ["area", "items", "off"] as const;
export type Frame = (typeof FRAMES)[number];

export const DEFAULT_DELAY_THRESHOLDS: [number, number] = [3, 10];
export const DEFAULT_MAP_HEIGHT = 300;
export const DEFAULT_LIST_HEIGHT = 450;
export const MAX_START_ZOOM = 18;

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
    /** Draw each marker's label or name beside it. */
    labels: boolean;
    /** Move markers between updates instead of jumping (glide.ts). */
    glide: boolean;
    /** The map opens framed to this feed, with the others that are. */
    frame: Frame;
    /** Whether the feed's items are rows in the card's list, or only on the map. */
    inList: boolean;
}

/** Where a map is, as [longitude, latitude] and MapLibre's zoom. */
export interface MapView {
    center: [number, number];
    zoom: number;
}

export interface CardOptions {
    title: string;
    feeds: FeedOptions[];
    mapStyle: MapStyle;
    mapHeight: number;
    legend: boolean;
    list: boolean;
    /** The list's height below the map; beside it, the list is as tall as the map. */
    listHeight: number;
    /** The sort key the list starts in; null = the first feed's default. */
    sort: string | null;
    /** The view the map opens in when no feed frames it; null = Home Assistant's home. */
    start: MapView | null;
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
        mapHeight: parseHeight(config.map_height, DEFAULT_MAP_HEIGHT, "map_height"),
        legend: config.legend !== false,
        list: config.list === true,
        listHeight: parseHeight(config.list_height, DEFAULT_LIST_HEIGHT, "list_height"),
        sort: typeof config.sort === "string" && config.sort.trim() ? config.sort.trim() : null,
        start: parseStart(config.latitude, config.longitude, config.zoom),
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
        labels: options.labels === true,
        glide: options.glide === true,
        frame: parseFrame(options.frame),
        inList: options.in_list !== false,
    };
}

/** All three or no view: one or two of them are an editor's form half filled in, and are left unused. */
function parseStart(latitudeValue: unknown, longitudeValue: unknown, zoomValue: unknown): MapView | null {
    const set = (value: unknown) => value !== undefined && value !== null && value !== "";
    if (![latitudeValue, longitudeValue, zoomValue].every(set)) return null;
    const [latitude, longitude, zoom] = [number(latitudeValue), number(longitudeValue), number(zoomValue)];
    if (latitude === null || Math.abs(latitude) > 90) throw new Error("latitude must be a number from -90 to 90");
    if (longitude === null || Math.abs(longitude) > 180) throw new Error("longitude must be a number from -180 to 180");
    if (zoom === null || zoom < 0 || zoom > MAX_START_ZOOM) throw new Error(`zoom must be a number from 0 to ${MAX_START_ZOOM}`);
    return { center: [longitude, latitude], zoom };
}

function parseMapStyle(value: unknown): MapStyle {
    if (value === undefined) return "default";
    if ((MAP_STYLES as readonly unknown[]).includes(value)) return value as MapStyle;
    throw new Error(`map_style must be one of ${MAP_STYLES.join(", ")}`);
}

/** `true` and `false` are what the option took before it had a third value. */
export function parseFrame(value: unknown): Frame {
    if (value === undefined || value === true) return "area";
    if (value === false) return "off";
    if ((FRAMES as readonly unknown[]).includes(value)) return value as Frame;
    throw new Error(`frame must be one of ${FRAMES.join(", ")}`);
}

function parseHeight(value: unknown, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const height = number(value);
    if (height !== null && height >= 100) return height;
    throw new Error(`${name} must be a number of pixels, at least 100`);
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
