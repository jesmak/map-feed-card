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
    isMapFeed,
    kindFamily,
    type FeedImage,
    type FeedItem,
    type FeedList,
    type FeedPoint,
    type LngLat,
    type LegendEntry,
} from "./feed";
import type { HomeAssistant } from "./hass";
import { rowOf, sortOptions, sortRows, startingSort } from "./list";
import { browserLanguage, translate } from "./localize/localize";
import { FeedMap, type DrawnArea, type DrawnPoint, type DrawnShape, type MapContent } from "./map";
import { ensureToken } from "./map-tiles";
import { readThemeColors } from "./map-theme";
import { parseOptions, type CardOptions, type FeedOptions } from "./options";
import { areaColor, canBeLate, DELAY_COLORS, pointColor, shapeColor, textOn } from "./style";

/** Replaced at build time with the version in package.json. */
declare const __CARD_VERSION__: string;

/** How often the ages in the details are redrawn, between the feeds' own updates. */
const TICK_MS = 30_000;

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
    @query(".map") private mapElement?: HTMLElement;

    private map?: FeedMap;
    private mapStarting = false;
    private fitted = false;
    private view?: View;
    private readonly loader = new DetailLoader();
    private ticker?: ReturnType<typeof setInterval>;
    private resizer?: ResizeObserver;
    /** Set when a marker is tapped, so the list scrolls to its row once it is drawn. */
    private scrollToSelected = false;

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
        this.ticker = setInterval(() => this.selected && this.requestUpdate(), TICK_MS);
        this.resizer = new ResizeObserver(([entry]) => {
            this.wide = (entry?.contentRect.width ?? 0) >= WIDE_PX;
            this.map?.resize();
        });
        this.resizer.observe(this);
        // A card moved on the page, as the dashboard's edit mode does, lost its map; shouldUpdate would wait for a feed to change.
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
            this.loader.load(selected.point, this.hass, selected.feed.entity, () => this.requestUpdate());
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

    private details(selected: ViewItem): TemplateResult {
        return renderDetails({
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
        const count =
            counts.size === 1 && lists[0]?.count ? `${entries.length} ${lists[0].count}` : this.text("list.count", { n: entries.length });
        return html`<div class="list">
            <div class="list-head">
                ${title ? html`<h1 class="list-title">${title}</h1>` : html`<span class="count">${count}</span>`}
                ${
                    options.length
                        ? html`<label class="sort">
                              <select
                                  aria-label=${this.text("list.sort")}
                                  @change=${(event: Event) => (this.sortKey = (event.target as HTMLSelectElement).value)}
                              >
                                  ${options.map((option) => html`<option value=${option.key} ?selected=${option.key === key}>${option.label}</option>`)}
                              </select>
                              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                          </label>`
                        : nothing
                }
            </div>
            <div class="rows">
                ${view?.problems.map((problem) => html`<div class="problem">${problem}</div>`)}
                ${entries.map((entry) => (entry.key === this.selected ? this.openRow(entry) : this.row(entry)))}
            </div>
        </div>`;
    }

    private row(entry: ViewItem & { key: string }): TemplateResult {
        const row = rowOf(entry.item, entry.point, (key, values) => this.text(key, values));
        const valueStyle = row.valueIsDelay ? `color:color-mix(in srgb, ${entry.color} 70%, var(--primary-text-color))` : "";
        return html`<button class="row" data-key=${entry.key} @click=${() => this.select(entry.key)}>
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

    /** The selected row, opened in place to its details; its head closes it again. */
    private openRow(entry: ViewItem & { key: string }): TemplateResult {
        return html`<div
            class="open"
            data-key=${entry.key}
            style="--item-color:${entry.color}"
            @click=${(event: Event) => (event.target as Element).closest(".head") && this.select(null)}
        >
            ${this.details(entry)}
        </div>`;
    }

    protected updated(): void {
        if (this.scrollToSelected) {
            this.scrollToSelected = false;
            this.revealRow();
        }
        if (!this.map && !this.mapStarting && this.mapElement && this.hass && this.options) void this.startMap();
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
        const map = new FeedMap(this.mapElement!, this.options!.mapStyle, this.dark(), this.themeColors(), (key) => this.select(key, true));
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
            this.mapError = error instanceof Error ? error.message : String(error);
            console.error("map-feed-card:", error);
        } finally {
            this.mapStarting = false;
        }
    }

    /** fromMap: a marker or shape was tapped, so the list scrolls to its row; a row tapped moves the map instead. */
    private select(key: string | null, fromMap = false): void {
        if (key === this.selected) return;
        this.selected = key;
        this.featured = null;
        const position = key ? this.view?.items.get(key)?.point : null;
        if (position) this.map?.reveal([position.lon, position.lat]);
        this.renderRoot.querySelector(".panel")?.scrollTo({ top: 0 });
        this.scrollToSelected = fromMap;
    }

    /** Scrolls the list, and only the list, so the selected row starts at its top. */
    private revealRow(): void {
        const rows = this.renderRoot.querySelector<HTMLElement>(".rows");
        const row = this.selected ? rows?.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.selected)}"]`) : null;
        if (!rows || !row) return;
        rows.scrollTo({ top: row.offsetTop - rows.offsetTop, behavior: "smooth" });
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
            let byDelay = false;
            let ownColours = false;
            for (const point of points) {
                if (feed.maxAgeMinutes !== null && point.updatedMs !== null && now - point.updatedMs > feed.maxAgeMinutes * 60_000)
                    continue;
                const drawn: DrawnPoint = {
                    key: `${feed.entity}|${point.id}`,
                    point,
                    color: pointColor(point, feed.colorBy, feed.delayThresholds),
                    label: feed.labels ? point.label || point.name : "",
                };
                if (feed.colorBy === "delay" && canBeLate(point)) byDelay = true;
                else {
                    ownColours = true;
                    if (!result.feed.legend.length && point.color === null) addKind(point, drawn.color);
                }
                pointKeys.set(point.id, drawn);
                view.content.points.push(drawn);
                view.items.set(drawn.key, { item: point, point, color: drawn.color, feed, list });
                view.extent.push([point.lon, point.lat]);
            }
            for (const shape of shapes) {
                const owner = shape.pointId ? pointKeys.get(shape.pointId) : undefined;
                // A shape whose point was hidden by its age goes with it.
                if (shape.pointId && !owner && points.some((point) => point.id === shape.pointId)) continue;
                const key = `${feed.entity}|${shape.id}`;
                const drawn: DrawnShape = {
                    key,
                    selects: owner?.key ?? key,
                    shape,
                    color: owner?.color ?? shapeColor(shape),
                    name: shape.name || owner?.point.name || "",
                };
                view.content.shapes.push(drawn);
                if (!owner) {
                    view.items.set(key, { item: shape, point: null, color: drawn.color, feed, list });
                    ownColours = true;
                    if (!result.feed.legend.length && shape.color === null) addKind(shape, drawn.color);
                }
            }
            if (area && feed.showArea)
                view.content.areas.push({ area, color: feed.areaColor ?? areaColor(this.dark()) } satisfies DrawnArea);
            // The feed's area frames the map best; without one, everything in the feed does.
            if (area) view.extent.push(...areaOutline(area));
            if (attribution) view.content.attributions.push(attribution);
            // The delay classes explain what is coloured by delay, the feed's legend what keeps the feed's own colours.
            for (const legend of [byDelay ? this.delayLegend(feed) : [], ownColours ? result.feed.legend : []]) {
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
    private delayLegend(feed: FeedOptions): LegendEntry[] {
        const [late, veryLate] = feed.delayThresholds;
        return [
            { color: DELAY_COLORS.on_time, label: this.text("legend.on_time") },
            { color: DELAY_COLORS.late, label: this.text("legend.late", { n: late }) },
            { color: DELAY_COLORS.very_late, label: this.text("legend.late", { n: veryLate }) },
        ];
    }

    private legend(entries: LegendEntry[]): TemplateResult {
        return html`<div class="legend">
            ${entries.map((entry) => html`<span><i style="background:${entry.color}"></i>${entry.label}</span>`)}
        </div>`;
    }

    private problem(entity: string, status: "missing" | "unavailable" | "not_a_feed" | "unsupported_version"): string {
        if (status === "missing") return `${this.text("common.no_entity")} ${entity}`;
        return `${entity} ${this.text(`common.${status}`)}`;
    }

    /** Read inside the card's shadow root: a probe in the card's own light DOM isn't rendered, so the browser computes nothing for it. */
    private themeColors(): Record<string, string> | null {
        const card = this.renderRoot?.querySelector?.("ha-card");
        return card instanceof HTMLElement ? readThemeColors(card) : null;
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
            .sort {
                position: relative;
                display: flex;
                align-items: center;
                flex: 0 1 auto;
                min-width: 0;
                margin-left: auto;
            }
            .sort select {
                appearance: none;
                min-width: 0;
                max-width: 100%;
                text-overflow: ellipsis;
                height: 32px;
                padding: 0 30px 0 12px;
                border-radius: 16px;
                border: 1px solid var(--divider-color);
                background: transparent;
                color: var(--primary-text-color);
                font: 500 13px var(--ha-font-family-body, Roboto, sans-serif);
                cursor: pointer;
            }
            .sort select option {
                color: var(--primary-text-color);
                background: var(--card-background-color);
            }
            .sort svg {
                position: absolute;
                right: 10px;
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
                border-bottom: 1px solid var(--divider-color);
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
                .row-value {
                    grid-column: 2;
                    white-space: normal;
                }
                .list-head {
                    padding: 8px 12px;
                    flex-wrap: wrap;
                    row-gap: 6px;
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
            .open {
                padding: 12px 16px 14px 13px;
                border-left: 3px solid var(--item-color);
                border-bottom: 1px solid var(--divider-color);
                background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
            }
            .open .head {
                cursor: pointer;
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
