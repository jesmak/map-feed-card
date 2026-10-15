/**
 * The selected item's details, drawn from the shape of its data: rows with a picture as a media list, rows without
 * one as a table of label and value, notices as a highlighted block, then pictures, the footer and the link.
 */
import { html, nothing, type TemplateResult } from "lit";

import { isMoving, kindFamily, readDetailRows, type DetailRow, type FeedImage, type FeedItem, type FeedPoint } from "./feed";
import type { HomeAssistant } from "./hass";
import { DELAY_COLORS, delayClass, textOn } from "./style";

export type Text = (key: string, values?: Record<string, string | number>) => string;

export const KMH_PER_KNOT = 1.852;

/** "just now", "5 min ago", "3 h ago" or "2 d ago"; '' when the time is unknown. */
export function formatAge(epochMs: number | null, text: Text, now = Date.now()): string {
    if (epochMs === null) return "";
    const minutes = Math.round((now - epochMs) / 60_000);
    if (minutes < 1) return text("common.just_now");
    if (minutes < 60) return text("common.min_ago", { n: minutes });
    // Hours up to two days, so "yesterday evening" still reads as hours.
    if (minutes < 48 * 60) return text("common.hours_ago", { n: Math.round(minutes / 60) });
    return text("common.days_ago", { n: Math.round(minutes / (24 * 60)) });
}

/** "5 min late", "on time", "2 min early", or '' when the delay is unknown. */
export function delayText(delayMinutes: number | null, text: Text): string {
    if (delayMinutes === null) return "";
    const minutes = Math.round(delayMinutes);
    if (minutes > 0) return text("common.late", { n: minutes });
    if (minutes < 0) return text("common.early", { n: -minutes });
    return text("common.on_time");
}

/** Ships in knots with their direction ("11.0 kn · 88°"), everything else in km/h; '' when unknown. */
export function speedText(point: Pick<FeedPoint, "kind" | "speedKmh" | "stationary" | "heading">): string {
    if (point.speedKmh === null) return "";
    if (kindFamily(point.kind) === "ship") {
        const direction = !point.stationary && point.heading !== null ? ` · ${Math.round(point.heading)}°` : "";
        return `${(point.speedKmh / KMH_PER_KNOT).toFixed(1)} kn${direction}`;
    }
    return `${Math.round(point.speedKmh)} km/h`;
}

/**
 * The status line of something that moves: cancelled or its delay, its speed and the age of its position. Its colour
 * is the delay's, or null when there is no delay to colour it by.
 */
export function statusLine(
    point: FeedPoint,
    thresholds: readonly [number, number],
    text: Text,
    now = Date.now(),
): { text: string; color: string | null } {
    const parts = [
        point.cancelled ? text("common.cancelled") : delayText(point.delayMinutes, text),
        speedText(point),
        formatAge(point.updatedMs, text, now),
    ].filter(Boolean);
    const known = point.cancelled || point.delayMinutes !== null;
    return { text: parts.join(" · "), color: known ? DELAY_COLORS[delayClass(point, thresholds)] : null };
}

/* ---------------- detail actions ---------------- */

export type ActionRows = { status: "loading" } | { status: "loaded"; rows: DetailRow[] };

/**
 * More rows from an item's detail action (docs/map-feed-format.md#detail-actions), loaded when the item is first
 * selected and kept while the card lives. A failed load is tried again the next time the item is selected.
 */
export class DetailLoader {
    private readonly states = new Map<string, ActionRows>();

    get(point: FeedPoint): ActionRows | undefined {
        return point.detailAction ? this.states.get(cacheKey(point)) : undefined;
    }

    /**
     * Calls the item's action once, and then `done` so the panel can be drawn again. Only an action of the integration
     * the feed entity belongs to is called: selecting an item calls it with the viewer's rights, so a feed must not be
     * able to run anything else, such as a script.
     */
    load(point: FeedPoint, hass: HomeAssistant, entity: string, done: () => void): void {
        const action = point.detailAction;
        const key = cacheKey(point);
        if (!action || this.states.has(key)) return;
        const platform = hass.entities?.[entity]?.platform;
        if (action.domain !== platform) {
            console.warn(
                `map-feed-card: ${entity} comes from ${platform ?? "an unknown integration"}, not calling ${action.domain}.${action.service}`,
            );
            this.states.set(key, { status: "loaded", rows: [] });
            return;
        }
        this.states.set(key, { status: "loading" });
        hass.callService(action.domain, action.service, action.data, undefined, false, true).then(
            (result) => {
                const response = (result as { response?: { details?: unknown } } | undefined)?.response;
                this.states.set(key, { status: "loaded", rows: readDetailRows(response?.details) });
                done();
            },
            (error: unknown) => {
                console.warn(`map-feed-card: ${action.domain}.${action.service} failed for ${point.id}`, error);
                this.states.delete(key);
                done();
            },
        );
    }
}

/** The same item with a different action, such as another day's train, loads again. */
function cacheKey(point: FeedPoint): string {
    return `${point.id}|${JSON.stringify(point.detailAction)}`;
}

/* ---------------- the panel ---------------- */

export interface DetailsInput {
    item: FeedItem;
    /** The point, when the item is one; a line or polygon has no movement to show. */
    point: FeedPoint | null;
    color: string;
    thresholds: readonly [number, number];
    actionRows: ActionRows | undefined;
    /** The picture shown large at the top, if one was tapped. */
    featured: FeedImage | null;
    onImage: (image: FeedImage | null) => void;
    text: Text;
    /**
     * In the list, the row shown above the details. The details then leave out their own head and show only what the
     * row doesn't: the name, the subtitle or the age, when the feed gave the row parts of its own.
     */
    row?: { title: string; text: string; value: string };
}

/** What the details add to a list row: the name, subtitle and age that the row's own parts left out. */
export function besidesRow(
    row: { title: string; text: string; value: string },
    parts: { title: string; subtitle: string; age: string },
): string[] {
    return [
        parts.title !== row.title ? parts.title : "",
        parts.subtitle !== row.text ? parts.subtitle : "",
        parts.age !== row.value ? parts.age : "",
    ].filter(Boolean);
}

/**
 * A train's name and badge are both "IC 8", so its route, the subtitle, is the better title. A badge that says
 * something else, such as a bird site's species count, leaves the name as the title.
 */
export function titleIsSubtitle(item: Pick<FeedItem, "name" | "subtitle">, point: Pick<FeedPoint, "badge"> | null): boolean {
    return point !== null && point.badge !== "" && point.badge === item.name && item.subtitle !== "";
}

export function renderDetails(input: DetailsInput): TemplateResult {
    const { item, point, color, text } = input;
    const moving = point !== null && isMoving(item.kind);
    const subtitleTitle = titleIsSubtitle(item, point);
    const title = subtitleTitle ? item.subtitle : item.name;
    const status = moving ? statusLine(point, input.thresholds, text) : null;
    const age = moving ? "" : formatAge(item.updatedMs, text);
    const extras = input.row ? besidesRow(input.row, { title: title || item.name, subtitle: subtitleTitle ? "" : item.subtitle, age }) : [];
    const rows = [...item.details, ...(input.actionRows?.status === "loaded" ? input.actionRows.rows : [])];

    return html`
        ${input.featured ? featuredImage(input.featured, input.onImage, text) : nothing}
        ${
            !input.row
                ? html`<div class="head">
                      ${
                          point?.badge
                              ? html`<span class="chip" style="background:${color};color:${textOn(color)}">${point.badge}</span>`
                              : html`<span class="dot" style="background:${color}"></span>`
                      }
                      <h2>${title || item.name}</h2>
                      ${age ? html`<span class="age">${age}</span>` : nothing}
                  </div>`
                : nothing
        }
        ${
            status?.text
                ? html`<div
                      class="status"
                      style=${status.color ? `color:color-mix(in srgb, ${status.color} 70%, var(--primary-text-color))` : ""}
                  >
                      ${status.text}
                  </div>`
                : nothing
        }
        ${item.subtitle && !subtitleTitle && !input.row ? html`<div class="subtitle">${item.subtitle}</div>` : nothing}
        ${extras.length ? html`<div class="subtitle">${extras.join(" · ")}</div>` : nothing}
        ${groups(rows).map((group) => (group.media ? mediaList(group.rows, color, input.onImage) : table(group.rows)))}
        ${input.actionRows?.status === "loading" ? html`<div class="loading">${text("common.loading")}</div>` : nothing}
        ${item.notices.length ? html`<div class="notices">${item.notices.map((notice) => html`<p>${notice}</p>`)}</div>` : nothing}
        ${item.images.length ? html`<div class="images">${item.images.map((image) => picture(image, input.onImage, text))}</div>` : nothing}
        ${item.footer ? html`<div class="footer">${item.footer}</div>` : nothing}
        ${item.link ? html`<a class="link" href=${item.link.url} target="_blank" rel="noopener noreferrer">${item.link.label}</a>` : nothing}
    `;
}

/** Consecutive rows of the same kind, those with a picture and those without, so each run is drawn its own way. */
export function groups(rows: DetailRow[]): Array<{ media: boolean; rows: DetailRow[] }> {
    const result: Array<{ media: boolean; rows: DetailRow[] }> = [];
    for (const row of rows) {
        const media = row.image !== undefined;
        const last = result.at(-1);
        if (last && last.media === media) last.rows.push(row);
        else result.push({ media, rows: [row] });
    }
    return result;
}

function mediaList(rows: DetailRow[], color: string, onImage: (image: FeedImage | null) => void): TemplateResult {
    return html`<ul class="media">
        ${rows.map(
            (row) =>
                html`<li>
                    <button class="thumb" @click=${() => onImage(row.image!)} aria-label=${row.image!.caption || row.label}>
                        <img src=${row.image!.url} alt="" loading="lazy" />
                    </button>
                    <div class="text">
                        <span class="label">${row.label}</span>
                        <span class="value">${valueOf(row)}</span>
                    </div>
                    ${row.tag ? tag(row, color) : nothing}
                </li>`,
        )}
    </ul>`;
}

function table(rows: DetailRow[]): TemplateResult {
    return html`<dl class="table">
        ${rows.map(
            (row) =>
                html`<dt>${row.label}</dt>
                    <dd>${valueOf(row)}${row.tag ? html` ${tag(row, null)}` : nothing}</dd>`,
        )}
    </dl>`;
}

/** `item` takes the item's own colour, the one its marker has, so the tag leads from the marker to the row. */
function tag(row: DetailRow, color: string | null): TemplateResult {
    const own = row.tag!.tone === "item" && color;
    return html`<span class="tag ${row.tag!.tone}" style=${own ? `background:${color};color:${textOn(color)}` : ""}
        >${row.tag!.text}</span
    >`;
}

function valueOf(row: DetailRow): string {
    return row.unit ? `${row.value} ${row.unit}` : row.value;
}

function picture(image: FeedImage, onImage: (image: FeedImage | null) => void, text: Text): TemplateResult {
    const age = formatAge(image.takenMs, text);
    return html`<figure>
        <button class="picture" @click=${() => onImage(image)} aria-label=${image.caption || ""}>
            <img src=${image.url} alt="" loading="lazy" />
        </button>
        ${image.caption || age ? html`<figcaption>${[image.caption, age].filter(Boolean).join(" · ")}</figcaption>` : nothing}
    </figure>`;
}

function featuredImage(image: FeedImage, onImage: (image: FeedImage | null) => void, text: Text): TemplateResult {
    return html`<figure class="featured">
        <button class="picture" @click=${() => onImage(null)} aria-label=${text("common.close_image")}>
            <img src=${image.url} alt=${image.caption} />
        </button>
        ${image.caption ? html`<figcaption>${image.caption}</figcaption>` : nothing}
    </figure>`;
}
