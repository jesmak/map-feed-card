/**
 * A dashboard card that draws map feeds (docs/map-feed-format.md) on Home Assistant's own map, with the selected
 * item's details in a sheet over the bottom of the map, or in a panel beside it when the card is wide.
 */
import { LitElement, css, html, nothing, unsafeCSS } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?raw";

import { DetailLoader, renderDetails, tagOf } from "./details";
import "./editor";
import { ScrollFade, fadeStyles } from "./fade";
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
    type FeedShape,
    type LngLat,
    type LegendEntry,
} from "./feed";
import { entityName, type HomeAssistant } from "./hass";
import { gridMinRows, heightCardSize, heightStyle, validHeight } from "./height";
import { drawnScale, fillLimit, filledHeight, filledStyle, validRowStep, type RowStepConfig } from "./rows";
import { countText, rowOf, sortOptions, sortRows, startingSort, type Row } from "./list";
import { browserLanguage, translate } from "./localize/localize";
import { FeedMap, type Covered, type DrawnArea, type DrawnPoint, type DrawnShape, type MapContent } from "./map";
import { ensureToken, MapError } from "./map-tiles";
import { readThemeColors } from "./map-theme";
import { parseOptions, type CardOptions, type FeedOptions, type MapView } from "./options";
import { areaColor, canBeLate, DELAY_COLORS, delayClass, escapeHtml, pointColor, shapeColor, textOn } from "./style";

/** Replaced at build time with the version in package.json. */
declare const __CARD_VERSION__: string;

/** How often the ages in the details are redrawn, between the feeds' own updates. */
const TICK_MS = 30_000;

/** How long a row's details take to unfold or fold away, as in the styles. */
const UNFOLD_MS = 220;

/** How long after a row was opened content that grows is still fitted into view. */
const FIT_GROWTH_MS = 3000;

/** From this width the details go beside the map instead of over it. */
const WIDE_PX = 640;

/** How much of the map the details' sheet leaves clear above it, for the item it shows. */
const SHEET_CLEAR_PX = 96;
/** Held to a height, the least the map keeps when it gives way, so the details' sheet still has room over it. */
const MAP_MIN_PX = 200;
/**
 * Held to a height with the list below the map, the least the list keeps: its border, its header and room below them for
 * the rows to scroll.
 */
const LIST_MIN_PX = 163;
/**
 * The least room a list under the map needs for an item's details to unfold in it, under their row: an aircraft's with
 * its picture are about 360 px, with the row and the list's header besides. In a shorter list a row only selects, and
 * its details open over the whole card from a button on the selected row.
 */
const DETAILS_IN_LIST_MIN_PX = 400;
/** The card's title, with its padding, on the one line a held card keeps it to. */
const TITLE_PX = 48;
/** The card's border, above and below. */
const BORDER_PX = 2;

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
    /** A feed's items are in the extent by `frame: items`, which zooms in less far. */
    framedByItems: boolean;
}

/** A list row that doesn't fit on one line: its value under its texts, or its chip on a line of its own as well. */
export type RowSplit = "under" | "apart";

/** Whether a row's texts overflow their room, measured with their words whole. */
function rowOverflows(row: HTMLElement): boolean {
    return [...row.querySelectorAll<HTMLElement>(".row-title, .row-sub, .row-value")].some((text) => text.scrollWidth > text.clientWidth);
}

/**
 * Whether a row plainly needs no split, read as it is drawn: it has none, nothing in it overflows and each of its texts
 * is on one line. No word was broken to get them there, so they fit whole, and with its value under them the row could
 * only be taller. Reading changes nothing, where measuring lays the row out twice.
 */
function fitsOnOneLine(row: HTMLElement): boolean {
    if (row.classList.contains("under") || row.classList.contains("apart") || rowOverflows(row)) return false;
    const range = document.createRange();
    return [...row.querySelectorAll(".row-title, .row-sub")].every((text) => {
        range.selectNodeContents(text);
        return range.getClientRects().length === 1;
    });
}

/** What the list's rows were measured as: the list's width then, and each row's texts and room and its split, by its item's key. */
export interface RowMeasures {
    width: number;
    texts: Map<string, string>;
    splits: Map<string, RowSplit>;
}

/**
 * Lays out the list's rows by what fits, by the key of their item. A row keeps its value beside its texts while no
 * word in them breaks and the row is no taller than with the value under them, as squeezed beside it the texts would
 * take a line a word. One that doesn't puts its value under its texts, and one whose words don't fit even so puts its
 * chip on a line of its own too. Each item is held to the height it is drawn at while its row is measured, so the
 * list doesn't change height for a moment and scroll back.
 *
 * A long list is measured as little as it can be, as measuring lays each row out twice. With the measures of `last`, a
 * row with the same texts and room in a list of the same width keeps its split, and a row that plainly fits on one line
 * isn't measured either.
 */
export function splitRows(card: HTMLElement, last?: RowMeasures): RowMeasures {
    const measures: RowMeasures = {
        width: card.querySelector<HTMLElement>(".list")?.clientWidth ?? 0,
        texts: new Map(),
        splits: new Map(),
    };
    const rows: HTMLElement[] = [];
    for (const row of card.querySelectorAll<HTMLElement>(".list .row")) {
        const item = row.closest<HTMLElement>(".item");
        const key = item?.dataset.key;
        // A row picked in a compact list has less room, as its details button is beside it.
        const text = `${row.textContent}|${item?.classList.contains("picked")}`;
        if (key !== undefined) measures.texts.set(key, text);
        if (key !== undefined && last?.width === measures.width && last.texts.get(key) === text) {
            if (last.splits.has(key)) measures.splits.set(key, last.splits.get(key)!);
        } else if (!fitsOnOneLine(row)) {
            rows.push(row);
        }
    }
    if (!rows.length) return measures;

    const items = rows.map((row) => row.closest<HTMLElement>(".item"));
    // Their layout height, not the drawn one, which a dialog opening with a scale shrinks.
    const heights = items.map((item) => (item ? getComputedStyle(item).height : ""));
    items.forEach((item, index) => item?.style.setProperty("height", heights[index]));
    card.toggleAttribute("data-measuring", true);
    rows.forEach((row) => {
        row.classList.add("measuring");
        row.classList.remove("under", "apart");
    });
    const beside = rows.map((row) => ({ over: rowOverflows(row), height: row.offsetHeight }));
    rows.forEach((row) => row.classList.add("under"));
    const under = rows.map((row) => ({ over: rowOverflows(row), height: row.offsetHeight }));
    rows.forEach((row, index) => {
        row.classList.remove("under", "measuring");
        const split = !beside[index].over && beside[index].height <= under[index].height ? null : under[index].over ? "apart" : "under";
        const key = items[index]?.dataset.key;
        if (split) row.classList.add(split);
        if (split && key) measures.splits.set(key, split);
    });
    card.toggleAttribute("data-measuring", false);
    items.forEach((item) => item?.style.removeProperty("height"));
    return measures;
}

/** Home's surroundings, a region rather than streets, while nothing frames the map and it has no start view. */
const HOME_ZOOM = 9;

@customElement("map-feed-card")
export class MapFeedCard extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    /** "grid" in a sections view, where the rows set in its layout tab hold the card to a height. */
    @property({ attribute: false }) public layout?: string;
    @state() private options?: CardOptions;
    /** The configuration as written, for the height's options. */
    private config: RowStepConfig = {};
    @state() private selected: string | null = null;
    @state() private featured: FeedImage | null = null;
    @state() private mapError = "";
    @state() private wide = false;
    /** On automatic rows in a sections view, the height that ends the card on a whole row; 0 when it isn't set. */
    @state() private filled = 0;
    private frame?: number;
    /** The list's order as chosen on the card; undefined until someone chooses. */
    @state() private sortKey?: string | null;
    /** The rows whose details are folding away; several, when rows are tapped one after another. */
    @state() private closing: ReadonlySet<string> = new Set();
    /** The list under the map is too short for details to unfold in it, so they open over the card instead. */
    @state() private compact = false;
    /** In a compact list, whether the selected item's details are open over the card. */
    @state() private overlayOpen = false;
    /** The theme's map colours, and the theme they were read for. */
    private theme?: { key: string; colors: Record<string, string> | null };
    /** When the selection changed, so content that grows soon after is fitted, but not once the list has been scrolled away. */
    private selectedAt = 0;
    @query(".map") private mapElement?: HTMLElement;

    private map?: FeedMap;
    private mapStarting = false;
    private fitted = false;
    /** The configuration's start view has changed, and the map, when nothing frames it, is to go there. */
    private startChanged = false;

    /** Where the card's map is now, for the editor's button that saves its preview's view. */
    public get mapView(): MapView | null {
        return this.map?.view ?? null;
    }
    private view?: View;
    private readonly loader = new DetailLoader();
    private ticker?: ReturnType<typeof setInterval>;
    /** Set by the tick when a feed has max_age_minutes, so the view is built again to drop what has aged out. */
    private ageing = false;
    private resizer?: ResizeObserver;
    /** Set when something is selected, so the list scrolls its row into view once it is drawn. */
    private fitSelected = false;
    /**
     * Set when anything may have moved the selected item out of view or under the details' sheet: a tap, the item
     * moving, the sheet or the card changing size, the map starting or framing itself. The map then shows the item,
     * unless someone has moved it since the tap.
     */
    private revealSelected = false;
    /** Where the selected item was when the map was last asked to show it, so its moving asks again. */
    private shownAt = "";
    /** The details' sheet whose size is followed, so the item is kept clear of it as the sheet changes size. */
    private sheetElement?: HTMLElement;
    private sheetResizer?: ResizeObserver;
    /** The rows last measured too wide for one line, so a render never drops a split. */
    private rowMeasures?: RowMeasures;
    /** The rows' texts may have changed since their splits were measured: the feeds, the options or the ages they show. */
    private rowsStale = true;
    /** The next frame measures the rows' splits, as an update or a new size asked for it. */
    private splitDue = false;

    constructor() {
        super();
        // The list fades while the card is held to a height.
        new ScrollFade(this, () => (this.heightStyle() ? this.renderRoot.querySelectorAll<HTMLElement>(".list .rows") : []));
    }

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
        if (!validHeight(config as RowStepConfig)) {
            throw new Error("height and max_height must be positive numbers of pixels, and height_mode auto, fixed or max");
        }
        if (!validRowStep(config as RowStepConfig)) {
            throw new Error("row_step must be full or half");
        }
        this.config = config as RowStepConfig;
        const previous = this.options;
        this.options = options;
        if (previous && previous.feeds.map((feed) => feed.entity).join() !== options.feeds.map((feed) => feed.entity).join()) {
            this.fitted = false;
        }
        if (previous && JSON.stringify(previous.start) !== JSON.stringify(options.start)) this.startChanged = true;
        void this.map?.setStyle(options.mapStyle, this.dark(), this.themeColors());
    }

    public getCardSize(): number {
        const list = this.options?.list ? this.options.listHeight : 0;
        return heightCardSize(this.config, Math.ceil(((this.options?.mapHeight ?? 300) + list) / 50) + 3, this.minimumHeight());
    }

    public getGridOptions(): Record<string, unknown> {
        return { columns: "full", min_columns: 6, rows: "auto", min_rows: gridMinRows(this.minimumHeight()) };
    }

    /**
     * Held to a height, the border, the title and the map with room for the details' sheet still fit, and with the list,
     * the list's header with room for the rows to scroll under it. The list under the map is the narrow layout's, the taller
     * of the two, and the one counted: the config doesn't say how wide a card of "full" columns is, and the same rows
     * hold it on a phone too. A held card keeps its title and the list's header to one line, so this holds at any width.
     */
    private minimumHeight(): number {
        const title = this.options?.title ? TITLE_PX : 0;
        return BORDER_PX + title + MAP_MIN_PX + (this.options?.list ? LIST_MIN_PX : 0);
    }

    private heightStyle(): string {
        return heightStyle(this.config, this.layout, this.minimumHeight());
    }

    public connectedCallback(): void {
        super.connectedCallback();
        // Ages are drawn in the details, and in every row of the list, so they are redrawn between the feeds' updates.
        // An item past its feed's max_age_minutes leaves the map then too, however quiet the feed.
        this.ticker = setInterval(() => {
            this.ageing = this.options?.feeds.some((feed) => feed.maxAgeMinutes !== null) ?? false;
            if (this.options?.list) this.rowsStale = true;
            if (this.ageing || this.selected || this.options?.list) this.requestUpdate();
        }, TICK_MS);
        this.resizer = new ResizeObserver(([entry]) => {
            this.wide = (entry?.contentRect.width ?? 0) >= WIDE_PX;
            // The map follows its own size (map.ts). A new size, or the details moving between the sheet and the panel, can hide the selected item.
            if (this.selected) {
                this.revealSelected = true;
                this.requestUpdate();
            }
            this.fitLegend();
            this.fillRowsSoon();
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
        cancelAnimationFrame(this.frame ?? 0);
        this.resizer?.disconnect();
        this.sheetResizer?.disconnect();
        this.sheetElement = undefined;
        this.map?.destroy();
        this.map = undefined;
        this.fitted = false;
    }

    protected shouldUpdate(changed: PropertyValues): boolean {
        const previous = changed.get("hass") as HomeAssistant | undefined;
        if (!previous || changed.size > 1 || !changed.has("hass") || !this.options) return true;
        // Home Assistant hands the card every state change in the house; only its own feeds, the language and the theme matter.
        return (
            previous.locale !== this.hass?.locale ||
            previous.language !== this.hass?.language ||
            previous.themes?.darkMode !== this.hass?.themes?.darkMode ||
            // Another theme can paint the map in other colours (map-theme.ts).
            previous.themes?.theme !== this.hass?.themes?.theme ||
            previous.selectedTheme !== this.hass?.selectedTheme ||
            this.options.feeds.some(({ entity }) => previous.states[entity] !== this.hass?.states[entity])
        );
    }

    protected willUpdate(changed: PropertyValues): void {
        if (this.ageing || changed.has("hass") || changed.has("options")) {
            this.view = this.buildView();
            this.rowsStale = true;
        }
        this.ageing = false;
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
        const held = this.heightStyle();
        return html`
            <ha-card
                class=${classMap({ wide: this.wide, "with-list": list, dark: this.dark(), held: !!held, growing: held.startsWith("max-height"), filled: !!this.filled })}
                style="--map-height:${this.options.mapHeight}px;--list-height:${this.options.listHeight}px;${filledStyle(this.config, this.layout, this.minimumHeight(), this.filled)}"
            >
                ${title && !titleInList ? html`<h1 class="card-title">${title}</h1>` : nothing}
                <div class="body">
                    <div class="map-wrap">
                        <div class="map"></div>
                        ${this.options.legend && view?.legend.length ? this.legend(view.legend) : nothing}
                        ${this.mapError ? html`<div class="map-error">${this.mapError}</div>` : nothing}
                        ${!list && !this.wide ? this.sheet(view, selected) : nothing}
                        ${
                            // Without the view, so the problems the list already shows aren't shown twice.
                            list && selected && !selected.feed.inList ? this.sheet(undefined, selected) : nothing
                        }
                    </div>
                    ${
                        list
                            ? this.renderList(view, titleInList ? title : "")
                            : !this.wide
                              ? nothing
                              : html`<div class="panel">
                                    ${view?.problems.map((problem) => html`<div class="problem">${problem}</div>`)}
                                    ${
                                        selected
                                            ? this.details(selected)
                                            : html`<div class="hint">
                                                  ${this.text(view?.items.size ? "common.select_hint" : "common.nothing_to_show")}
                                              </div>`
                                    }
                                </div>`
                    }
                </div>
                ${this.compact && this.overlayOpen && selected ? this.overlay(selected) : nothing}
            </ha-card>
        `;
    }

    /**
     * Narrow and without the list, the details go in a sheet over the bottom of the map, so the card keeps its size;
     * with nothing selected, a note on the map says what to do, or what is wrong with a feed. With the list, an item of
     * a feed kept out of it has no row to open, so its details go in the sheet too.
     */
    private sheet(view: View | undefined, selected: ViewItem | undefined): TemplateResult {
        const problems = view?.problems.map((problem) => html`<div class="problem">${problem}</div>`);
        if (!selected) {
            return html`<div class="map-note">
                ${problems}${view?.items.size ? html`<div class="hint">${this.text("common.select_hint")}</div>` : nothing}
                ${!view?.items.size && !view?.problems.length ? html`<div class="hint">${this.text("common.nothing_to_show")}</div>` : nothing}
            </div>`;
        }
        return html`<div class="sheet">
            <button class="sheet-close" @click=${() => this.select(null)} aria-label=${this.text("common.close_details")}>×</button>
            ${problems}${this.details(selected)}
        </div>`;
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
            onImage: (image) => {
                this.featured = image;
                // The picture opens at the top of the details, so they are scrolled there to show it.
                if (image) this.renderRoot.querySelector(".sheet, .panel, .overlay-body")?.scrollTo({ top: 0 });
            },
            text: (key, values) => this.text(key, values),
        });
    }

    private renderList(view: View | undefined, title: string): TemplateResult {
        const lists = view?.lists ?? [];
        const options = sortOptions(lists);
        const key = this.sortKey !== undefined ? this.sortKey : startingSort(this.options!.sort, lists);
        const entries = sortRows(
            [...(view?.items ?? [])].filter(([, entry]) => entry.feed.inList).map(([itemKey, entry]) => ({ ...entry, key: itemKey })),
            key,
            this.language(),
        );
        const number = countText(entries.length, lists, (key, values) => this.text(key, values));
        // A single feed says what the items are, by its sensor's name.
        const feeds = this.options!.feeds;
        const name = feeds.length === 1 ? entityName(this.hass, this.hass?.states[feeds[0]!.entity]) : "";
        const count = name ? `${name} · ${number}` : number;
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
     * row itself stays as it is, so nothing in the list moves but the details. In a compact list the selected row only
     * shows it is selected, with a button beside it that opens its details over the card.
     */
    private listItem(entry: ViewItem & { key: string }): TemplateResult {
        const picked = entry.key === this.selected;
        const open = picked && !this.compact;
        const shown = open || (!this.compact && this.closing.has(entry.key));
        const row = rowOf(entry.item, entry.point, (key, values) => this.text(key, values));
        return html`<div class="item ${open ? "open" : picked ? "picked" : ""}" data-key=${entry.key} style="--item-color:${entry.color}">
            <div class="item-line">
                ${this.row(entry, row, open)}
                ${
                    picked && this.compact
                        ? html`<button
                              class="details-button"
                              @click=${() => this.openOverlay()}
                              aria-label=${this.text("list.show_details")}
                              title=${this.text("list.show_details")}
                          >
                              <ha-icon icon="mdi:information-outline"></ha-icon>
                          </button>`
                        : nothing
                }
            </div>
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
        return html`<button
            class="row ${this.rowMeasures?.splits.get(entry.key) ?? ""}"
            aria-expanded=${this.compact ? nothing : open ? "true" : "false"}
            aria-pressed=${this.compact ? (entry.key === this.selected ? "true" : "false") : nothing}
            @click=${() => this.select(entry.key === this.selected ? null : entry.key)}
        >
            ${
                entry.point?.badge
                    ? html`<span class="chip" style="background:${entry.color};color:${textOn(entry.color)}">${entry.point.badge}</span>`
                    : html`<span class="dot" style="background:${entry.color};opacity:${entry.item.opacity}"></span>`
            }
            <span class="row-text">
                <span class="row-title">${row.title}</span>
                ${row.text ? html`<span class="row-sub">${row.text}</span>` : nothing}
            </span>
            ${
                row.tag || row.value
                    ? html`<span class="row-side">
                          ${row.tag ? tagOf(row.tag, entry.color) : nothing}
                          ${row.value ? html`<span class="row-value" style=${valueStyle}>${row.value}</span>` : nothing}
                      </span>`
                    : nothing
            }
        </button>`;
    }

    protected updated(changed: PropertyValues): void {
        this.fitLegend();
        // The rows are measured when their texts or their room may have changed, not on every update: a selection alone
        // changes neither, and measuring a long list takes longer than the fold it would run in. In a compact list the
        // selected row gives room to its details button.
        const rowsChanged = this.rowsStale || changed.has("wide") || changed.has("compact") || (this.compact && changed.has("selected"));
        this.rowsStale = false;
        // At once, so a new row is never drawn unmeasured, and again on the frame, as a change of size comes there.
        if (rowsChanged) this.splitRows();
        this.fillRowsSoon(rowsChanged);
        if (this.fitSelected) {
            this.fitSelected = false;
            this.fitRow();
        }
        // A map that failed isn't tried again on every update of a feed, only when the card is connected again.
        if (!this.map && !this.mapStarting && !this.mapError && this.mapElement && this.hass && this.options) void this.startMap();
        this.followSheet();
        if (!this.map || !this.view) return;
        void this.map.setStyle(this.options!.mapStyle, this.dark(), this.themeColors());
        this.map.update({ ...this.view.content, selected: this.selected });
        // A fit waits for something to frame, but not past a move: a feed left out of the framing may be what is being read.
        if (!this.fitted && this.map.moved) this.fitted = true;
        if (!this.fitted) {
            const bounds = boundsOf(this.view.extent);
            if (bounds) {
                this.map.fit(bounds, this.view.framedByItems, () => this.covered());
                this.fitted = true;
                // The framing may have moved the selected item out of view, or under the sheet.
                this.revealSelected = true;
            }
        }
        if (this.startChanged) {
            this.startChanged = false;
            if (this.options!.start && this.view.extent.length === 0) this.map.show(this.options!.start);
        }
        const selected = this.selected ? this.view.items.get(this.selected) : undefined;
        const position = selected?.point;
        const at = position ? `${position.lon},${position.lat}` : "";
        // A selected item that moves, such as a train, is followed.
        if (at !== this.shownAt) this.revealSelected = true;
        // After the framing above, which a move would otherwise stop: a tap while the map was starting waited for the map.
        if (this.revealSelected) {
            this.revealSelected = false;
            this.shownAt = at;
            const covered = this.sheetElement?.offsetHeight ?? 0;
            // A line or area of its own has no point, and is shown by its bounds.
            const bounds = selected && !position ? boundsOf(shapePositions(selected.item as FeedShape)) : null;
            if (position) this.map.reveal([position.lon, position.lat], covered);
            else if (bounds) this.map.revealShape(bounds, covered);
        }
    }

    private fillRowsSoon(split = true): void {
        // A frame put off by a newer one still owes its measuring.
        this.splitDue ||= split;
        cancelAnimationFrame(this.frame ?? 0);
        this.frame = requestAnimationFrame(() => {
            if (this.splitDue) this.splitRows();
            this.splitDue = false;
            this.measureList();
            this.fillRows();
        });
    }

    /** A hidden card measures nothing and keeps its splits until it is shown, as its size changes then. */
    private splitRows(): void {
        const card = this.renderRoot.querySelector<HTMLElement>("ha-card");
        if (card?.clientWidth) this.rowMeasures = splitRows(card, this.rowMeasures);
    }

    /**
     * Whether the list under the map has room for details to unfold in it. Held to a height, the list's room is its own
     * height, which the card's height gives it and its rows don't change; otherwise it grows with its rows up to
     * `list_height`, which is its room. A list beside the map is the card's whole height, so details always unfold there.
     * A hidden card measures nothing.
     */
    private measureList(): void {
        const list = this.renderRoot.querySelector<HTMLElement>(".list");
        if (!list || !this.options?.list || this.wide) {
            this.setCompact(false);
            return;
        }
        if (!list.clientWidth) return;
        const room = this.heightStyle() ? list.getBoundingClientRect().height : this.options.listHeight;
        this.setCompact(room < DETAILS_IN_LIST_MIN_PX);
    }

    /** Switching, an item whose details are open keeps them open in their new place: unfolded, or over the card. */
    private setCompact(compact: boolean): void {
        if (compact === this.compact) return;
        this.compact = compact;
        this.overlayOpen = compact && this.selected !== null;
    }

    private openOverlay(): void {
        this.overlayOpen = true;
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".overlay-close")?.focus());
    }

    /** Closed, the focus goes back to the button that opened the details. */
    private closeOverlay(): void {
        this.overlayOpen = false;
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".item.picked .details-button")?.focus());
    }

    /** An item's details over the whole card, from a compact list's button: its title, a close button and the details. */
    private overlay(selected: ViewItem): TemplateResult {
        const row = rowOf(selected.item, selected.point, (key, values) => this.text(key, values));
        return html`<div
            class="overlay"
            role="dialog"
            aria-modal="true"
            aria-label=${row.title}
            @keydown=${(event: KeyboardEvent) => event.key === "Escape" && this.closeOverlay()}
        >
            <div class="overlay-head">
                <span class="overlay-title">${row.title}</span>
                <button
                    class="sheet-close overlay-close"
                    @click=${() => this.closeOverlay()}
                    aria-label=${this.text("common.close_details")}
                >
                    ×
                </button>
            </div>
            <div class="overlay-body">${this.details(selected, row)}</div>
        </div>`;
    }

    /**
     * On automatic rows in a sections view, the card takes the whole rows its content needs, or the half rows with
     * `row_step: half`, so the cards under it stay on the rows, up to the limit of a card that grows up to one. The map takes the height added, beside the list too, so what it has grown past its own height is left
     * out of the measure, or a card whose list below the map gets shorter would keep the rows it no longer needs.
     */
    private fillRows(): void {
        const card = this.renderRoot.querySelector<HTMLElement>("ha-card");
        const grown = this.renderRoot.querySelector<HTMLElement>(this.wide ? ".body" : ".map-wrap");
        const limit = fillLimit(this.config, this.layout, this.minimumHeight());
        if (!card || !grown || !card.clientWidth || !this.options || !limit) {
            if (this.filled) this.filled = 0;
            return;
        }
        // Drawn heights unscaled, as the map's own height is the layout's.
        const scale = drawnScale(card);
        const content =
            card.getBoundingClientRect().height / scale -
            Math.max(0, grown.getBoundingClientRect().height / scale - this.options.mapHeight);
        const filled = filledHeight(content, this.config, limit);
        if (filled !== this.filled) this.filled = filled;
    }

    /** How far the legend and the note over the map reach into it, so a fit keeps the items at its edges clear of them. */
    private covered(): Covered {
        const wrap = this.renderRoot.querySelector<HTMLElement>(".map-wrap");
        const legend = this.renderRoot.querySelector<HTMLElement>(".map-wrap > .legend");
        const note = this.renderRoot.querySelector<HTMLElement>(".map-wrap > .map-note");
        return {
            top: legend ? legend.offsetTop + legend.offsetHeight : 0,
            bottom: wrap && note ? wrap.clientHeight - note.offsetTop : 0,
        };
    }

    /** Follows the details' sheet's size, which changes as its pictures load, so the item is kept clear of it. */
    private followSheet(): void {
        const sheet = this.renderRoot.querySelector<HTMLElement>(".sheet") ?? undefined;
        if (sheet === this.sheetElement) return;
        if (this.sheetElement) this.sheetResizer?.unobserve(this.sheetElement);
        this.sheetElement = sheet;
        if (!sheet) return;
        this.sheetResizer ??= new ResizeObserver(() => {
            this.revealSelected = true;
            this.requestUpdate();
        });
        this.sheetResizer.observe(sheet);
    }

    private async startMap(): Promise<void> {
        this.mapStarting = true;
        const { latitude, longitude } = this.hass!.config ?? {};
        const home: MapView | null =
            typeof latitude === "number" && typeof longitude === "number" ? { center: [longitude, latitude], zoom: HOME_ZOOM } : null;
        const locale = {
            "CooperativeGesturesHandler.WindowsHelpText": this.text("gestures.windows"),
            "CooperativeGesturesHandler.MacHelpText": this.text("gestures.mac"),
            "CooperativeGesturesHandler.MobileHelpText": this.text("gestures.mobile"),
            "NavigationControl.ZoomIn": this.text("controls.zoom_in"),
            "NavigationControl.ZoomOut": this.text("controls.zoom_out"),
        };
        const map = new FeedMap(
            this.mapElement!,
            this.options!.mapStyle,
            this.dark(),
            this.themeColors(),
            (key) => this.select(key),
            locale,
            this.options!.start ?? home,
        );
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
        if (key === this.selected) {
            // Tapping the selected item again shows it again, wherever the map or the list had been moved to.
            if (key !== null) {
                this.map?.tapped();
                this.revealSelected = true;
                this.fitSelected = true;
                this.requestUpdate();
            }
            return;
        }
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
        this.overlayOpen = false;
        this.featured = null;
        this.revealSelected = key !== null;
        this.map?.tapped();
        this.renderRoot.querySelector(".panel")?.scrollTo({ top: 0 });
        this.renderRoot.querySelector(".sheet")?.scrollTo({ top: 0 });
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
            framedByItems: false,
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
            const { points, shapes, area, attribution, attributionUrl, list } = result.feed;
            if (feed.inList) view.lists.push(list);
            const pointKeys = new Map<string, DrawnPoint>();
            const feedChangedMs = Date.parse(this.hass?.states[feed.entity]?.last_updated ?? "");
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
                    glide: feed.glide && !point.stationary,
                    reportedMs: point.updatedMs ?? (Number.isNaN(feedChangedMs) ? null : feedChangedMs),
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
            // The feed's area frames the map, or without one everything in the feed does. Framed by its items, a feed
            // with nothing in it falls back to its area. A feed left out of the framing, such as a national one beside
            // a local one, frames nothing.
            if (feed.frame === "items" && extent.length) {
                view.extent.push(...extent);
                view.framedByItems = true;
            } else if (feed.frame !== "off") view.extent.push(...(area ? areaOutline(area) : extent));
            // MapLibre reads an attribution as HTML; a feed's is text, as everything in it is, and its link an https URL.
            if (attribution) {
                view.content.attributions.push(
                    attributionUrl
                        ? `<a href="${escapeHtml(attributionUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(attribution)}</a>`
                        : escapeHtml(attribution),
                );
            }
            // The delay classes explain what is coloured by delay, the feed's legend what keeps the feed's own colours.
            // An entry another feed already gave is left out, as two feeds of one kind share their colours.
            for (const entry of [...(byDelay ? this.delayLegend(feed, delays) : []), ...(ownColours ? result.feed.legend : [])]) {
                const signature = `${entry.color}|${entry.label}|${entry.dashed === true}`;
                if (!legends.has(signature)) {
                    legends.add(signature);
                    view.legend.push(entry);
                }
            }
        }
        // One kind needs no explaining; the card's title or the feed's name already says what it is.
        if (kinds.size > 1) view.legend.push(...kinds.values());
        view.content.attributions = [...new Set(view.content.attributions)];
        return view;
    }

    /**
     * The card's own legend for colour by delay, with the feed's thresholds: the delay classes, and the two greys only
     * when the map has something cancelled or without a delay.
     */
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
            ${entries.map((entry) =>
                entry.dashed
                    ? html`<span><i class="dashed" style="border-color:${entry.color}"></i>${entry.label}</span>`
                    : html`<span><i style="background:${entry.color}"></i>${entry.label}</span>`,
            )}
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
        fadeStyles,
        css`
            /* As tall as a sections view's grid rows make its cell, which a card held by them fills. */
            :host {
                display: block;
                height: 100%;
            }
            ha-card {
                /* ha-card's own transition covers every property, so a change in the rows filled would animate. */
                transition: none;
                position: relative;
                height: 100%;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                container: card / inline-size;
                --silhouette-edge: #1c1c1c;
            }
            ha-card.dark {
                --silhouette-edge: #e8e8e8;
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
                border-inline-start: 1px solid var(--divider-color);
            }
            /* Held to a height: without the list the map takes what is left, starting from its own height, so a card that
               grows up to a limit gives way only once it reaches it. With the list under it, the list takes what the map
               leaves and gives way first, down to its least, and only then the map, down to its own. Flexbox freezes the
               list at its least and gives the rest of the shrinking to the map. */
            .held .map-wrap {
                flex: 1 1 var(--map-height);
                height: auto;
                min-height: ${MAP_MIN_PX}px;
            }
            .held.with-list:not(.wide) .map-wrap {
                flex: 0 1 var(--map-height);
            }
            .held.with-list:not(.wide) .list {
                flex: 1 1 0;
                box-sizing: border-box;
                max-height: none;
                min-height: ${LIST_MIN_PX}px;
            }
            .held.wide .body {
                flex: 1 1 var(--map-height);
                height: auto;
            }
            .held.wide .map-wrap {
                flex: 3 1 0;
                min-height: 0;
            }
            /* Held, the title and the list's header keep to one line, cut short when longer, so the map and the list keep
               the room the card's minimum counts on at any width. */
            .held .card-title,
            .held .list-title,
            .held .count {
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            /* Cut short, the title would otherwise give way to the map. */
            .held .card-title {
                flex: none;
            }
            /* A narrow card's order goes under the title when there is room to spare, but a held one keeps them side by side,
               and both give way, so neither pushes the other out. */
            .held .list-head {
                flex-wrap: nowrap;
            }
            .held .sort {
                flex: 0 1 auto;
                min-width: 0;
            }
            /* Ending on a whole row: the map takes the rest of the row, starting from its own height, beside the list too. */
            .filled:not(.wide) .map-wrap {
                flex: 1 1 var(--map-height);
                height: auto;
            }
            .filled.wide .body {
                flex: 1 1 var(--map-height);
                height: auto;
            }
            /* Growing up to a limit, a list under the map is as tall as unheld, up to list_height, and once the limit is
               reached it still gives way first, down to its least, as the map's shrinking is next to nothing until the list
               stops. Filling its rows, the map takes the rest of the row. The list must not grow, or fillRows would measure
               the room it takes as content and the card would never shrink again. */
            .held.growing.with-list:not(.wide) .map-wrap {
                flex: 0 0.0001 var(--map-height);
            }
            .held.growing.filled.with-list:not(.wide) .map-wrap {
                flex-grow: 1;
            }
            /* Held, the list is border-box, so its top border is added to list_height as unheld. */
            .held.growing.with-list:not(.wide) .list {
                flex: 0 1 auto;
                max-height: calc(var(--list-height) + 1px);
            }
            /* the details over the map */
            .map-note {
                position: absolute;
                left: 10px;
                bottom: 10px;
                max-width: calc(100% - 70px);
                padding: 6px 10px;
                border-radius: 8px;
                background: color-mix(in srgb, var(--card-background-color) 90%, transparent);
                pointer-events: none;
            }
            .map-note .hint,
            .map-note .problem {
                font-size: 13px;
                margin: 0;
            }
            .map-note .problem + .hint {
                margin-top: 4px;
            }
            /* Over MapLibre's own controls. */
            .sheet {
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                z-index: 3;
                box-sizing: border-box;
                /* At least half of a small map, so its details still have room. */
                max-height: max(calc(100% - ${SHEET_CLEAR_PX}px), 50%);
                overflow-y: auto;
                scrollbar-width: thin;
                padding: 14px 16px 16px;
                border-top: 1px solid var(--divider-color);
                background: var(--card-background-color, var(--ha-card-background, #fff));
                box-shadow: 0 -6px 16px -8px rgba(0, 0, 0, 0.5);
            }
            .sheet-close {
                float: inline-end;
                width: 32px;
                height: 32px;
                margin: -8px -8px 0 8px;
                padding: 0;
                border: 0;
                border-radius: 50%;
                background: transparent;
                color: var(--secondary-text-color);
                font: inherit;
                font-size: 22px;
                line-height: 32px;
                cursor: pointer;
            }
            .sheet-close:hover {
                background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
            }
            .sheet-close:focus-visible {
                outline: 2px solid var(--primary-color);
                outline-offset: -2px;
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
                border-inline-start: 1px solid var(--divider-color);
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
                /* Unless the card is held, the title beside it wraps first, so the order is never cut short while there is
                   room for it. */
                flex: none;
                max-width: 100%;
                height: 32px;
                box-sizing: border-box;
                margin-inline-start: auto;
                padding-block: 0;
                padding-inline: 12px 10px;
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
            /* The rows are as wide whether the list scrolls or not, so a row splits by its data, never by whether it scrolls. */
            .rows {
                overflow-y: auto;
                scrollbar-gutter: stable;
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
                text-align: start;
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
            /* The tag over the value, at the row's end, so a tag takes no room from the title. */
            .row-side {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 4px;
            }
            .row-value {
                font-size: 13px;
                color: var(--secondary-text-color);
                white-space: nowrap;
            }
            /* A row whose texts beside its value would break a word or take more lines puts the value under them (splitRows). */
            .row.under {
                grid-template-columns: auto minmax(0, 1fr);
            }
            .row:is(.under, .apart) .row-side {
                grid-column: 2;
                flex-direction: row;
                align-items: center;
                gap: 8px;
            }
            .row:is(.under, .apart) .row-value {
                white-space: normal;
            }
            /* One that doesn't fit even so puts its chip on a line of its own too. */
            .row.apart {
                grid-template-columns: minmax(0, 1fr);
            }
            .row.apart > :is(.chip, .dot) {
                justify-self: start;
            }
            .row.apart .row-side {
                grid-column: 1;
            }
            /* Measured for splitRows: no word broken, so a text without room for its longest word overflows. */
            .row.measuring :is(.row-title, .row-sub, .row-value) {
                overflow-wrap: normal;
            }
            /* Or the browser's scroll anchoring would follow a row laid out to be measured and scroll the list. */
            ha-card[data-measuring] .rows {
                overflow-anchor: none;
            }
            @container card (max-width: 320px) {
                .row {
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
            .item {
                border-bottom: 1px solid var(--divider-color);
                transition: background-color 220ms ease;
            }
            .item-line {
                display: flex;
                align-items: center;
            }
            .item-line .row {
                flex: 1 1 auto;
                min-width: 0;
            }
            .details-button {
                flex: none;
                display: grid;
                place-items: center;
                width: 40px;
                height: 40px;
                margin-inline-end: 6px;
                padding: 0;
                border: 0;
                border-radius: 50%;
                background: transparent;
                color: var(--primary-color);
                cursor: pointer;
                --mdc-icon-size: 22px;
            }
            .details-button:hover {
                background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
            }
            .details-button:focus-visible {
                outline: 2px solid var(--primary-color);
                outline-offset: -2px;
            }
            /* An item's details over the whole card, from a compact list, with their own scroll. */
            .overlay {
                position: absolute;
                inset: 0;
                z-index: 4;
                display: flex;
                flex-direction: column;
                background: var(--card-background-color, var(--ha-card-background, #fff));
            }
            .overlay-head {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: none;
                padding: 12px 12px 6px 16px;
            }
            .overlay-title {
                flex: 1 1 auto;
                min-width: 0;
                font-size: 18px;
                font-weight: 500;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .overlay-close {
                float: none;
                margin: 0;
                flex: none;
            }
            .overlay-body {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                scrollbar-width: thin;
                padding: 0 16px 16px;
            }
            /* Marked by a tint and a strip drawn inside, so the row's text keeps its size and its place. */
            .item.picked,
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
            .legend i.dashed {
                box-sizing: border-box;
                width: 13px;
                border: 1.5px dashed;
                border-radius: 2px;
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
            /* An aircraft: its silhouette alone, edged dark on a light map and light on a dark one. */
            .feed-marker.silhouette {
                width: 28px;
                height: 28px;
                border: none;
                box-shadow: none;
                background: none;
                filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
            }
            .feed-marker.silhouette.selected {
                width: 34px;
                height: 34px;
                border: none;
                box-shadow: none;
                filter: drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1.5px #fff) drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6));
            }
            .feed-marker svg.silhouette {
                width: 100%;
                height: 100%;
                overflow: visible;
                fill: currentColor;
                stroke: var(--silhouette-edge);
                stroke-width: 4.3;
                stroke-linejoin: round;
                paint-order: stroke;
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
                /* A tag is written in capitals, which have nothing under the baseline, so the room under it is less. */
                line-height: 13px;
                padding: 4px 7px 3px;
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
            .picture.linked {
                cursor: pointer;
            }
            .featured {
                position: relative;
            }
            .featured .close {
                position: absolute;
                top: 6px;
                inset-inline-end: 6px;
                width: 28px;
                height: 28px;
                padding: 0;
                border: none;
                border-radius: 50%;
                font: 400 20px/28px var(--ha-font-family-body, Roboto, sans-serif);
                color: #fff;
                background: rgba(0, 0, 0, 0.55);
                cursor: pointer;
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
