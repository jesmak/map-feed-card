/**
 * The card's list of items (docs/map-feed-format.md#list): each item's row, and the orders the feeds offer.
 */
import { titleIsSubtitle, formatAge, type Text } from "./details";
import { isMoving, type FeedItem, type FeedList, type FeedPoint, type RowTag, type SortValue } from "./feed";
import { canBeLate } from "./style";

export interface Row {
    title: string;
    /** '' when there is none. */
    text: string;
    value: string;
    /** Whether the value is a delay, drawn in the item's colour. */
    valueIsDelay: boolean;
    /** A short tag after the title, from the feed's row. */
    tag: RowTag | null;
}

/**
 * An item's row: the feed's own parts where it gives them, otherwise the name and subtitle as the details show them,
 * and the delay or the age as the value.
 */
export function rowOf(item: FeedItem, point: FeedPoint | null, text: Text, now = Date.now()): Row {
    const subtitleTitle = titleIsSubtitle(item, point);
    const own = item.listRow;
    const delay = point && canBeLate(point) ? shortDelay(point, text) : "";
    const ageOf = point && isMoving(item.kind) ? point.updatedMs : item.updatedMs;
    return {
        title: own.title ?? ((subtitleTitle ? item.subtitle : item.name) || item.name),
        text: own.text ?? (subtitleTitle ? "" : item.subtitle),
        value: own.value ?? (delay || formatAge(ageOf, text, now)),
        valueIsDelay: own.value === null && delay !== "",
        tag: own.tag,
    };
}

/** "4 min", "−2 min", "on time" or "cancelled"; '' when the delay is unknown. */
function shortDelay(point: FeedPoint, text: Text): string {
    if (point.cancelled) return text("common.cancelled");
    if (point.delayMinutes === null) return "";
    const minutes = Math.round(point.delayMinutes);
    if (minutes === 0) return text("common.on_time");
    return text("list.delay", { n: minutes > 0 ? String(minutes) : `−${-minutes}` });
}

export interface SortOption {
    key: string;
    label: string;
}

/** Every feed's sort keys, the first label of a key shared by several feeds standing for all of them. */
export function sortOptions(lists: FeedList[]): SortOption[] {
    const options = new Map<string, string>();
    for (const list of lists) for (const key of list.sort) if (!options.has(key.key)) options.set(key.key, key.label);
    return [...options].map(([key, label]) => ({ key, label }));
}

/** The key the list starts in: the card's own when some feed offers it, else the first feed's default. */
export function startingSort(sort: string | null, lists: FeedList[]): string | null {
    if (sort && lists.some((list) => list.sort.some((key) => key.key === sort))) return sort;
    return lists.find((list) => list.defaultKey)?.defaultKey ?? null;
}

export interface Sortable {
    item: FeedItem;
    list: FeedList;
}

/**
 * Sorts by the chosen key. Items whose feed has no such key, or that lack the property, keep their feed's order after
 * the others. The sort is stable, so equal values keep the feed's order too.
 */
export function sortRows<T extends Sortable>(entries: T[], key: string | null, language: string): T[] {
    if (!key) return entries;
    const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
    const valued: Array<{ entry: T; value: SortValue; descending: boolean }> = [];
    const rest: T[] = [];
    for (const entry of entries) {
        const sortKey = entry.list.sort.find((candidate) => candidate.key === key);
        const value = sortKey ? entry.item.sortValues[sortKey.property] : undefined;
        if (sortKey && value !== undefined) valued.push({ entry, value, descending: sortKey.descending });
        else rest.push(entry);
    }
    valued.sort((a, b) => {
        const order = compare(a.value, b.value, collator);
        return a.descending ? -order : order;
    });
    return [...valued.map(({ entry }) => entry), ...rest];
}

/** Numbers before text, so a feed that mixes them still sorts the same way each time. */
function compare(a: SortValue, b: SortValue, collator: Intl.Collator): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return collator.compare(a, b);
}

/**
 * The count above the list, in the feeds' own word when they all use the same one, else in the card's. One item takes
 * the singular, the feed's `count_one` or the card's own, as languages such as Finnish write "1 kohde" but "2 kohdetta".
 */
export function countText(n: number, lists: FeedList[], text: Text): string {
    const words = new Set(lists.map((list) => `${list.count}|${list.countOne}`));
    const list = lists[0];
    if (words.size === 1 && list?.count) return `${n} ${n === 1 && list.countOne ? list.countOne : list.count}`;
    return text(n === 1 ? "list.count_one" : "list.count", { n });
}
