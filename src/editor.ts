/** The card's visual editor: the feeds with their own options, then the map's. */
import { LitElement, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { isMapFeed, readFeed } from "./feed";
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
};

function schema(hass: HomeAssistant, text: (key: string) => string, entities: string[]) {
    const feeds = Object.values(hass.states)
        .filter((entity) => isMapFeed(entity))
        .map((entity) => entity!.entity_id);
    const minutes = { number: { min: 0, max: 1440, step: 1, mode: "box", unit_of_measurement: "min" } };
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
                        color_by: {
                            label: text("editor.color_by"),
                            selector: {
                                select: {
                                    mode: "dropdown",
                                    options: ["kind", "delay"].map((value) => ({ value, label: text(`editor.color_by_${value}`) })),
                                },
                            },
                        },
                        late_minutes: { label: text("editor.late_minutes"), selector: minutes },
                        very_late_minutes: { label: text("editor.very_late_minutes"), selector: minutes },
                        max_age_minutes: { label: text("editor.max_age_minutes"), selector: minutes },
                        labels: { label: text("editor.labels"), selector: { boolean: {} } },
                        show_area: { label: text("editor.show_area"), selector: { boolean: {} } },
                        area_color: { label: text("editor.area_color"), selector: { text: {} } },
                    },
                },
            },
        },
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
        ...sortField(hass, entities),
    ];
}

/** The orders the chosen feeds offer, read from the feeds themselves; nothing to choose when they offer none. */
function sortField(hass: HomeAssistant, entities: string[]) {
    const lists = entities.flatMap((entity) => {
        const result = readFeed(hass.states[entity]);
        return result.status === "ok" ? [result.feed.list] : [];
    });
    const options = sortOptions(lists);
    if (!options.length) return [];
    return [
        { name: "sort", selector: { select: { mode: "dropdown", options: options.map(({ key, label }) => ({ value: key, label })) } } },
    ];
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
        return html`
            <ha-form
                .hass=${this.hass}
                .data=${{ ...CARD_DEFAULTS, ...this.config, entities }}
                .schema=${schema(
                    this.hass,
                    (key) => this.text(key),
                    entities.map((entry) => String(entry.entity ?? "")),
                )}
                .computeLabel=${(entry: SchemaEntry) => this.text(`editor.${entry.name}`)}
                .computeHelper=${(entry: SchemaEntry) => this.helper(entry.name)}
                @value-changed=${this.valueChanged}
            ></ha-form>
        `;
    }

    private valueChanged(event: CustomEvent<{ value: Record<string, unknown> }>): void {
        const value = event.detail.value;
        const config = withoutDefaults({ ...value, entities: undefined }, CARD_DEFAULTS);
        config.type = value.type ?? "custom:map-feed-card";
        config.entities = compactFeeds((Array.isArray(value.entities) ? value.entities : []) as FeedEntry[]);
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
