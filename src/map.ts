/**
 * The map: MapLibre on Home Assistant's base map (map-tiles.ts), with the feeds' points as HTML markers and their
 * lines, polygons and areas as layers of their own on top.
 */
import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { FilterSpecification, GeoJSONSource, MapLayerMouseEvent, StyleSpecification } from "maplibre-gl";
// The worker is carried as text and started from a blob, so the card stays one file, as HACS installs it.
import workerSource from "maplibre-gl/dist/maplibre-gl-worker.mjs?raw";

import { areaOutline, type FeedArea, type FeedPoint, type FeedShape, type LngLat } from "./feed";
import { linePieces } from "./blend";
import { cutTrail, nextGlide, positionAt, type Glide, type Report } from "./glide";
import { loadStyle, MapError, onTokenChange, refreshToken, transformRequest } from "./map-tiles";
import type { MapStyle, MapView } from "./options";
import { escapeHtml, markerHtml, textOn } from "./style";

/** A point as the card wants it drawn. `key` is unique across the card's feeds. */
export interface DrawnPoint {
    key: string;
    point: FeedPoint;
    color: string;
    /** Text beside the marker, or '' for none. */
    label?: string;
    /** Moves between reports instead of jumping (glide.ts). */
    glide?: boolean;
    /** When the position was reported: its own time, or when its feed last changed. Null when neither is known. */
    reportedMs?: number | null;
}

export interface DrawnShape {
    key: string;
    /** The point a tap on the shape selects, or the shape's own key. */
    selects: string;
    shape: FeedShape;
    color: string;
    /** Shown on hover: the shape's own name, or its point's. */
    name: string;
}

export interface DrawnArea {
    area: FeedArea;
    color: string;
}

export interface MapContent {
    points: DrawnPoint[];
    shapes: DrawnShape[];
    areas: DrawnArea[];
    attributions: string[];
    selected: string | null;
}

interface MarkerEntry {
    marker: Marker;
    element: HTMLElement;
    html: string;
    shape: string;
    /** Where the marker is drawn. */
    position: LngLat;
    report: Report | null;
    glide: Glide | null;
    /** Where the marker was when its trail was last drawn. */
    trailDrawnAt: LngLat | null;
}

/** A marker closer to the map's edge than this is moved into view when selected: half of a badge, and some air. */
const REVEAL_MARGIN_PX = 32;

/** A selected line or area drawn smaller than this is too small to make out, and is brought to the middle of the map. */
const SMALL_SHAPE_PX = 40;

/** Not much point in zooming a single item in to its doorstep. */
const FIT_MAX_ZOOM = 13;
/** Framed by its items, a lone item keeps enough around it to show where it is: a shoreline, a village. */
const ITEMS_FIT_MAX_ZOOM = 12;

/** Room around a fit, and around whatever covers the map's top or bottom: half a marker's badge, and some air. */
const FIT_PADDING_PX = 40;
const FIT_CLEARANCE_PX = 24;

/** How far, in pixels, something drawn over the map reaches into it from its top and its bottom. */
export interface Covered {
    top: number;
    bottom: number;
}

/** A fit's padding, so the items at its edges stay clear of a legend over the map's top and a note over its bottom. */
export function fitPadding({ top, bottom }: Covered): { top: number; bottom: number; left: number; right: number } {
    const clear = (covered: number) => Math.max(FIT_PADDING_PX, covered > 0 ? covered + FIT_CLEARANCE_PX : 0);
    return { top: clear(top), bottom: clear(bottom), left: FIT_PADDING_PX, right: FIT_PADDING_PX };
}

/** A gliding marker's trail is drawn again once its end has moved this far, not on every frame. */
const TRAIL_STEP_PX = 1;

/** After a refused tile, how long before another refusal may ask for a new token again. */
const RECOVERY_THROTTLE_MS = 30_000;

const SHAPES = "feed-shapes";
const AREAS = "feed-areas";
/** The layers a tap can hit, polygons below lines. */
const TAP_LAYERS = ["feed-dashed-fill", "feed-dashed", "feed-fill", "feed-line"];

let workerReady = false;

function ensureWorker(): void {
    if (workerReady) return;
    workerReady = true;
    setWorkerUrl(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
}

export class FeedMap {
    private map?: MapLibreMap;
    private readonly markers = new Map<string, MarkerEntry>();
    private content: MapContent = { points: [], shapes: [], areas: [], attributions: [], selected: null };
    private attribution?: AttributionControl;
    private attributionText = "";
    private style: MapStyle;
    private dark: boolean;
    /** The theme's map colours (map-theme.ts), or null for none. */
    private theme: Record<string, string> | null;
    /** Counts the style requests, so only the newest one is drawn. */
    private styleRequest = 0;
    /** Set when the newest style couldn't be loaded, so the same one is asked for again. */
    private styleFailed = false;
    private refused = false;
    private lastRecovery = 0;
    private unsubscribe?: () => void;
    private destroyed = false;
    /** What the map was last fitted to, fitted again when its size changes until someone moves it. */
    private fittedTo: [LngLat, LngLat] | null = null;
    private fittedByItems = false;
    private fittedCovered: () => Covered = () => ({ top: 0, bottom: 0 });
    private movedSinceFit = false;
    /** Set when someone moves the map, so it no longer moves by itself to show the selected item until the next tap. */
    private movedByHand = false;
    private frame?: number;
    private resizer?: ResizeObserver;
    /** The points whose lines are trails cut at their gliding marker, by key. */
    private trailOwners = new Set<string>();

    constructor(
        private readonly container: HTMLElement,
        style: MapStyle,
        dark: boolean,
        theme: Record<string, string> | null,
        private readonly onSelect: (key: string | null) => void,
        /** MapLibre's UI strings by its own IDs, read once when the map is made. */
        private readonly locale: Record<string, string>,
        /** Where the map is until something frames it. */
        private readonly start: MapView | null = null,
    ) {
        this.style = style;
        this.dark = dark;
        this.theme = theme;
    }

    /** Throws when the map can't be drawn: no WebGL, or no tiles from Home Assistant. */
    async init(): Promise<void> {
        if (!document.createElement("canvas").getContext("webgl2")) {
            throw new MapError("webgl", "WebGL 2 is not available");
        }
        ensureWorker();
        const style = await loadStyle(this.style, this.dark, this.theme);
        if (this.destroyed) return;

        const map = new MapLibreMap({
            container: this.container,
            style,
            center: this.start?.center ?? [0, 0],
            zoom: this.start?.zoom ?? 1,
            attributionControl: false,
            // The wheel and a one-finger drag scroll the page, so the map doesn't trap it. Ctrl and two fingers move the map.
            cooperativeGestures: true,
            locale: this.locale,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            transformRequest: (url) => transformRequest(url),
            // The map follows its container's size itself, so a change the card doesn't see, such as the map moving
            // beside the list when the card is laid out wide, fits it again too.
            trackResize: false,
        });
        this.map = map;
        this.resizer = new ResizeObserver(() => this.resize());
        this.resizer.observe(this.container);
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        map.addControl(new NavigationControl({ showCompass: false }), "top-right");

        // A refused TileJSON isn't asked for again, so the style is set again once there is a new token. 403 is an old
        // token, 404 a proxy not registered yet after a restart, and no status a network error.
        map.on("error", (event) => {
            const status = (event.error as { status?: number } | undefined)?.status;
            if (status !== undefined && status !== 403 && status !== 404) return;
            if (Date.now() - this.lastRecovery < RECOVERY_THROTTLE_MS) return;
            this.lastRecovery = Date.now();
            this.refused = true;
            void refreshToken();
        });
        this.unsubscribe = onTokenChange(() => {
            if (!this.refused) return;
            this.refused = false;
            void this.setStyle(this.style, this.dark, this.theme, true);
        });

        // A new style drops every source and layer, so they are added again whenever one has loaded.
        map.on("style.load", () => this.addLayers());
        map.on("click", (event) => this.click(event));
        // Only a move someone makes has the event that caused it; the card's own fits and pans don't.
        map.on("movestart", (event) => {
            if (!event.originalEvent) return;
            this.movedSinceFit = true;
            this.movedByHand = true;
        });
        // Marks the map drawn, for whatever waits for it, such as the README's screenshots; MapLibre says so only in an event.
        map.on("idle", () => (this.container.dataset.mapReady = ""));
        // A line's or an area's name follows the pointer; touch has no hover, and a tap shows the details anyway.
        const tooltip = new Popup({ closeButton: false, closeOnClick: false, className: "feed-tooltip", offset: 12 });
        for (const layer of TAP_LAYERS) {
            map.on("mousemove", layer, (event) => {
                const name = event.features?.[0]?.properties?.name;
                if (typeof name === "string" && name) tooltip.setLngLat(event.lngLat).setText(name).addTo(map);
            });
            map.on("mouseleave", layer, () => tooltip.remove());
            map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
            map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
        }

        await new Promise<void>((resolve) => (map.isStyleLoaded() ? resolve() : map.once("style.load", () => resolve())));
    }

    async setStyle(style: MapStyle, dark: boolean, theme: Record<string, string> | null, force = false): Promise<void> {
        const same =
            !this.styleFailed && style === this.style && dark === this.dark && JSON.stringify(theme) === JSON.stringify(this.theme);
        if (!this.map || (!force && same)) return;
        delete this.container.dataset.mapReady;
        this.style = style;
        this.dark = dark;
        this.theme = theme;
        const request = ++this.styleRequest;
        // A request on its way counts as the style asked for, so updates while it loads don't start more.
        this.styleFailed = false;
        let loaded: StyleSpecification;
        try {
            loaded = await loadStyle(style, dark, theme);
        } catch (error) {
            // The map keeps the style it has, and the next update asks for this one again.
            if (request === this.styleRequest) {
                this.styleFailed = true;
                this.container.dataset.mapReady = "";
            }
            console.warn(`map-feed-card: the ${style} map style couldn't be loaded`, error);
            return;
        }
        // Only the newest request is drawn, when several were made while styles were loading.
        if (this.destroyed || request !== this.styleRequest) return;
        this.styleFailed = false;
        this.map.setStyle(loaded, { diff: false });
    }

    update(content: MapContent): void {
        this.content = content;
        if (!this.map) return;
        this.trailOwners = new Set(content.shapes.filter(({ shape }) => shape.geometry.type === "line").map(({ selects }) => selects));
        this.updateMarkers();
        this.updateLayers();
        this.updateAttribution();
    }

    /** Where the map is now, rounded to what a configuration needs: about ten metres, and a tenth of a zoom level. */
    get view(): MapView | null {
        if (!this.map) return null;
        const { lng, lat } = this.map.getCenter();
        return { center: [Math.round(lng * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4], zoom: Math.round(this.map.getZoom() * 10) / 10 };
    }

    /** Puts the map where it starts, when nothing frames it. */
    show(view: MapView): void {
        this.map?.jumpTo(view);
    }

    /** Whether the map has been moved since it was last fitted, by someone or to reveal a selected item. */
    get moved(): boolean {
        return this.movedSinceFit;
    }

    /**
     * Shows everything in `bounds`, as [[west, south], [east, north]]; `byItems` when they are a feed's items, not an
     * area. `covered` is asked again on every fit, as a new size can wrap the legend onto more lines.
     */
    fit(bounds: [LngLat, LngLat], byItems = false, covered: () => Covered = () => ({ top: 0, bottom: 0 })): void {
        this.fittedTo = bounds;
        this.fittedByItems = byItems;
        this.fittedCovered = covered;
        this.movedSinceFit = false;
        const maxZoom = byItems ? ITEMS_FIT_MAX_ZOOM : FIT_MAX_ZOOM;
        this.map?.fitBounds(bounds, { padding: fitPadding(covered()), maxZoom, animate: false });
    }

    /** An item was tapped: it is shown again, wherever the map had been moved to before. */
    tapped(): void {
        this.movedByHand = false;
    }

    /**
     * Moves the selected item into view when it isn't, or is so near the edge that its marker is cut off, unless someone
     * has moved the map since the item was tapped. `covered` is how much of the map's bottom the details' sheet covers,
     * so the item is shown in the part left clear.
     */
    reveal(position: LngLat, covered = 0): void {
        const map = this.map;
        if (!map || this.movedByHand) return;
        const { x, y } = map.project(position);
        const { clientWidth: width, clientHeight: height } = map.getContainer();
        const margin = REVEAL_MARGIN_PX;
        if (x < margin || y < margin || x > width - margin || y > height - covered - margin) {
            this.movedSinceFit = true;
            map.easeTo({ center: position, offset: [0, -covered / 2] });
        }
    }

    /**
     * Moves the map to the selected line or area, as its bounds, unless someone has moved the map since it was tapped:
     * when it is out of view, and when it is drawn too small to make out, so that the middle of the map says where it is.
     * The zoom stays as it is.
     */
    revealShape(bounds: [LngLat, LngLat], covered = 0): void {
        const map = this.map;
        if (!map || this.movedByHand) return;
        const [a, b] = [map.project(bounds[0]), map.project(bounds[1])];
        const { clientWidth: width, clientHeight: height } = map.getContainer();
        const [x, y] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        const small = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) < SMALL_SHAPE_PX;
        if (small || x < 0 || y < 0 || x > width || y > height - covered) {
            this.movedSinceFit = true;
            map.easeTo({ center: [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2], offset: [0, -covered / 2] });
        }
    }

    /** Lays the map out for its new size, and frames it again when it was framed and hasn't been moved since. */
    resize(): void {
        if (!this.map) return;
        // A new size clears the canvas until the next frame, so the map isn't drawn until MapLibre is idle again.
        delete this.container.dataset.mapReady;
        this.map.resize();
        // A dashboard lays its columns out after the card has started, so the first fit can be for another width.
        if (this.fittedTo && !this.movedSinceFit) this.fit(this.fittedTo, this.fittedByItems, this.fittedCovered);
    }

    destroy(): void {
        this.destroyed = true;
        this.resizer?.disconnect();
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.unsubscribe?.();
        this.map?.remove();
        this.map = undefined;
        this.markers.clear();
    }

    /* ---------------- markers ---------------- */

    private updateMarkers(): void {
        const seen = new Set<string>();
        for (const drawn of this.content.points) {
            seen.add(drawn.key);
            const marker = markerHtml(drawn.point);
            const { shape } = marker;
            const html = drawn.label ? `${marker.html}<span class="marker-label">${escapeHtml(drawn.label)}</span>` : marker.html;
            const selected = drawn.key === this.content.selected;
            const existing = this.markers.get(drawn.key);
            const entry = existing ?? this.createMarker(drawn.key);
            if (entry.html !== html) {
                entry.element.innerHTML = html;
                entry.html = html;
            }
            const element = entry.element;
            // MapLibre keeps classes of its own on the element, which place it, so only ours are changed.
            if (entry.shape !== shape) {
                if (entry.shape) element.classList.remove(entry.shape);
                element.classList.add(shape);
                entry.shape = shape;
            }
            element.classList.toggle("plain", !marker.html);
            element.classList.toggle("selected", selected);
            // A silhouette is the aircraft itself, in its colour, with nothing behind it.
            element.style.background = shape === "silhouette" ? "" : drawn.color;
            element.style.color = shape === "silhouette" ? drawn.color : textOn(drawn.color);
            // MapLibre sets the element's opacity on every frame, so it is given to the marker instead.
            entry.marker.setOpacity(drawn.point.opacity);
            element.style.zIndex = selected ? "2" : "";
            element.title = drawn.point.label || drawn.point.name;
            element.setAttribute("aria-label", drawn.point.label || drawn.point.name);
            element.setAttribute("aria-pressed", String(selected));
            this.place(entry, drawn);
            if (!existing) entry.marker.addTo(this.map!);
        }
        for (const [key, entry] of this.markers) {
            if (!seen.has(key)) {
                entry.marker.remove();
                this.markers.delete(key);
            }
        }
        if (this.frame === undefined && [...this.markers.values()].some((entry) => entry.glide))
            this.frame = requestAnimationFrame(() => this.step());
    }

    /** Moves a marker to its new report, or starts it gliding there. */
    private place(entry: MarkerEntry, drawn: DrawnPoint): void {
        const reportedMs = drawn.reportedMs ?? null;
        const report: Report | null = reportedMs === null ? null : { position: [drawn.point.lon, drawn.point.lat], at: reportedMs };
        const glide = report && drawn.glide && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        // A hidden tab draws no frames, so the marker is first brought to where its glide has got to.
        this.advance(entry, Date.now());
        const next = glide ? nextGlide(entry.position, entry.report, report, Date.now()) : "jump";
        if (next === "stay") {
            entry.report = { ...report!, position: entry.report!.position };
            return;
        }
        entry.report = report;
        entry.glide = next === "jump" ? null : next;
        if (!entry.glide) this.moveTo(entry, [drawn.point.lon, drawn.point.lat]);
    }

    private moveTo(entry: MarkerEntry, position: LngLat): void {
        entry.position = position;
        entry.marker.setLngLat(position);
    }

    /** One frame of the gliding markers, and their trails once they have moved far enough to show. */
    private step(): void {
        this.frame = undefined;
        const map = this.map;
        if (!map) return;
        const now = Date.now();
        let trails = false;
        let gliding = false;
        for (const [key, entry] of this.markers) {
            if (!entry.glide) continue;
            if (this.advance(entry, now)) gliding = true;
            if (this.trailOwners.has(key) && (!entry.glide || this.movedOnScreen(entry))) trails = true;
        }
        if (trails) this.updateLayers();
        if (gliding) this.frame = requestAnimationFrame(() => this.step());
    }

    /** Moves a gliding marker to where its glide is at `now`, ending the glide at its end. False once it has ended. */
    private advance(entry: MarkerEntry, now: number): boolean {
        if (!entry.glide) return false;
        this.moveTo(entry, positionAt(entry.glide, now));
        if (now < entry.glide.start + entry.glide.duration) return true;
        entry.glide = null;
        return false;
    }

    private movedOnScreen(entry: MarkerEntry): boolean {
        if (!entry.trailDrawnAt) return true;
        const a = this.map!.project(entry.trailDrawnAt);
        const b = this.map!.project(entry.position);
        return Math.hypot(a.x - b.x, a.y - b.y) >= TRAIL_STEP_PX;
    }

    private createMarker(key: string): MarkerEntry {
        const element = document.createElement("button");
        element.type = "button";
        element.classList.add("feed-marker");
        element.addEventListener("click", () => this.onSelect(key));
        const entry: MarkerEntry = {
            marker: new Marker({ element, anchor: "center" }),
            element,
            html: "",
            shape: "",
            position: [0, 0],
            report: null,
            glide: null,
            trailDrawnAt: null,
        };
        this.markers.set(key, entry);
        return entry;
    }

    /* ---------------- lines, polygons and areas ---------------- */

    private addLayers(): void {
        const map = this.map;
        if (!map || map.getSource(SHAPES)) return;
        map.addSource(SHAPES, { type: "geojson", data: emptyCollection() });
        map.addSource(AREAS, { type: "geojson", data: emptyCollection() });
        map.addLayer({
            id: "feed-area",
            type: "line",
            source: AREAS,
            paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.8 },
        });
        // What is dashed stays in the background, under the filled shapes, and so does a tap on it: a dashed polygon's
        // see-through fill takes a tap inside it only where no other shape does.
        const polygon: FilterSpecification = ["==", ["geometry-type"], "Polygon"];
        const dashed: FilterSpecification = ["==", ["get", "dashed"], true];
        map.addLayer({
            id: "feed-dashed-fill",
            type: "fill",
            source: SHAPES,
            filter: ["all", polygon, dashed],
            paint: { "fill-color": ["get", "color"], "fill-opacity": 0 },
        });
        map.addLayer({
            id: "feed-dashed",
            type: "line",
            source: SHAPES,
            filter: dashed,
            paint: {
                "line-color": ["get", "color"],
                "line-width": 1.5,
                "line-dasharray": [3, 2],
                "line-opacity": ["*", 0.85, ["get", "opacity"]],
            },
        });
        // A selected dashed polygon is filled faintly, over the others, like any selected shape.
        map.addLayer({
            id: "feed-fill",
            type: "fill",
            source: SHAPES,
            filter: ["all", polygon, ["any", ["!=", ["get", "dashed"], true], ["==", ["get", "selected"], true]]],
            paint: {
                "fill-color": ["get", "color"],
                "fill-opacity": ["case", ["get", "dashed"], 0.15, ["*", 0.25, ["get", "opacity"]]],
            },
        });
        // The selected line is cased, a white band with a dark edge under it, so it stands out among lines of its own
        // colour, such as a road among roads in the same condition. Width alone doesn't.
        const selected: FilterSpecification = ["==", ["get", "selected"], true];
        map.addLayer({
            id: "feed-selected-halo",
            type: "line",
            source: SHAPES,
            filter: selected,
            layout: { "line-cap": ["get", "cap"], "line-join": "round" },
            paint: {
                "line-color": "rgba(0, 0, 0, 0.55)",
                "line-width": ["+", ["get", "width"], 10],
                "line-blur": 1,
                "line-opacity": ["get", "fade"],
            },
        });
        map.addLayer({
            id: "feed-selected-casing",
            type: "line",
            source: SHAPES,
            filter: selected,
            layout: { "line-cap": ["get", "cap"], "line-join": "round" },
            paint: { "line-color": "#ffffff", "line-width": ["+", ["get", "width"], 6], "line-opacity": ["get", "fade"] },
        });
        map.addLayer({
            id: "feed-line",
            type: "line",
            source: SHAPES,
            // A selected dashed shape is drawn whole, over its casing, like any other selected shape.
            filter: ["any", ["!=", ["get", "dashed"], true], ["==", ["get", "selected"], true]],
            layout: { "line-cap": ["get", "cap"], "line-join": "round", "line-sort-key": ["case", ["get", "selected"], 1, 0] },
            paint: {
                "line-color": ["get", "color"],
                "line-width": ["get", "width"],
                "line-opacity": ["*", ["get", "fade"], ["case", ["get", "selected"], 1, ["get", "opacity"]]],
            },
        });
        this.updateLayers();
    }

    private updateLayers(): void {
        const map = this.map;
        const shapes = map?.getSource<GeoJSONSource>(SHAPES);
        const areas = map?.getSource<GeoJSONSource>(AREAS);
        if (!shapes || !areas) return;
        const selected = this.content.selected;
        shapes.setData({
            type: "FeatureCollection",
            features: this.content.shapes.flatMap(({ key, selects, shape, color, name: shapeName }): Feature[] => {
                const isSelected = selects === selected || key === selected;
                const opacity = shape.kind === "road.maintenance_track" ? shape.opacity * 0.5 : shape.opacity;
                const properties = {
                    key,
                    selects,
                    color,
                    name: shapeName,
                    width: lineWidth(shape.kind),
                    opacity,
                    dashed: shape.dashed,
                    selected: isSelected,
                    fade: 1,
                    cap: "round",
                };
                const geometry = shape.geometry;
                if (geometry.type === "polygon") {
                    return [{ type: "Feature", geometry: { type: "MultiPolygon", coordinates: geometry.polygons }, properties }];
                }
                const cuts = geometry.paths.map((path) => this.trail(selects, path));
                if (shape.dashed || (!geometry.colors && !geometry.opacities)) {
                    const coordinates = cuts.map((cut) => cut.path);
                    return [{ type: "Feature", geometry: { type: "MultiLineString", coordinates }, properties }];
                }
                return cuts.flatMap((cut, index) => {
                    // A position the cut added is on the way to the first one it left out, and is drawn like it.
                    const ofCut = <T>(values: T[]): (T | undefined)[] =>
                        cut.path.map((_, at) => values[Math.min(at, cut.kept, values.length - 1)]);
                    const colors = ofCut(geometry.colors?.[index] ?? []).map((own) => own ?? color);
                    const opacities = ofCut(geometry.opacities?.[index] ?? []).map((own) => own ?? 1);
                    return linePieces(cut.path, colors, opacities).map((piece) => ({
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: piece.path },
                        properties: {
                            ...properties,
                            color: piece.color,
                            fade: piece.opacity,
                            // Round ends of see-through pieces would show as dots where they overlap.
                            cap: piece.opacity * (isSelected ? 1 : opacity) < 1 ? "butt" : "round",
                        },
                    }));
                });
            }),
        });
        areas.setData({
            type: "FeatureCollection",
            features: this.content.areas.map(({ area, color }) => ({
                type: "Feature",
                geometry: { type: "LineString", coordinates: areaOutline(area) },
                properties: { color },
            })),
        });
    }

    /** A line of a gliding point's, cut to end at its marker (see cutTrail). */
    private trail(owner: string, path: LngLat[]): { path: LngLat[]; kept: number } {
        const entry = this.markers.get(owner);
        if (entry) entry.trailDrawnAt = entry.position;
        return entry?.glide ? cutTrail(path, entry.glide, entry.position) : { path, kept: path.length };
    }

    private click(event: MapLayerMouseEvent): void {
        // A marker's own click handler selects it; the click still reaches the map, which must not undo that.
        if ((event.originalEvent.target as Element | null)?.closest?.(".feed-marker")) return;
        // The topmost first, so a line wins over the polygon under it.
        const hit = this.map?.queryRenderedFeatures(event.point, { layers: TAP_LAYERS })[0];
        // A shape with nothing to show has no key to select, and a tap on it is a tap on the map.
        const selects = hit?.properties?.selects;
        this.onSelect(typeof selects === "string" && selects !== "" ? selects : null);
    }

    private updateAttribution(): void {
        const text = this.content.attributions.join(" · ");
        if (!this.map || text === this.attributionText) return;
        this.attributionText = text;
        if (this.attribution) this.map.removeControl(this.attribution);
        this.attribution = new AttributionControl({ compact: true, customAttribution: text || undefined });
        this.map.addControl(this.attribution, "bottom-right");
        // MapLibre opens a compact attribution once its sources have loaded, and on a small card that hides much of
        // the map. It starts closed instead, behind its button.
        // Closed is what MapLibre's own toggle leaves: `open` set, `maplibregl-compact-show` gone.
        const element = this.map.getContainer().querySelector(".maplibregl-ctrl-attrib");
        if (!element) return;
        const close = (): boolean => {
            if (!element.classList.contains("maplibregl-compact-show")) return false;
            element.setAttribute("open", "");
            element.classList.remove("maplibregl-compact-show");
            return true;
        };
        if (close()) return;
        const observer = new MutationObserver(() => close() && observer.disconnect());
        observer.observe(element, { attributes: true, attributeFilter: ["class"] });
    }
}

/** Road kinds stand out from other lines, and a maintenance route stays in the background. */
function lineWidth(kind: string): number {
    if (kind === "road.maintenance_track") return 2;
    return kind.startsWith("road.") ? 5 : 3;
}

function emptyCollection(): FeatureCollection {
    return { type: "FeatureCollection", features: [] };
}
