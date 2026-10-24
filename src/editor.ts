/** The card's visual editor: the feeds with their own options, then the map's. */
import { LitElement, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { isMapFeed, readFeed, type FeedType } from "./feed";
import type { HomeAssistant } from "./hass";
import { browserLanguage, translate } from "./localize/localize";
import { sortOptions } from "./list";
import { DEFAULT_DELAY_THRESHOLDS, DEFAULT_LIST_HEIGHT, DEFAULT_MAP_HEIGHT, MAP_STYLES } from "./options";

interface SchemaEntry {
    name: string;
}

type FeedEntry = Record<string, unknown> & { entity?: string };

/** Shown in the form but left out of the configuration. */
const CARD_DEFAULTS: Record<string, unknown> = {
    map_style: "default",
    map_height: DEFAULT_MAP_HEIGHT,
    legend: true,
    list: false,
    list_height: DEFAULT_LIST_HEIGHT,
};
const FEED_DEFAULTS: Record<string, unknown> = {
    color_by: "kind",
    late_minutes: DEFAULT_DELAY_THRESHOLDS[0],
    very_late_minutes: DEFAULT_DELAY_THRESHOLDS[1],
    show_area: false,
    labels: false,
    glide: false,
    frame: true,
};

const MINUTES = { number: { min: 0, max: 1440, step: 1, mode: "box", unit_of_measurement: "min" } };

/**
 * A feed's options that make sense for it: delays only for what can be late, an age limit for what has positions,
 * gliding for what moves, the area only when the feed has one. A feed that doesn't say its type gets them all, since it could be anything.
 * Thresholds and the area's colour appear once the option they belong to is on. An option that doesn't make sense but
 * is set anyway, such as one left from the feed the entry had before, still shows, so it can be cleared.
 */
export function feedFields(type: FeedType | null, hasArea: boolean, options: Record<string, unknown>): string[] {
    const set = (name: string) =>
        options[name] !== undefined && options[name] !== null && options[name] !== "" && options[name] !== FEED_DEFAULTS[name];
    const late = type === null || type === "train" || type === "transit" || type === "other";
    const colorBy = late || set("color_by");
    const area = hasArea || set("show_area");
    const fields = [
        ...(colorBy ? ["color_by"] : []),
        ...(colorBy && options.color_by === "delay" ? ["late_minutes", "very_late_minutes"] : []),
        ...(type !== "nature" || set("max_age_minutes") ? ["max_age_minutes"] : []),
        "labels",
        ...((type !== "road" && type !== "nature") || set("glide") ? ["glide"] : []),
        ...(area ? ["show_area"] : []),
        ...((area && options.show_area === true) || set("area_color") ? ["area_color"] : []),
        "frame",
    ];
    // Thresholds set without delay colouring do nothing, but are shown, so they can be cleared.
    for (const name of ["late_minutes", "very_late_minutes"])
        if (set(name) && !fields.includes(name)) fields.splice(fields.indexOf("labels"), 0, name);
    return fields;
}

function feedSchema(fields: string[], text: (key: string) => string) {
    const selectors: Record<string, unknown> = {
        color_by: {
            select: { mode: "dropdown", options: ["kind", "delay"].map((value) => ({ value, label: text(`editor.color_by_${value}`) })) },
        },
        late_minutes: MINUTES,
        very_late_minutes: MINUTES,
        // The card refuses 0, which would hide everything.
        max_age_minutes: { number: { ...MINUTES.number, min: 1 } },
        labels: { boolean: {} },
        glide: { boolean: {} },
        show_area: { boolean: {} },
        area_color: { text: {} },
        frame: { boolean: {} },
    };
    return fields.map((name) => ({ name, selector: selectors[name] }));
}

function schema(hass: HomeAssistant, text: (key: string) => string, entities: FeedEntry[], sort: unknown) {
    const feeds = Object.values(hass.states)
        .filter((entity) => isMapFeed(entity))
        .map((entity) => entity!.entity_id);
    return [
        { name: "title", selector: { text: {} } },
        {
            name: "entities",
            required: true,
            selector: {
                object: {
                    multiple: true,
                    label_field: "entity",
                    fields: {
                        entity: { label: text("editor.entity"), required: true, selector: { entity: { include_entities: feeds } } },
                    },
                },
            },
        },
        // Each feed's own options in a section of its own, since what makes sense depends on the feed.
        ...entities.map((entry, index) => {
            const state = hass.states[String(entry.entity ?? "")];
            const result = readFeed(state);
            const feed = result.status === "ok" ? result.feed : null;
            return {
                type: "expandable",
                name: `feed_${index}`,
                title: String(state?.attributes?.friendly_name ?? entry.entity ?? ""),
                schema: feedSchema(feedFields(feed?.type ?? null, feed?.area != null, entry), text),
            };
        }),
        {
            name: "map_style",
            selector: {
                select: { mode: "dropdown", options: MAP_STYLES.map((value) => ({ value, label: text(`editor.map_style_${value}`) })) },
            },
        },
        {
            type: "grid",
            name: "",
            schema: [
                { name: "map_height", selector: { number: { min: 100, max: 1200, step: 10, mode: "box", unit_of_measurement: "px" } } },
                { name: "legend", selector: { boolean: {} } },
            ],
        },
        { name: "list", selector: { boolean: {} } },
        { name: "list_height", selector: { number: { min: 100, max: 1200, step: 10, mode: "box", unit_of_measurement: "px" } } },
        ...sortField(
            hass,
            entities.map((entry) => String(entry.entity ?? "")),
            sort,
        ),
    ];
}

/** The orders the chosen feeds offer, read from the feeds themselves; nothing to choose when they offer none. */
function sortField(hass: HomeAssistant, entities: string[], sort: unknown) {
    const lists = entities.flatMap((entity) => {
        const result = readFeed(hass.states[entity]);
        return result.status === "ok" ? [result.feed.list] : [];
    });
    const options = sortOptions(lists).map(({ key, label }) => ({ value: key, label }));
    // One order is no choice: the list is sorted by it all the same. One set anyway, perhaps for a feed no longer on
    // the card, is still shown, so it can be cleared.
    const set = typeof sort === "string" && sort !== "";
    if (options.length < 2 && !set) return [];
    if (set && !options.some((option) => option.value === sort)) options.push({ value: sort, label: sort });
    return [{ name: "sort", selector: { select: { mode: "dropdown", options } } }];
}

/** A feed with nothing but its sensor is written as the plain entity id, so the configuration stays short. */
export function compactFeeds(entries: FeedEntry[]): Array<string | FeedEntry> {
    return entries
        .filter((entry) => entry.entity)
        .map((entry) => {
            const compact = withoutDefaults(entry, FEED_DEFAULTS);
            return Object.keys(compact).length === 1 ? entry.entity! : compact;
        });
}

function withoutDefaults(config: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(config).filter(([key, value]) => value !== undefined && value !== null && value !== "" && defaults[key] !== value),
    );
}

@customElement("map-feed-card-editor")
export class MapFeedCardEditor extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @state() private config: Record<string, unknown> = { type: "custom:map-feed-card", entities: [] };
    /** The feeds as the form was last drawn with them. */
    private entities: FeedEntry[] = [];

    public setConfig(config: Record<string, unknown>): void {
        this.config = { ...config };
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.hass) return nothing;
        // The form edits every feed as an object, with its defaults filled in; plain entity ids are expanded for it.
        const entities = (Array.isArray(this.config.entities) ? this.config.entities : []).map((entry: unknown) => ({
            ...FEED_DEFAULTS,
            ...(typeof entry === "string" ? { entity: entry } : (entry as FeedEntry)),
        }));
        // Each feed's section edits a copy of its entry; valueChanged writes it back.
        const sections = Object.fromEntries(entities.map((entry, index) => [`feed_${index}`, entry]));
        this.entities = entities;
        return html`
            <ha-form
                .hass=${this.hass}
                .data=${{ ...CARD_DEFAULTS, ...this.config, entities, ...sections }}
                .schema=${schema(this.hass, (key) => this.text(key), entities, this.config.sort)}
                .computeLabel=${(entry: SchemaEntry) => this.text(`editor.${entry.name}`)}
                .computeHelper=${(entry: SchemaEntry) => this.helper(entry.name)}
                @value-changed=${this.valueChanged}
            ></ha-form>
        `;
    }

    private valueChanged(event: CustomEvent<{ value: Record<string, unknown> }>): void {
        const value = event.detail.value;
        let entities = (Array.isArray(value.entities) ? value.entities : []) as FeedEntry[];
        // The sections follow the list's order as it was drawn. When the list itself changed (a feed added, removed or
        // moved), its entries already carry their options; otherwise a section changed, and it goes back to its feed.
        if (JSON.stringify(entities) === JSON.stringify(this.entities)) {
            entities = entities.map((entry, index) => ({
                ...entry,
                ...(value[`feed_${index}`] as FeedEntry | undefined),
                entity: entry.entity,
            }));
        }
        const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "entities" && !key.startsWith("feed_")));
        const config = withoutDefaults(rest, CARD_DEFAULTS);
        config.type = value.type ?? "custom:map-feed-card";
        config.entities = compactFeeds(entities);
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }

    private text(key: string): string {
        return translate(this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage(), key);
    }

    private helper(name: string): string | undefined {
        const key = `editor.${name}_helper`;
        const helper = this.text(key);
        return helper === key ? undefined : helper;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "map-feed-card-editor": MapFeedCardEditor;
    }
}
