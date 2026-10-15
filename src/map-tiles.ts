/**
 * Home Assistant's own base map: the vector tiles, glyphs and sprites core serves through its tile proxy
 * (`/api/map_tiles`, Home Assistant 2026.9 and newer), and the styles its own map card draws them with.
 *
 * None of this is an API made for custom cards. The proxy wants a token, which the frontend asks for over the
 * WebSocket (`map_tiles/access_token`); core rotates it every 30 minutes and keeps the last two valid. When any of
 * it changes, the card shows an error in place of the map rather than an empty one.
 */
import { osm } from "@versatiles/style";

import { HA_MAP_COLORS, HA_MAP_COLORS_DARK, withLatinLabels } from "./map-theme";
import type { RequestParameters, StyleSpecification } from "maplibre-gl";

import type { HassConnection, HomeAssistant } from "./hass";
import type { MapStyle } from "./options";

const PROXY_PATH = "/api/map_tiles";
const TOKEN_HEADER = "X-Map-Tiles-Token";

/** Well within the rotation, so one missed refresh still leaves a valid token. */
const REFRESH_MS = 20 * 60 * 1000;

/** Right after a restart the WebSocket can be up before the proxy has registered its command. */
const RETRY_DELAYS_MS = [0, 500, 1500, 4000];

/**
 * Why the map can't be drawn, which the card tells the viewer in their language: no WebGL, no map tiles from Home
 * Assistant (too old, or the proxy is down), or the style couldn't be loaded. The message is for the console.
 */
export class MapError extends Error {
    constructor(
        readonly reason: "webgl" | "tiles" | "style",
        message: string,
    ) {
        super(message);
    }
}

/** One token for every card on the page, as the frontend's own maps share theirs. */
let token: string | undefined;
let origin = "";
let connection: HassConnection | undefined;
let pending: Promise<string> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

/** The token, asked for once and then kept fresh. Throws when Home Assistant has no tile proxy. */
export async function ensureToken(hass: HomeAssistant): Promise<void> {
    // Cast shows the dashboard from another host, so the proxy is wherever Home Assistant itself is.
    origin = (hass.auth?.data?.hassUrl ?? location.origin).replace(/\/+$/, "");
    if (connection !== hass.connection) {
        connection?.removeEventListener("ready", onReconnect);
        connection = hass.connection;
        // Timers don't run while a tablet sleeps; a reconnect is the dependable sign the token may be old.
        connection.addEventListener("ready", onReconnect);
    }
    if (token) return;
    pending ??= fetchWithRetries().finally(() => (pending = undefined));
    token = await pending;
    timer ??= setInterval(() => void refreshToken(), REFRESH_MS);
}

/** A new token now, such as when a tile was refused. Concurrent calls share one request. */
export async function refreshToken(): Promise<void> {
    if (!connection) return;
    try {
        pending ??= fetchToken(connection).finally(() => (pending = undefined));
        const fresh = await pending;
        if (fresh !== token) {
            token = fresh;
            listeners.forEach((listener) => listener());
        }
    } catch {
        // The old token may still work; the next refresh or reconnect tries again.
    }
}

export function onTokenChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function onReconnect(): void {
    void refreshToken();
}

async function fetchToken(conn: HassConnection): Promise<string> {
    const result = await conn.sendMessagePromise<{ token?: unknown }>({ type: "map_tiles/access_token" });
    if (typeof result?.token !== "string") throw new MapError("tiles", "map_tiles/access_token returned no token");
    return result.token;
}

async function fetchWithRetries(): Promise<string> {
    let lastError: unknown;
    for (const delay of RETRY_DELAYS_MS) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
            return await fetchToken(connection!);
        } catch (error) {
            lastError = error;
        }
    }
    throw new MapError(
        "tiles",
        `Home Assistant's map tiles aren't available (${describe(lastError)}). The card needs Home Assistant 2026.9 or newer.`,
    );
}

/**
 * MapLibre's transformRequest. Tiles are fetched in a worker, which has no page to resolve a relative URL against, so
 * every URL is made absolute; the proxy's get the token.
 */
export function transformRequest(url: string): RequestParameters {
    let parsed: URL;
    try {
        parsed = new URL(url, origin || location.origin);
    } catch {
        return { url };
    }
    if (!parsed.pathname.startsWith(`${PROXY_PATH}/`) || !token) return { url: parsed.href };
    const absolute = new URL(`${origin}${parsed.pathname}${parsed.search}`);
    // In a header the URL stays the same between tokens and the browser's tile cache keeps working. From another
    // origin (Cast) a custom header would cost a CORS preflight per tile, so there it goes in the query.
    if (absolute.origin === location.origin) return { url: absolute.href, headers: { [TOKEN_HEADER]: token } };
    absolute.searchParams.set("token", token);
    return { url: absolute.href };
}

/**
 * The style for a map: Home Assistant's own default as it ships it (its own colours on `colorful`), or one built here
 * the way the frontend builds it, from @versatiles/style against the proxy's tiles and Home Assistant's glyphs and
 * sprites. A theme's map colours (map-theme.ts) are painted over the style, the default included.
 */
export async function loadStyle(
    style: MapStyle,
    dark: boolean,
    themeColors: Record<string, string> | null = null,
): Promise<StyleSpecification> {
    if (style === "default" && !themeColors) {
        return withAbsoluteSprite(await fetchJson<StyleSpecification>(`/static/map/${dark ? "dark" : "light"}.json`));
    }
    const base = style === "default" ? (dark ? HA_MAP_COLORS_DARK : HA_MAP_COLORS) : null;
    const urls = await fetchJson<Record<string, unknown>>("/static/map/urls.json");
    const palette = (style === "default" ? "colorful" : style) + (dark ? "-dark" : "");
    // The builder throws on a colour it can't read, and a theme is no reason to lose the map: without the theme's
    // colours, and then without any, it is the style as Home Assistant has it.
    const attempts = [{ ...base, ...themeColors }, ...(base ? [base] : []), null];
    for (const colors of attempts) {
        try {
            return withAbsoluteSprite(withLatinLabels(buildStyle(palette, urls, colors)));
        } catch (error) {
            if (!colors) throw error;
            console.warn(`map-feed-card: the ${palette} map style couldn't take the theme's colours`, error);
        }
    }
    throw new MapError("style", `The ${palette} map style couldn't be built`);
}

function buildStyle(palette: string, urls: Record<string, unknown>, colors: Record<string, string> | null): StyleSpecification {
    const options = { theme: palette, urls, ...(colors && Object.keys(colors).length ? { colors } : {}) };
    const style = osm(options as Parameters<typeof osm>[0]) as unknown as StyleSpecification;
    const sources = Object.values(style.sources) as unknown as Record<string, unknown>[];
    // The builder points its one source at VersaTiles' own servers; the tiles must come through Home Assistant.
    if (sources.length !== 1) throw new MapError("style", `The ${palette} map style has ${sources.length} tile sources, expected one`);
    for (const field of ["tiles", "attribution", "bounds", "minzoom", "maxzoom", "scheme"]) delete sources[0]![field];
    sources[0]!.url = `${PROXY_PATH}/tilejson.json`;
    return style;
}

/** MapLibre loads the sprite sheet outside transformRequest's reach of a relative URL. */
function withAbsoluteSprite(style: StyleSpecification): StyleSpecification {
    const absolute = (url: string) => new URL(url, origin || location.origin).href;
    if (typeof style.sprite === "string") style.sprite = absolute(style.sprite);
    else if (Array.isArray(style.sprite)) style.sprite = style.sprite.map((sprite) => ({ ...sprite, url: absolute(sprite.url) }));
    return style;
}

async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${origin}${path}`);
    if (!response.ok) throw new MapError("style", `${path} answered ${response.status}`);
    return (await response.json()) as T;
}

function describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null && "message" in error) return String((error as { message: unknown }).message);
    return String(error);
}
