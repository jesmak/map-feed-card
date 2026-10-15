/**
 * A dashboard card that draws map feeds (docs/map-feed-format.md) on Home Assistant's own map, with the selected
 * item's details in a panel below the map, or beside it when the card is wide.
 */
import { LitElement, css, html, nothing, unsafeCSS } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?raw";

import { DetailLoader, renderDetails } from "./details";
import "./editor";
import {
    boundsOf,
    readFeed,
    areaOutline,
    hasDetails,
    isMapFeed,
    kindFamily,
    shapePositions,
    type FeedImage,
    type FeedItem,
    type FeedList,
    type FeedPoint,
    type LngLat,
    type LegendEntry,
} from "./feed";
import type { HomeAssistant } from "./hass";
import { rowOf, sortOptions, sortRows, startingSort, type Row } from "./list";
import { browserLanguage, translate } from "./localize/localize";
import { FeedMap, type DrawnArea, type DrawnPoint, type DrawnShape, type MapContent } from "./map";
import { ensureToken, MapError } from "./map-tiles";
import { readThemeColors } from "./map-theme";
import { parseOptions, type CardOptions, type FeedOptions } from "./options";
import { areaColor, canBeLate, DELAY_COLORS, delayClass, escapeHtml, pointColor, shapeColor, textOn } from "./style";

/** Replaced at build time with the version in package.json. */
declare const __CARD_VERSION__: string;

/** How often the ages in the details are redrawn, between the feeds' own updates. */
const TICK_MS = 30_000;

/** How long a row's details take to unfold or fold away, as in the styles. */
const UNFOLD_MS = 220;

/** How long after a row was opened content that grows is still fitted into view. */
const FIT_GROWTH_MS = 3000;

/** From this width the details go beside the map instead of below it. */
const WIDE_PX = 640;

console.info(
    `%c  MAP-FEED-CARD \n%c  ${__CARD_VERSION__}    `,
    "color: orange; font-weight: bold; background: black",
    "color: white; font-weight: bold; background: dimgray",
);

const registry = window as unknown as { customCards?: Array<Record<string, unknown>> };
registry.customCards = registry.customCards ?? [];
registry.customCards.push({
    type: "map-feed-card",
    name: translate(browserLanguage(), "common.name"),
    description: translate(browserLanguage(), "common.description"),
    documentationURL: "https://github.com/jesmak/map-feed-card",
    preview: true,
});

interface ViewItem {
    item: FeedItem;
    point: FeedPoint | null;
    color: string;
    feed: FeedOptions;
    list: FeedList;
}

/** Everything the card draws from its feeds at one moment. */
interface View {
    content: MapContent;
    /** Every item by its key, points and shapes alike, with what its details need. */
    items: Map<string, ViewItem>;
    /** Each feed's list settings, in the card's feed order. */
    lists: FeedList[];
    legend: LegendEntry[];
    problems: string[];
    /** What the map shows when it first opens. */
    extent: LngLat[];
}

@customElement("map-feed-card")
export class MapFeedCard extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @state() private options?: CardOptions;
    @state() private selected: string | null = null;
    @state() private featured: FeedImage | null = null;
    @state() private mapError = "";
    @state() private wide = false;
    /** The list's order as chosen on the card; undefined until someone chooses. */
    @state() private sortKey?: string | null;
    /** The rows whose details are folding away; several, when rows are tapped one after another. */
    @state() private closing: ReadonlySet<string> = new Set();
    /** The theme's map colours, and the theme they were read for. */
    private theme?: { key: string; colors: Record<string, string> | null };
    /** When the selection changed, so content that grows soon after is fitted, but not once the list has been scrolled away. */
    private selectedAt = 0;
    @query(".map") private mapElement?: HTMLElement;

    private map?: FeedMap;
    private mapStarting = false;
    private fitted = false;
    private view?: View;
    private readonly loader = new DetailLoader();
    private ticker?: ReturnType<typeof setInterval>;
    private resizer?: ResizeObserver;
    /** Set when something is selected, so the list scrolls its row into view once it is drawn. */
    private fitSelected = false;

    public static getConfigElement(): HTMLElement {
        return document.createElement("map-feed-card-editor");
    }

    /** Offers the first map feed there is when the card is added from the picker. */
    public static getStubConfig(hass?: HomeAssistant): Record<string, unknown> {
        const feed = Object.values(hass?.states ?? {}).find((entity) => isMapFeed(entity));
        return { entities: feed ? [feed.entity_id] : [] };
    }

    public setConfig(config: Record<string, unknown>): void {
        const options = parseOptions(config);
        const previous = this.options;
        this.options = options;
        if (previous && previous.feeds.map((feed) => feed.entity).join() !== options.feeds.map((feed) => feed.entity).join()) {
            this.fitted = false;
        }
        void this.map?.setStyle(options.mapStyle, this.dark(), this.themeColors());
    }

    public getCardSize(): number {
        const list = this.options?.list ? this.options.listHeight : 0;
        return Math.ceil(((this.options?.mapHeight ?? 300) + list) / 50) + 3;
    }

    public getGridOptions(): Record<string, unknown> {
        return { columns: "full", min_columns: 6, rows: "auto" };
    }

    public connectedCallback(): void {
        super.connectedCallback();
        // Ages are drawn in the details, and in every row of the list, so they are redrawn between the feeds' updates.
        this.ticker = setInterval(() => (this.selected || this.options?.list) && this.requestUpdate(), TICK_MS);
        this.resizer = new ResizeObserver(([entry]) => {
            this.wide = (entry?.contentRect.width ?? 0) >= WIDE_PX;
            this.map?.resize();
            this.fitLegend();
        });
        this.resizer.observe(this);
        // A card moved on the page, as the dashboard's edit mode does, lost its map; shouldUpdate would wait for a feed to change.
        this.mapError = "";
        this.requestUpdate();
    }

    /** A card leaves the page when the dashboard changes view; its map is drawn again when it comes back. */
    public disconnectedCallback(): void {
        super.disconnectedCallback();
        clearInterval(this.ticker);
        this.resizer?.disconnect();
        this.map?.destroy();
        this.map = undefined;
        this.fitted = false;
    }

    protected shouldUpdate(changed: PropertyValues): boolean {
        const previous = changed.get("hass") as HomeAssistant | undefined;
        if (!previous || changed.size > 1 || !changed.has("hass") || !this.options) return true;
        // Home Assistant hands the card every state change in the house; only its own feeds and the theme matter.
        return (
            previous.themes?.darkMode !== this.hass?.themes?.darkMode ||
            // Another theme can paint the map in other colours (map-theme.ts).
            previous.themes?.theme !== this.hass?.themes?.theme ||
            previous.selectedTheme !== this.hass?.selectedTheme ||
            this.options.feeds.some(({ entity }) => previous.states[entity] !== this.hass?.states[entity])
        );
    }

    protected willUpdate(changed: PropertyValues): void {
        if (changed.has("hass") || changed.has("options")) this.view = this.buildView();
        // A selected item that has left the feed has nothing left to show.
        if (this.selected && !this.view?.items.has(this.selected)) {
            this.selected = null;
            this.featured = null;
        }
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.options || !this.hass) return nothing;
        const view = this.view;
        const selected = this.selected ? view?.items.get(this.selected) : undefined;
        if (selected?.point?.detailAction) {
            this.loader.load(selected.point, this.hass, selected.feed.entity, () => {
                this.requestUpdate();
                this.fitSoon();
            });
        }
        const { list, title } = this.options;
        // Wide, the list has a header of its own beside the map, and the title moves there.
        const titleInList = list && this.wide && title !== "";
        return html`
            <ha-card
                class=${classMap({ wide: this.wide, "with-list": list })}
                style="--map-height:${this.options.mapHeight}px;--list-height:${this.options.listHeight}px"
            >
                ${title && !titleInList ? html`<h1 class="card-title">${title}</h1>` : nothing}
                <div class="body">
                    <div class="map-wrap">
                        <div class="map"></div>
                        ${this.options.legend && view?.legend.length ? this.legend(view.legend) : nothing}
                        ${this.mapError ? html`<div class="map-error">${this.mapError}</div>` : nothing}
                    </div>
                    ${
                        list
                            ? this.renderList(view, titleInList ? title : "")
                            : html`<div class="panel">
                                  ${view?.problems.map((problem) => html`<div class="problem">${problem}</div>`)}
                                  ${selected ? this.details(selected) : html`<div class="hint">${this.text("common.select_hint")}</div>`}
                              </div>`
                    }
                </div>
            </ha-card>
        `;
    }

    private details(selected: ViewItem, row?: Row): TemplateResult {
        return renderDetails({
            row,
            item: selected.item,
            point: selected.point,
            color: selected.color,
            thresholds: selected.feed.delayThresholds,
            actionRows: selected.point ? this.loader.get(selected.point) : undefined,
            featured: this.featured,
            onImage: (image) => (this.featured = image),
            text: (key, values) => this.text(key, values),
        });
    }

    private renderList(view: View | undefined, title: string): TemplateResult {
        const lists = view?.lists ?? [];
        const options = sortOptions(lists);
        const key = this.sortKey !== undefined ? this.sortKey : startingSort(this.options!.sort, lists);
        const entries = sortRows(
            [...(view?.items ?? [])].map(([itemKey, entry]) => ({ ...entry, key: itemKey })),
            key,
            this.language(),
        );
        const counts = new Set(lists.map((list) => list.count));
        const number =
            counts.size === 1 && lists[0]?.count ? `${entries.length} ${lists[0].count}` : this.text("list.count", { n: entries.length });
        // A single feed says what the items are, by its sensor's name.
        const feeds = this.options!.feeds;
        const name = feeds.length === 1 ? this.hass?.states[feeds[0]!.entity]?.attributes?.friendly_name : undefined;
        const count = typeof name === "string" && name ? `${name} · ${number}` : number;
        return html`<div class="list">
            <div class="list-head">
                ${title ? html`<h1 class="list-title">${title}</h1>` : html`<span class="count">${count}</span>`}
                ${
                    options.length > 1
                        ? html`<label class="sort">
                              <select
                                  aria-label=${this.text("list.sort")}
                                  @change=${(event: Event) => (this.sortKey = (event.target as HTMLSelectElement).value)}
                              >
                                  ${options.map((option) => html`<option value=${option.key} ?selected=${option.key === key}>${option.label}</option>`)}
                              </select>
                              <span class="sort-label" aria-hidden="true"
                                  >${options.find((option) => option.key === key)?.label ?? ""}</span
                              >
                              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                          </label>`
                        : nothing
                }
            </div>
            <div class="rows">
                ${view?.problems.map((problem) => html`<div class="problem">${problem}</div>`)}
                ${entries.map((entry) => this.listItem(entry))}
            </div>
        </div>`;
    }

    /**
     * A row, and under it its details, which unfold when the row is selected and fold away when it no longer is. The
     * row itself stays as it is, so nothing in the list moves but the details.
     */
    private listItem(entry: ViewItem & { key: string }): TemplateResult {
        const open = entry.key === this.selected;
        const shown = open || this.closing.has(entry.key);
        const row = rowOf(entry.item, entry.point, (key, values) => this.text(key, values));
        return html`<div class="item ${open ? "open" : ""}" data-key=${entry.key} style="--item-color:${entry.color}">
            ${this.row(entry, row, open)}
            <div class="unfold" @transitionend=${(event: TransitionEvent) => open && event.target === event.currentTarget && this.fitRow()}>
                <div class="unfold-inner">
                    ${
                        shown
                            ? html`<div class="unfold-body" @load=${{ handleEvent: () => open && this.fitSoon(), capture: true }}>
                                  ${this.details(entry, row)}
                              </div>`
                            : nothing
                    }
                </div>
            </div>
        </div>`;
    }

    private row(entry: ViewItem & { key: string }, row: Row, open: boolean): TemplateResult {
        const valueStyle = row.valueIsDelay ? `color:color-mix(in srgb, ${entry.color} 70%, var(--primary-text-color))` : "";
        return html`<button class="row" aria-expanded=${open ? "true" : "false"} @click=${() => this.select(open ? null : entry.key)}>
            ${
                entry.point?.badge
                    ? html`<span class="chip" style="background:${entry.color};color:${textOn(entry.color)}">${entry.point.badge}</span>`
                    : html`<span class="dot" style="background:${entry.color};opacity:${entry.item.opacity}"></span>`
            }
            <span class="row-text">
                <span class="row-title">${row.title}</span>
                ${row.text ? html`<span class="row-sub">${row.text}</span>` : nothing}
            </span>
            ${row.value ? html`<span class="row-value" style=${valueStyle}>${row.value}</span>` : nothing}
        </button>`;
    }

    protected updated(): void {
        this.fitLegend();
        if (this.fitSelected) {
            this.fitSelected = false;
            this.fitRow();
        }
        // A map that failed isn't tried again on every update of a feed, only when the card is connected again.
        if (!this.map && !this.mapStarting && !this.mapError && this.mapElement && this.hass && this.options) void this.startMap();
        if (!this.map || !this.view) return;
        void this.map.setStyle(this.options!.mapStyle, this.dark(), this.themeColors());
        this.map.update({ ...this.view.content, selected: this.selected });
        if (!this.fitted) {
            const bounds = boundsOf(this.view.extent);
            if (bounds) {
                this.map.fit(bounds);
                this.fitted = true;
            }
        }
    }

    private async startMap(): Promise<void> {
        this.mapStarting = true;
        const { latitude, longitude } = this.hass!.config ?? {};
        const home: LngLat | null = typeof latitude === "number" && typeof longitude === "number" ? [longitude, latitude] : null;
        const map = new FeedMap(this.mapElement!, this.options!.mapStyle, this.dark(), this.themeColors(), (key) => this.select(key), home);
        try {
            await ensureToken(this.hass!);
            await map.init();
            if (!this.isConnected) {
                map.destroy();
                return;
            }
            this.map = map;
            this.mapError = "";
            this.requestUpdate();
        } catch (error) {
            map.destroy();
            this.mapError = this.text(`map_error.${error instanceof MapError ? error.reason : "style"}`);
            console.error("map-feed-card:", error);
        } finally {
            this.mapStarting = false;
        }
    }

    private select(key: string | null): void {
        if (key === this.selected) return;
        // The row being closed keeps its details until they have folded away.
        const previous = this.selected;
        if (previous) {
            this.closing = new Set([...this.closing, previous]);
            setTimeout(() => {
                const closing = new Set(this.closing);
                closing.delete(previous);
                this.closing = closing;
                // A little after the fold has ended, so a late frame doesn't drop the details while they still show.
            }, UNFOLD_MS + 100);
        }
        this.selectedAt = Date.now();
        this.selected = key;
        this.featured = null;
        const position = key ? this.view?.items.get(key)?.point : null;
        if (position) this.map?.reveal([position.lon, position.lat]);
        this.renderRoot.querySelector(".panel")?.scrollTo({ top: 0 });
        this.fitSelected = key !== null;
    }

    /**
     * Scrolls the list, and only the list, as little as it takes for the selected row to fit unfolded, or to its top
     * when it can't fit. It scrolls while the row unfolds, so the row's size is worked out from what it will be: the
     * row and its details in full, and a row above it that is folding away at the same time as already gone. The
     * browser stops a scroll at the end of the list as it is when the scroll starts, before the row has grown, so it
     * is called again once the row has unfolded.
     */
    private fitRow(): void {
        const rows = this.renderRoot.querySelector<HTMLElement>(".rows");
        const find = (key: string | null) => (key ? rows?.querySelector<HTMLElement>(`.item[data-key="${CSS.escape(key)}"]`) : null);
        const item = find(this.selected);
        if (!rows || !item) return;
        const view = rows.getBoundingClientRect();
        const box = item.getBoundingClientRect();
        let shrinks = 0;
        for (const key of this.closing) {
            const closing = find(key);
            if (key !== this.selected && closing && closing.getBoundingClientRect().top < box.top) {
                shrinks += closing.querySelector(".unfold")!.getBoundingClientRect().height;
            }
        }
        const top = box.top - shrinks;
        const height = item.querySelector(".row")!.getBoundingClientRect().height + (item.querySelector(".unfold-body")?.scrollHeight ?? 0);
        let by = 0;
        if (top + height > view.bottom) by = top + height - view.bottom;
        if (top - by < view.top) by = top - view.top;
        if (Math.abs(by) >= 1) rows.scrollBy({ top: by, behavior: "smooth" });
    }

    /** Fits the selected row again when its content grows soon after it was opened: rows loaded, a picture in. */
    private fitSoon(): void {
        if (Date.now() - this.selectedAt > FIT_GROWTH_MS) return;
        void this.updateComplete.then(() => this.fitRow());
    }

    private buildView(): View {
        const view: View = {
            content: { points: [], shapes: [], areas: [], attributions: [], selected: null },
            items: new Map(),
            lists: [],
            legend: [],
            problems: [],
            extent: [],
        };
        const now = Date.now();
        const legends = new Set<string>();
        /** The kinds drawn in their kind's colour, by colour and name, for the card's own legend. */
        const kinds = new Map<string, LegendEntry>();
        const addKind = (item: FeedItem, color: string) => {
            const label = this.kindName(item.kind);
            kinds.set(`${color}|${label}`, { color, label });
        };
        for (const feed of this.options?.feeds ?? []) {
            const result = readFeed(this.hass?.states[feed.entity]);
            if (result.status !== "ok") {
                view.problems.push(this.problem(feed.entity, result.status));
                continue;
            }
            const { points, shapes, area, attribution, list } = result.feed;
            view.lists.push(list);
            const pointKeys = new Map<string, DrawnPoint>();
            const tooOld = (item: FeedItem) =>
                feed.maxAgeMinutes !== null && item.updatedMs !== null && now - item.updatedMs > feed.maxAgeMinutes * 60_000;
            /** What frames this feed when the card opens: its area, or without one everything in it. */
            const extent: LngLat[] = [];
            let byDelay = false;
            let ownColours = false;
            const delays = new Set<string>();
            for (const point of points) {
                if (tooOld(point)) continue;
                const drawn: DrawnPoint = {
                    key: `${feed.entity}|${point.id}`,
                    point,
                    color: pointColor(point, feed.colorBy, feed.delayThresholds),
                    label: feed.labels ? point.label || point.name : "",
                };
                if (feed.colorBy === "delay" && canBeLate(point)) {
                    byDelay = true;
                    delays.add(delayClass(point, feed.delayThresholds));
                } else {
                    ownColours = true;
                    if (!result.feed.legend.length && point.color === null) addKind(point, drawn.color);
                }
                pointKeys.set(point.id, drawn);
                view.content.points.push(drawn);
                view.items.set(drawn.key, { item: point, point, color: drawn.color, feed, list });
                extent.push([point.lon, point.lat]);
            }
            for (const shape of shapes) {
                const owner = shape.pointId ? pointKeys.get(shape.pointId) : undefined;
                // A shape whose point was hidden by its age goes with it; one of its own, by its own age.
                if (shape.pointId && !owner && points.some((point) => point.id === shape.pointId)) continue;
                if (!owner && tooOld(shape)) continue;
                const key = `${feed.entity}|${shape.id}`;
                // A shape of its own with nothing to show, such as a nameless maintenance route, is drawn but not offered.
                const selectable = owner !== undefined || hasDetails(shape);
                const drawn: DrawnShape = {
                    key,
                    selects: owner?.key ?? (selectable ? key : ""),
                    shape,
                    color: owner?.color ?? shapeColor(shape),
                    name: shape.name || owner?.point.name || "",
                };
                view.content.shapes.push(drawn);
                extent.push(...shapePositions(shape));
                if (!owner) {
                    if (selectable) view.items.set(key, { item: shape, point: null, color: drawn.color, feed, list });
                    ownColours = true;
                    if (!result.feed.legend.length && shape.color === null) addKind(shape, drawn.color);
                }
            }
            if (area && feed.showArea)
                view.content.areas.push({ area, color: feed.areaColor ?? areaColor(this.dark()) } satisfies DrawnArea);
            // The feed's area frames the map best; without one, everything in the feed does.
            view.extent.push(...(area ? areaOutline(area) : extent));
            // MapLibre reads an attribution as HTML; a feed's is text, as everything in it is.
            if (attribution) view.content.attributions.push(escapeHtml(attribution));
            // The delay classes explain what is coloured by delay, the feed's legend what keeps the feed's own colours.
            for (const legend of [byDelay ? this.delayLegend(feed, delays) : [], ownColours ? result.feed.legend : []]) {
                const signature = JSON.stringify(legend);
                if (legend.length && !legends.has(signature)) {
                    legends.add(signature);
                    view.legend.push(...legend);
                }
            }
        }
        // One kind needs no explaining; the card's title or the feed's name already says what it is.
        if (kinds.size > 1) view.legend.push(...kinds.values());
        view.content.attributions = [...new Set(view.content.attributions)];
        return view;
    }

    /** The card's own legend for colour by delay, with the feed's thresholds. */
    /** The delay classes, and the two greys only when the map has something cancelled or without a delay. */
    private delayLegend(feed: FeedOptions, shown: ReadonlySet<string>): LegendEntry[] {
        const [late, veryLate] = feed.delayThresholds;
        return [
            { color: DELAY_COLORS.on_time, label: this.text("legend.on_time") },
            { color: DELAY_COLORS.late, label: this.text("legend.late", { n: late }) },
            { color: DELAY_COLORS.very_late, label: this.text("legend.late", { n: veryLate }) },
            ...(shown.has("cancelled") ? [{ color: DELAY_COLORS.cancelled, label: this.text("legend.cancelled") }] : []),
            ...(shown.has("unknown") ? [{ color: DELAY_COLORS.unknown, label: this.text("legend.unknown") }] : []),
        ];
    }

    private legend(entries: LegendEntry[]): TemplateResult {
        return html`<div class="legend">
            ${entries.map((entry) => html`<span><i style="background:${entry.color}"></i>${entry.label}</span>`)}
        </div>`;
    }

    /**
     * A legend that wraps would keep all the width it may take, with space left over after its lines. It is narrowed to
     * its widest line, which keeps every line as it is: what didn't fit on a line before fits no better now.
     */
    private fitLegend(): void {
        const legend = this.renderRoot.querySelector<HTMLElement>(".legend");
        if (!legend) return;
        legend.style.width = "";
        const lines = new Map<number, { left: number; right: number }>();
        for (const entry of legend.children) {
            const box = entry.getBoundingClientRect();
            const line = lines.get(Math.round(box.top));
            lines.set(Math.round(box.top), {
                left: Math.min(line?.left ?? box.left, box.left),
                right: Math.max(line?.right ?? box.right, box.right),
            });
        }
        if (lines.size < 2) return;
        const widest = Math.max(...[...lines.values()].map((line) => line.right - line.left));
        legend.style.width = `${Math.ceil(widest)}px`;
    }

    private problem(entity: string, status: "missing" | "unavailable" | "not_a_feed" | "unsupported_version"): string {
        if (status === "missing") return `${this.text("common.no_entity")} ${entity}`;
        return `${entity} ${this.text(`common.${status}`)}`;
    }

    /** Read inside the card's shadow root: a probe in the card's own light DOM isn't rendered, so the browser computes nothing for it. */
    private themeColors(): Record<string, string> | null {
        // Read again only when the theme changes: reading takes a probe in the page per colour.
        const theme = `${this.hass?.themes?.theme}|${this.hass?.selectedTheme?.theme}|${this.dark()}`;
        if (theme === this.theme?.key) return this.theme.colors;
        const card = this.renderRoot?.querySelector?.("ha-card");
        if (!(card instanceof HTMLElement)) return null;
        this.theme = { key: theme, colors: readThemeColors(card) };
        return this.theme.colors;
    }

    private dark(): boolean {
        return this.hass?.themes?.darkMode === true;
    }

    /** The kind's name in the card's language, or its family's for a kind the card doesn't know. */
    private kindName(kind: string): string {
        const key = `kinds.${kind.replaceAll(".", "_")}`;
        const name = this.text(key);
        return name !== key ? name : this.text(`kinds.family_${kindFamily(kind)}`);
    }

    private language(): string {
        return this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage();
    }

    private text(key: string, values: Record<string, string | number> = {}): string {
        return translate(this.language(), key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
    }

    static styles = [
        unsafeCSS(maplibreCss),
        css`
            :host {
                display: block;
            }
            ha-card {
                height: 100%;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                container: card / inline-size;
            }
            .card-title {
                margin: 0;
                padding: 12px 16px 8px;
                font-size: 20px;
                font-weight: 400;
                line-height: 28px;
                color: var(--ha-card-header-color, var(--primary-text-color));
            }
            .body {
                display: flex;
                flex-direction: column;
                flex: 1 1 auto;
                min-height: 0;
            }
            .map-wrap {
                position: relative;
                height: var(--map-height);
                flex: none;
            }
            .map {
                position: absolute;
                inset: 0;
            }
            .panel {
                padding: 14px 16px 16px;
                border-top: 1px solid var(--divider-color);
                max-height: max(var(--map-height), 320px);
                overflow-y: auto;
                flex: 1 1 auto;
                min-height: 0;
            }
            .wide .body {
                flex-direction: row;
                height: var(--map-height);
            }
            .wide .map-wrap {
                flex: 3 1 0;
                height: auto;
            }
            .wide .panel {
                flex: 2 1 0;
                max-height: none;
                border-top: none;
                border-left: 1px solid var(--divider-color);
            }
            /* the list */
            .list {
                display: flex;
                flex-direction: column;
                max-height: var(--list-height);
                min-height: 0;
                border-top: 1px solid var(--divider-color);
            }
            .wide .list {
                flex: 2 1 0;
                min-width: 0;
                max-height: none;
                border-top: none;
                border-left: 1px solid var(--divider-color);
            }
            .list-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                min-height: 32px;
                padding: 8px 16px;
                border-bottom: 1px solid var(--divider-color);
                flex: none;
            }
            .list-title {
                margin: 0;
                min-width: 0;
                font-size: 17px;
                font-weight: 500;
                overflow-wrap: anywhere;
                color: var(--ha-card-header-color, var(--primary-text-color));
            }
            .count {
                font-size: 13px;
                color: var(--secondary-text-color);
            }
            /* The pill shows its own label, centred the same in every browser. The native select lies over it unseen,
               so a tap still opens the system's own menu, and keyboards and screen readers get a real select. */
            .sort {
                position: relative;
                display: flex;
                align-items: center;
                gap: 6px;
                flex: 0 1 auto;
                min-width: 0;
                height: 32px;
                box-sizing: border-box;
                margin-left: auto;
                padding: 0 10px 0 12px;
                border-radius: 16px;
                border: 1px solid var(--divider-color);
                color: var(--primary-text-color);
                font: 500 13px/1 var(--ha-font-family-body, Roboto, sans-serif);
                cursor: pointer;
            }
            .sort:focus-within {
                outline: 2px solid var(--primary-color);
                outline-offset: 1px;
            }
            .sort-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .sort select {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                opacity: 0;
                cursor: pointer;
                font: inherit;
            }
            .sort select option {
                color: var(--primary-text-color);
                background: var(--card-background-color);
            }
            .sort svg {
                flex: none;
                width: 14px;
                height: 14px;
                pointer-events: none;
                fill: none;
                stroke: var(--primary-text-color);
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
            }
            .rows {
                overflow-y: auto;
                flex: 1 1 auto;
                min-height: 0;
            }
            .rows .problem {
                margin: 10px 16px 0;
            }
            .row {
                display: grid;
                grid-template-columns: auto minmax(0, 1fr) auto;
                align-items: center;
                gap: 2px 12px;
                width: 100%;
                padding: 11px 16px;
                border: none;
                background: none;
                color: var(--primary-text-color);
                font: inherit;
                text-align: left;
                cursor: pointer;
            }
            .row:hover {
                background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
            }
            .row .chip {
                font-size: 13px;
                min-width: 34px;
                text-align: center;
                flex: none;
            }
            .row-text {
                display: flex;
                flex-direction: column;
                flex: 1 1 auto;
                min-width: 0;
            }
            .row-title {
                font-size: 15px;
                overflow-wrap: anywhere;
            }
            .row-sub {
                font-size: 13px;
                color: var(--secondary-text-color);
                overflow-wrap: anywhere;
            }
            .row-value {
                font-size: 13px;
                color: var(--secondary-text-color);
                white-space: nowrap;
            }
            /* On a narrow card the value goes under the text, which would otherwise be squeezed to a letter a line. */
            @container card (max-width: 320px) {
                .row {
                    grid-template-columns: auto minmax(0, 1fr);
                    padding: 10px 12px;
                }
                ha-card .unfold-body {
                    padding: 0 12px 12px;
                }
                /* Two columns would leave the value a letter wide; the label goes above its value instead. Through ha-card,
                   so it outranks the table's own rule further down. */
                ha-card .table {
                    grid-template-columns: minmax(0, 1fr);
                    row-gap: 0;
                }
                ha-card .table dd + dt {
                    margin-top: 8px;
                }
                .row-value {
                    grid-column: 2;
                    white-space: normal;
                }
                .list-head {
                    padding: 8px 12px;
                    flex-wrap: wrap;
                    row-gap: 6px;
                }
                ha-card .head h2 {
                    font-size: 16px;
                }
                /* The tag goes under the name and count, which beside it would break a line a word. */
                ha-card .media li {
                    display: grid;
                    grid-template-columns: auto minmax(0, 1fr);
                    row-gap: 0;
                }
                ha-card .media .thumb {
                    grid-row: span 2;
                }
                ha-card .media .tag {
                    grid-column: 2;
                    justify-self: start;
                    margin-top: 4px;
                }
            }
            /* Narrower still, the chip gets a line of its own, so a name never breaks in the middle of a word. */
            @container card (max-width: 220px) {
                .row {
                    grid-template-columns: minmax(0, 1fr);
                }
                .row > .chip,
                .row > .dot {
                    justify-self: start;
                }
                .row-value {
                    grid-column: 1;
                }
            }
            .item {
                border-bottom: 1px solid var(--divider-color);
                transition: background-color 220ms ease;
            }
            /* Marked by a tint and a strip drawn inside, so the row's text keeps its size and its place. */
            .item.open {
                background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
                box-shadow: inset 3px 0 0 var(--item-color);
            }
            .unfold {
                display: grid;
                grid-template-rows: 0fr;
                transition: grid-template-rows 220ms ease;
            }
            .item.open .unfold {
                grid-template-rows: 1fr;
            }
            .unfold-inner {
                overflow: hidden;
                min-height: 0;
            }
            .unfold-body {
                padding: 0 16px 14px;
            }
            .unfold-body > :first-child {
                margin-top: 0;
            }
            @media (prefers-reduced-motion: reduce) {
                .item,
                .unfold {
                    transition: none;
                }
            }

            .legend {
                position: absolute;
                left: 10px;
                top: 10px;
                display: flex;
                flex-wrap: wrap;
                gap: 4px 10px;
                max-width: calc(100% - 70px);
                font-size: 11px;
                padding: 6px 9px;
                border-radius: 8px;
                background: color-mix(in srgb, var(--card-background-color) 90%, transparent);
                color: var(--primary-text-color);
            }
            .legend span {
                display: flex;
                align-items: center;
                gap: 5px;
            }
            .legend i {
                width: 9px;
                height: 9px;
                border-radius: 50%;
            }
            .map-error {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 24px;
                text-align: center;
                color: var(--error-color);
                background: var(--secondary-background-color);
            }
            .hint,
            .problem,
            .loading {
                font-size: 14px;
                color: var(--secondary-text-color);
            }
            .problem {
                color: var(--warning-color);
                margin-bottom: 8px;
            }

            /* markers */
            .feed-marker {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 3px;
                padding: 0;
                border: 1.5px solid rgba(255, 255, 255, 0.8);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
                cursor: pointer;
                font: 700 12px/1 var(--ha-font-family-body, Roboto, sans-serif);
                white-space: nowrap;
            }
            .feed-marker.disc {
                width: 22px;
                height: 22px;
                border-radius: 50%;
            }
            .feed-marker.badge {
                height: 22px;
                padding: 0 7px 0 6px;
                border-radius: 11px;
            }
            /* Larger by its size, never by scale: scale would also multiply the translate MapLibre places it with. */
            .feed-marker.selected {
                border: 2.5px solid #fff;
                box-shadow:
                    0 0 0 2px rgba(0, 0, 0, 0.35),
                    0 2px 8px rgba(0, 0, 0, 0.55);
            }
            .feed-marker.disc.selected {
                width: 28px;
                height: 28px;
            }
            .feed-marker.badge.selected {
                height: 28px;
                padding: 0 9px 0 8px;
                border-radius: 14px;
                font-size: 14px;
            }
            .feed-marker.plain.selected {
                width: 18px;
                height: 18px;
            }
            .feed-marker .glyph {
                width: 12px;
                height: 12px;
            }
            .feed-marker .arrow {
                width: 13px;
                height: 13px;
            }
            .marker-label {
                position: absolute;
                left: calc(100% + 4px);
                top: 50%;
                transform: translateY(-50%);
                padding: 1px 5px;
                border-radius: 4px;
                font: 500 11px/1.4 var(--ha-font-family-body, Roboto, sans-serif);
                color: var(--primary-text-color);
                background: color-mix(in srgb, var(--card-background-color) 85%, transparent);
                white-space: nowrap;
                pointer-events: none;
            }
            .feed-tooltip .maplibregl-popup-content {
                padding: 4px 8px;
                border-radius: 6px;
                font: 13px var(--ha-font-family-body, Roboto, sans-serif);
                color: var(--primary-text-color);
                background: var(--card-background-color);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
            }
            .feed-tooltip .maplibregl-popup-tip {
                display: none;
            }
            .feed-marker.plain {
                width: 14px;
                height: 14px;
            }

            /* details */
            .head {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .head h2 {
                margin: 0;
                flex: 1 1 auto;
                min-width: 0;
                font-size: 18px;
                font-weight: 500;
                line-height: 1.3;
                overflow-wrap: anywhere;
            }
            .chip {
                font-weight: 700;
                font-size: 14px;
                border-radius: 6px;
                padding: 3px 8px;
                white-space: nowrap;
            }
            .dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex: none;
            }
            .age {
                font-size: 12px;
                color: var(--secondary-text-color);
                white-space: nowrap;
            }
            .status,
            .subtitle {
                margin-top: 3px;
                font-size: 13px;
                color: var(--secondary-text-color);
            }
            .media {
                list-style: none;
                margin: 8px 0 0;
                padding: 0;
            }
            .media li {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 7px 0;
                border-bottom: 1px solid var(--divider-color);
            }
            .media .thumb {
                width: 44px;
                height: 44px;
                flex: none;
                padding: 0;
                border: none;
                border-radius: 8px;
                overflow: hidden;
                cursor: zoom-in;
                background: var(--secondary-background-color);
            }
            .media img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }
            .media .text {
                display: flex;
                flex-direction: column;
                flex: 1 1 auto;
                min-width: 0;
            }
            .media .label {
                font-size: 15px;
            }
            .media .value {
                font-size: 13px;
                color: var(--secondary-text-color);
            }
            .table {
                display: grid;
                grid-template-columns: auto minmax(0, 1fr);
                gap: 6px 16px;
                margin: 12px 0 0;
                font-size: 14px;
            }
            .table dt {
                color: var(--secondary-text-color);
            }
            .table dd {
                margin: 0;
                overflow-wrap: anywhere;
            }
            .tag {
                font-size: 11px;
                font-weight: 700;
                border-radius: 6px;
                padding: 3px 7px;
                flex: none;
                white-space: nowrap;
            }
            .tag.warning {
                color: #1c1c1c;
                background: color-mix(in srgb, var(--warning-color, #ffa600) 75%, #fff);
            }
            .tag.info {
                color: #fff;
                background: var(--info-color, #039be5);
            }
            .tag.neutral {
                color: var(--primary-text-color);
                /* A theme's secondary background can be the card's own colour, so the tag is tinted by the text instead. */
                background: color-mix(in srgb, var(--primary-text-color) 14%, transparent);
            }
            .notices {
                margin-top: 12px;
                padding: 8px 12px;
                border-radius: 10px;
                font-size: 14px;
                background: color-mix(in srgb, var(--warning-color, #ffa600) 15%, transparent);
            }
            .notices p {
                margin: 0;
            }
            .notices p + p {
                margin-top: 6px;
            }
            .images {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
                gap: 8px;
                margin-top: 12px;
            }
            figure {
                margin: 0;
            }
            .picture {
                display: block;
                width: 100%;
                padding: 0;
                border: none;
                background: none;
                cursor: zoom-in;
            }
            .picture img {
                width: 100%;
                border-radius: 8px;
                display: block;
            }
            .featured {
                margin-bottom: 12px;
            }
            .featured .picture {
                cursor: zoom-out;
            }
            figcaption {
                margin-top: 4px;
                font-size: 12px;
                color: var(--secondary-text-color);
            }
            .footer {
                margin-top: 12px;
                font-size: 12px;
                color: var(--secondary-text-color);
            }
            .link {
                display: inline-block;
                margin-top: 12px;
                font-size: 14px;
                color: var(--primary-color);
                text-decoration: none;
            }
        `,
    ];
}

declare global {
    interface HTMLElementTagNameMap {
        "map-feed-card": MapFeedCard;
    }
}
