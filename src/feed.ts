/**
 * Reading a map feed entity (docs/map-feed-format.md) into what the card draws.
 *
 * Feeds can come from any integration or template, so every value is checked. Invalid features are skipped and
 * invalid values are ignored; a bad item never breaks the whole map.
 */
import type { HassEntity } from "./hass";

/** The only feed version this card understands. */
export const SUPPORTED_FEED_VERSION = 1;

/** The faintest an item is drawn, whatever its feed asks for. */
export const MIN_OPACITY = 0.3;

/** A popup with more pictures than this gets too long to use. */
const MAX_IMAGES = 6;

export type FeedArea =
    | { type: "circle"; lat: number; lon: number; radiusKm: number }
    | { type: "bbox"; south: number; west: number; north: number; east: number };

export type TagTone = "warning" | "info" | "neutral" | "item";

export interface RowTag {
    text: string;
    tone: TagTone;
}

export interface DetailRow {
    label: string;
    value: string;
    /** '' when there is none. */
    unit: string;
    /** A small picture before the label, shown large when tapped. */
    image?: FeedImage;
    tag?: RowTag;
}

/** An action that returns more detail rows: {"details": [rows]}. */
export interface DetailAction {
    domain: string;
    service: string;
    data: Record<string, unknown>;
}

export interface FeedImage {
    /** Always an https URL. */
    url: string;
    caption: string;
    /** When the picture was taken, in milliseconds since the epoch. */
    takenMs: number | null;
}

export interface FeedLink {
    /** Always an https URL. */
    url: string;
    label: string;
}

export interface LegendEntry {
    color: string;
    label: string;
}

/** What a feed is about, as the format's kind families; the editor offers only the options that make sense for it. */
export const FEED_TYPES = ["ship", "train", "transit", "road", "nature", "other"] as const;
export type FeedType = (typeof FEED_TYPES)[number];

/** An order the feed offers for the card's list. */
export interface SortKey {
    key: string;
    label: string;
    property: string;
    descending: boolean;
}

export interface FeedList {
    sort: SortKey[];
    /** The key the list starts in; null when the feed has no sort keys. */
    defaultKey: string | null;
    /** What the feed calls its items, or '' for the card's own word. */
    count: string;
}

/** The parts of an item's row in the list that the feed gives; null leaves the card's own. */
export interface ListRow {
    title: string | null;
    text: string | null;
    value: string | null;
}

/** A value to sort by: a number, a time as milliseconds, or text. */
export type SortValue = number | string;

/**
 * What points and shapes have in common: everything their details show.
 * Optional values are null, '' or [] when the feed leaves them out.
 */
export interface FeedItem {
    id: string;
    name: string;
    kind: string;
    updatedMs: number | null;
    subtitle: string;
    /** A validated CSS hex colour. */
    color: string | null;
    details: DetailRow[];
    notices: string[];
    footer: string;
    images: FeedImage[];
    link: FeedLink | null;
    /** How strongly the item is drawn, MIN_OPACITY–1; 1 when the feed leaves it out. */
    opacity: number;
    listRow: ListRow;
    /** The values of the properties the feed's sort keys name, by property. */
    sortValues: Record<string, SortValue>;
}

/** [longitude, latitude], as GeoJSON and MapLibre have it. */
export type LngLat = [number, number];

export interface FeedPoint extends FeedItem {
    lon: number;
    lat: number;
    /** Degrees 0–360 clockwise from north. */
    heading: number | null;
    stationary: boolean;
    speedKmh: number | null;
    delayMinutes: number | null;
    cancelled: boolean;
    badge: string;
    label: string;
    detailAction: DetailAction | null;
}

export type ShapeGeometry = { type: "line"; paths: LngLat[][] } | { type: "polygon"; polygons: LngLat[][][] };

/** A line or polygon: a road work, a maintenance route, a road section, an area. */
export interface FeedShape extends FeedItem {
    geometry: ShapeGeometry;
    /** Id of the Point feature the shape belongs to, or ''. Tapping the shape selects that point. */
    pointId: string;
}

export interface Feed {
    /** null when the feed doesn't say, or says something the card doesn't know. */
    type: FeedType | null;
    attribution: string;
    area: FeedArea | null;
    legend: LegendEntry[];
    list: FeedList;
    points: FeedPoint[];
    shapes: FeedShape[];
    /** Features that were left out because they were invalid. */
    skipped: number;
}

export type FeedResult =
    | { status: "ok"; feed: Feed }
    /** The entity doesn't exist. */
    | { status: "missing" }
    /** The entity is unavailable or unknown, e.g. its source failed to fetch. */
    | { status: "unavailable" }
    /** The entity has no map_feed_version attribute. */
    | { status: "not_a_feed" }
    | { status: "unsupported_version"; version: unknown };

const UNAVAILABLE_STATES = new Set(["unavailable", "unknown"]);

/** Only hex colours are accepted: a colour ends up in an inline style. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const ACTION_NAME = /^([a-z0-9_]+)\.([a-z0-9_]+)$/;

const TONES: readonly TagTone[] = ["warning", "info", "neutral", "item"];

export function isMapFeed(entity: HassEntity | undefined): boolean {
    return entity?.attributes?.map_feed_version !== undefined;
}

export function readFeed(state: HassEntity | undefined): FeedResult {
    if (!state) return { status: "missing" };
    if (UNAVAILABLE_STATES.has(state.state)) return { status: "unavailable" };

    const attributes = isRecord(state.attributes) ? state.attributes : {};
    const version = attributes.map_feed_version;
    if (version === undefined) return { status: "not_a_feed" };
    // A template may write the version as text, as with the GeoJSON.
    if (number(version) !== SUPPORTED_FEED_VERSION) return { status: "unsupported_version", version };

    const list = readList(attributes.list);
    const sortProperties = [...new Set(list.sort.map((key) => key.property))];
    const feed: Feed = {
        type: (FEED_TYPES as readonly unknown[]).includes(attributes.feed_type) ? (attributes.feed_type as FeedType) : null,
        attribution: text(attributes.attribution),
        area: readArea(attributes.area),
        legend: readLegend(attributes.legend),
        list,
        points: [],
        shapes: [],
        skipped: 0,
    };

    featuresOf(attributes.geojson).forEach((feature, index) => {
        const geometry = isRecord(feature) && isRecord(feature.geometry) ? feature.geometry : null;
        if (!isRecord(feature) || !geometry) {
            feed.skipped += 1;
            return;
        }
        if (geometry.type === "Point") {
            const point = readPoint(feature, geometry, sortProperties);
            if (point) feed.points.push(point);
            else feed.skipped += 1;
        } else {
            const shape = readShape(feature, geometry, index, sortProperties);
            if (shape) feed.shapes.push(shape);
            else feed.skipped += 1;
        }
    });

    return { status: "ok", feed };
}

/** Detail rows, from a feature's `details` or a detail action's response. */
export function readDetailRows(value: unknown): DetailRow[] {
    if (!Array.isArray(value)) return [];
    const rows: DetailRow[] = [];
    for (const item of value) {
        if (!isRecord(item)) continue;
        const label = text(item.label);
        const rowValue = text(item.value);
        if (!label || !rowValue) continue;
        const row: DetailRow = { label, value: rowValue, unit: text(item.unit) };
        const image = readImage(item.image);
        if (image) row.image = image;
        const tag = readTag(item.tag);
        if (tag) row.tag = tag;
        rows.push(row);
    }
    return rows;
}

/* ---------------- features ---------------- */

/** The features of a FeatureCollection. A JSON string is accepted too, as templates sometimes produce one. */
function featuresOf(value: unknown): unknown[] {
    let collection = value;
    if (typeof collection === "string") {
        try {
            collection = JSON.parse(collection);
        } catch {
            return [];
        }
    }
    return isRecord(collection) && Array.isArray(collection.features) ? collection.features : [];
}

/** The properties every feature can have, points and shapes alike. */
function readItem(id: string, props: Record<string, unknown>, fallbackName: string, sortProperties: string[]): FeedItem {
    return {
        id,
        name: text(props.name) || fallbackName,
        kind: text(props.kind) || "other",
        updatedMs: time(props.updated),
        subtitle: text(props.subtitle),
        color: color(props.color),
        details: readDetailRows(props.details),
        notices: Array.isArray(props.notices) ? props.notices.map((notice) => text(notice)).filter(Boolean) : [],
        footer: text(props.footer),
        images: readImages(props.images),
        link: readLink(props.link),
        opacity: readOpacity(props.opacity),
        listRow: readListRow(props.list),
        sortValues: readSortValues(props, sortProperties),
    };
}

function readPoint(feature: Record<string, unknown>, geometry: Record<string, unknown>, sortProperties: string[]): FeedPoint | null {
    const id = identifier(feature.id);
    const position = readPosition(geometry.coordinates);
    if (!id || !position) return null;

    const props = propertiesOf(feature);
    const heading = number(props.heading);
    return {
        ...readItem(id, props, id, sortProperties),
        lon: position[0],
        lat: position[1],
        heading: heading === null ? null : ((heading % 360) + 360) % 360,
        stationary: props.stationary === true,
        speedKmh: number(props.speed_kmh),
        delayMinutes: number(props.delay_minutes),
        cancelled: props.cancelled === true,
        badge: text(props.badge),
        label: text(props.label),
        detailAction: readDetailAction(props.detail_action),
    };
}

function readShape(
    feature: Record<string, unknown>,
    geometry: Record<string, unknown>,
    index: number,
    sortProperties: string[],
): FeedShape | null {
    const shapeGeometry = readShapeGeometry(geometry);
    if (!shapeGeometry) return null;
    const props = propertiesOf(feature);
    return {
        ...readItem(identifier(feature.id) || `shape:${index}`, props, "", sortProperties),
        geometry: shapeGeometry,
        pointId: identifier(props.point),
    };
}

function readShapeGeometry(geometry: Record<string, unknown>): ShapeGeometry | null {
    const coordinates = geometry.coordinates;
    switch (geometry.type) {
        case "LineString":
            return lineGeometry([readPath(coordinates)]);
        case "MultiLineString":
            return lineGeometry(Array.isArray(coordinates) ? coordinates.map(readPath) : []);
        case "Polygon":
            return polygonGeometry([readRings(coordinates)]);
        case "MultiPolygon":
            return polygonGeometry(Array.isArray(coordinates) ? coordinates.map(readRings) : []);
        default:
            return null;
    }
}

function lineGeometry(paths: LngLat[][]): ShapeGeometry | null {
    const valid = paths.filter((path) => path.length >= 2);
    return valid.length > 0 ? { type: "line", paths: valid } : null;
}

function polygonGeometry(polygons: LngLat[][][]): ShapeGeometry | null {
    const valid = polygons.filter((rings) => rings.length > 0);
    return valid.length > 0 ? { type: "polygon", polygons: valid } : null;
}

function readRings(value: unknown): LngLat[][] {
    return Array.isArray(value) ? value.map(readPath).filter((ring) => ring.length >= 3) : [];
}

function readImages(value: unknown): FeedImage[] {
    if (!Array.isArray(value)) return [];
    const images: FeedImage[] = [];
    for (const item of value) {
        if (images.length === MAX_IMAGES) break;
        const image = readImage(item);
        if (image) images.push(image);
    }
    return images;
}

/** Only https URLs are accepted: the URL ends up in an img tag. */
function readImage(item: unknown): FeedImage | null {
    if (!isRecord(item) || typeof item.url !== "string" || !isHttpsUrl(item.url)) return null;
    return { url: item.url, caption: text(item.caption), takenMs: time(item.time) };
}

/** Only https URLs are accepted: the URL ends up in a link. Without a label, the link shows the site's name. */
function readLink(value: unknown): FeedLink | null {
    if (!isRecord(value) || typeof value.url !== "string" || !isHttpsUrl(value.url)) return null;
    return { url: value.url, label: text(value.label) || new URL(value.url).hostname };
}

function readTag(value: unknown): RowTag | null {
    if (!isRecord(value)) return null;
    const tagText = text(value.text);
    if (!tagText) return null;
    const tone = (TONES as readonly unknown[]).includes(value.tone) ? (value.tone as TagTone) : "neutral";
    return { text: tagText, tone };
}

function readLegend(value: unknown): LegendEntry[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const entryColor = color(entry.color);
        const label = text(entry.label);
        return entryColor && label ? [{ color: entryColor, label }] : [];
    });
}

function readList(value: unknown): FeedList {
    const list: FeedList = { sort: [], defaultKey: null, count: "" };
    if (!isRecord(value)) return list;
    const seen = new Set<string>();
    for (const entry of Array.isArray(value.sort) ? value.sort : []) {
        if (!isRecord(entry)) continue;
        const key = text(entry.key);
        const label = text(entry.label);
        const property = text(entry.property);
        if (!key || !label || !property || seen.has(key)) continue;
        seen.add(key);
        list.sort.push({ key, label, property, descending: entry.order === "desc" });
    }
    const defaultKey = text(value.default);
    list.defaultKey = seen.has(defaultKey) ? defaultKey : (list.sort[0]?.key ?? null);
    list.count = text(value.count);
    return list;
}

function readListRow(value: unknown): ListRow {
    if (!isRecord(value)) return { title: null, text: null, value: null };
    const part = (part: unknown): string | null => (typeof part === "string" || typeof part === "number" ? text(part) : null);
    return { title: part(value.title) || null, text: part(value.text), value: part(value.value) };
}

/** A date-time as ISO 8601 writes it; anything else that Date.parse would accept is left as text. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;

function readSortValues(props: Record<string, unknown>, properties: string[]): Record<string, SortValue> {
    const values: Record<string, SortValue> = {};
    for (const property of properties) {
        // Only the feature's own properties, never what an object answers from its prototype.
        if (!Object.hasOwn(props, property)) continue;
        const value = props[property];
        if (typeof value === "number") {
            if (Number.isFinite(value)) values[property] = value;
        } else if (typeof value === "string" && value !== "") {
            const parsed = ISO_TIME.test(value) ? time(value) : null;
            values[property] = parsed ?? value;
        } else if (typeof value === "boolean") {
            values[property] = value ? 1 : 0;
        }
    }
    return values;
}

/** Anything fainter would be hard to find, and nothing on the map should be impossible to tap. */
function readOpacity(value: unknown): number {
    const opacity = number(value);
    return opacity === null ? 1 : Math.min(1, Math.max(MIN_OPACITY, opacity));
}

function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

function readPosition(value: unknown): LngLat | null {
    if (!Array.isArray(value) || value.length < 2) return null;
    const [lon, lat] = value;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return [lon, lat];
}

function readPath(value: unknown): LngLat[] {
    if (!Array.isArray(value)) return [];
    return value.map(readPosition).filter((position): position is LngLat => position !== null);
}

function readDetailAction(value: unknown): DetailAction | null {
    if (!isRecord(value) || typeof value.action !== "string") return null;
    const match = ACTION_NAME.exec(value.action);
    if (!match) return null;
    return { domain: match[1]!, service: match[2]!, data: isRecord(value.data) ? value.data : {} };
}

/** Note that `area` is latitude first, like the rest of Home Assistant. */
function readArea(value: unknown): FeedArea | null {
    if (!isRecord(value)) return null;
    if (Array.isArray(value.bbox)) {
        const [south, west, north, east] = value.bbox.map(number);
        if (south != null && west != null && north != null && east != null && south < north && west < east) {
            return { type: "bbox", south, west, north, east };
        }
        return null;
    }
    const center = Array.isArray(value.center) ? value.center.map(number) : [];
    const radiusKm = number(value.radius_km);
    const [lat, lon] = center;
    if (lat != null && lon != null && radiusKm !== null && radiusKm > 0) {
        return { type: "circle", lat, lon, radiusKm };
    }
    return null;
}

/* ---------------- kinds ---------------- */

export type KindFamily = "ship" | "train" | "transit" | "road" | "other";

const TRANSIT_KINDS: ReadonlySet<string> = new Set(["bus", "tram", "metro", "ferry"]);

/** Road events drawn as a warning sign. */
const WARNING_KINDS: ReadonlySet<string> = new Set([
    "road.roadwork",
    "road.announcement",
    "road.accident",
    "road.weight_restriction",
    "road.exempted_transport",
]);

/** "ship.cargo" → ship, "train.commuter" → train, "bus" → transit. An unknown "ship.x" still belongs to ships. */
export function kindFamily(kind: string): KindFamily {
    const prefix = kind.split(".", 1)[0];
    if (prefix === "ship") return "ship";
    if (prefix === "train") return "train";
    if (prefix === "road") return "road";
    if (TRANSIT_KINDS.has(kind)) return "transit";
    return "other";
}

/**
 * Things that move. Their details show how old the position is; for everything else (a road work, a weather
 * station) they show when the item was updated.
 */
export function isMoving(kind: string): boolean {
    const family = kindFamily(kind);
    return family === "ship" || family === "train" || family === "transit" || kind === "road.maintenance";
}

export type MarkerSymbol = "warning" | "camera" | "bird" | null;

/** A symbol for the marker, for kinds that have one. Others get an arrow or a dot. */
export function markerSymbol(kind: string): MarkerSymbol {
    if (WARNING_KINDS.has(kind)) return "warning";
    if (kind === "road.camera") return "camera";
    if (kind === "bird") return "bird";
    return null;
}

/* ---------------- geometry ---------------- */

const EARTH_RADIUS_KM = 6371;

/** The outline of a feed's area, a circle as a 64-sided polygon. */
export function areaOutline(area: FeedArea): LngLat[] {
    if (area.type === "bbox") {
        const { south, west, north, east } = area;
        return [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
        ];
    }
    const lat = (area.lat * Math.PI) / 180;
    const angular = area.radiusKm / EARTH_RADIUS_KM;
    return Array.from({ length: 65 }, (_, step) => {
        const bearing = (step / 64) * 2 * Math.PI;
        const pointLat = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing));
        const pointLon =
            (area.lon * Math.PI) / 180 +
            Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(pointLat));
        return [(pointLon * 180) / Math.PI, (pointLat * 180) / Math.PI] as LngLat;
    });
}

/** The bounds of every position given, or null when there are none. */
export function boundsOf(positions: LngLat[]): [LngLat, LngLat] | null {
    if (positions.length === 0) return null;
    const lons = positions.map(([lon]) => lon);
    const lats = positions.map(([, lat]) => lat);
    return [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
    ];
}

/* ---------------- values ---------------- */

function propertiesOf(feature: Record<string, unknown>): Record<string, unknown> {
    return isRecord(feature.properties) ? feature.properties : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function color(value: unknown): string | null {
    return typeof value === "string" && HEX_COLOR.test(value) ? value : null;
}

/** Strings as they are, numbers as text, anything else ''. */
function text(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
}

/** Finite numbers, and strings that are numbers (templates sometimes produce those). */
export function number(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** An ISO 8601 time as milliseconds since the epoch. */
function time(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function identifier(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
}
