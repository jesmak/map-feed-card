/**
 * The map: MapLibre on Home Assistant's base map (map-tiles.ts), with the feeds' points as HTML markers and their
 * lines, polygons and areas as layers of their own on top.
 */
import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { FilterSpecification, GeoJSONSource, MapLayerMouseEvent, StyleSpecification } from "maplibre-gl";
// The worker is carried as text and started from a blob, so the card stays one file, as HACS installs it.
import workerSource from "maplibre-gl/dist/maplibre-gl-worker.mjs?raw";

import { areaOutline, type FeedArea, type FeedPoint, type FeedShape, type LngLat } from "./feed";
import { loadStyle, MapError, onTokenChange, refreshToken, transformRequest } from "./map-tiles";
import type { MapStyle } from "./options";
import { escapeHtml, markerHtml, textOn } from "./style";

/** A point as the card wants it drawn. `key` is unique across the card's feeds. */
export interface DrawnPoint {
    key: string;
    point: FeedPoint;
    color: string;
    /** Text beside the marker, or '' for none. */
    label?: string;
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
}

/** A marker closer to the map's edge than this is moved into view when selected: half of a badge, and some air. */
const REVEAL_MARGIN_PX = 32;

/** Not much point in zooming a single item in to its doorstep. */
const FIT_MAX_ZOOM = 13;
/** Home's surroundings, a region rather than streets, while there is nothing to fit the map to. */
const HOME_ZOOM = 9;

/** After a refused tile, how long before another refusal may ask for a new token again. */
const RECOVERY_THROTTLE_MS = 30_000;

const SHAPES = "feed-shapes";
const AREAS = "feed-areas";
/** The layers a tap can hit, polygons below lines. */
const TAP_LAYERS = ["feed-fill", "feed-line"];

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
    private refused = false;
    private lastRecovery = 0;
    private unsubscribe?: () => void;
    private destroyed = false;
    /** What the map was last fitted to, fitted again when its size changes until someone moves it. */
    private fittedTo: [LngLat, LngLat] | null = null;
    private movedSinceFit = false;

    constructor(
        private readonly container: HTMLElement,
        style: MapStyle,
        dark: boolean,
        theme: Record<string, string> | null,
        private readonly onSelect: (key: string | null) => void,
        private readonly home: LngLat | null = null,
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
            center: this.home ?? [0, 0],
            zoom: this.home ? HOME_ZOOM : 1,
            attributionControl: false,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            transformRequest: (url) => transformRequest(url),
        });
        this.map = map;
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
            if (event.originalEvent) this.movedSinceFit = true;
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
        const same = style === this.style && dark === this.dark && JSON.stringify(theme) === JSON.stringify(this.theme);
        if (!this.map || (!force && same)) return;
        delete this.container.dataset.mapReady;
        this.style = style;
        this.dark = dark;
        this.theme = theme;
        const loaded: StyleSpecification = await loadStyle(style, dark, theme);
        // Only the newest request is drawn, when several were made while styles were loading.
        if (!this.destroyed && style === this.style && dark === this.dark && theme === this.theme)
            this.map.setStyle(loaded, { diff: false });
    }

    update(content: MapContent): void {
        this.content = content;
        if (!this.map) return;
        this.updateMarkers();
        this.updateLayers();
        this.updateAttribution();
    }

    /** Shows everything in `bounds`, as [[west, south], [east, north]]. */
    fit(bounds: [LngLat, LngLat]): void {
        this.fittedTo = bounds;
        this.movedSinceFit = false;
        this.map?.fitBounds(bounds, { padding: 40, maxZoom: FIT_MAX_ZOOM, animate: false });
    }

    /** Moves the selected item into view when it isn't, or is so near the edge that its marker is cut off. */
    reveal(position: LngLat): void {
        const map = this.map;
        if (!map) return;
        const { x, y } = map.project(position);
        const { clientWidth: width, clientHeight: height } = map.getContainer();
        const margin = REVEAL_MARGIN_PX;
        if (x < margin || y < margin || x > width - margin || y > height - margin) {
            this.movedSinceFit = true;
            map.easeTo({ center: position });
        }
    }

    resize(): void {
        if (!this.map) return;
        // A new size clears the canvas until the next frame, so the map isn't drawn until MapLibre is idle again.
        delete this.container.dataset.mapReady;
        this.map.resize();
        // A dashboard lays its columns out after the card has started, so the first fit can be for another width.
        if (this.fittedTo && !this.movedSinceFit) this.fit(this.fittedTo);
    }

    destroy(): void {
        this.destroyed = true;
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
            entry.marker.setLngLat([drawn.point.lon, drawn.point.lat]);
            if (!existing) entry.marker.addTo(this.map!);
        }
        for (const [key, entry] of this.markers) {
            if (!seen.has(key)) {
                entry.marker.remove();
                this.markers.delete(key);
            }
        }
    }

    private createMarker(key: string): MarkerEntry {
        const element = document.createElement("button");
        element.type = "button";
        element.classList.add("feed-marker");
        element.addEventListener("click", () => this.onSelect(key));
        const entry = { marker: new Marker({ element, anchor: "center" }), element, html: "", shape: "" };
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
        map.addLayer({
            id: "feed-fill",
            type: "fill",
            source: SHAPES,
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { "fill-color": ["get", "color"], "fill-opacity": ["*", 0.25, ["get", "opacity"]] },
        });
        // The selected line is cased, a white band with a dark edge under it, so it stands out among lines of its own
        // colour, such as a road among roads in the same condition. Width alone doesn't.
        const selected: FilterSpecification = ["==", ["get", "selected"], true];
        map.addLayer({
            id: "feed-selected-halo",
            type: "line",
            source: SHAPES,
            filter: selected,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "rgba(0, 0, 0, 0.55)", "line-width": ["+", ["get", "width"], 10], "line-blur": 1 },
        });
        map.addLayer({
            id: "feed-selected-casing",
            type: "line",
            source: SHAPES,
            filter: selected,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#ffffff", "line-width": ["+", ["get", "width"], 6] },
        });
        map.addLayer({
            id: "feed-line",
            type: "line",
            source: SHAPES,
            layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["case", ["get", "selected"], 1, 0] },
            paint: {
                "line-color": ["get", "color"],
                "line-width": ["get", "width"],
                "line-opacity": ["case", ["get", "selected"], 1, ["get", "opacity"]],
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
            features: this.content.shapes.map(({ key, selects, shape, color, name: shapeName }) => ({
                type: "Feature",
                geometry:
                    shape.geometry.type === "line"
                        ? { type: "MultiLineString", coordinates: shape.geometry.paths }
                        : { type: "MultiPolygon", coordinates: shape.geometry.polygons },
                properties: {
                    key,
                    selects,
                    color,
                    name: shapeName,
                    width: lineWidth(shape.kind),
                    opacity: shape.kind === "road.maintenance_track" ? shape.opacity * 0.5 : shape.opacity,
                    selected: selects === selected || key === selected,
                },
            })),
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

    private click(event: MapLayerMouseEvent): void {
        // A marker's own click handler selects it; the click still reaches the map, which must not undo that.
        if ((event.originalEvent.target as Element | null)?.closest?.(".feed-marker")) return;
        const hit = this.map?.queryRenderedFeatures(event.point, { layers: TAP_LAYERS }).at(-1);
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
