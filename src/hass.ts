/** The little of Home Assistant a card needs, so the unmaintained custom-card-helpers isn't a dependency. */

export interface HassEntity {
    entity_id: string;
    state: string;
    last_changed?: string;
    /** Changes with the attributes too, unlike last_changed. */
    last_updated?: string;
    attributes: Record<string, unknown>;
}

export interface HassConnection {
    sendMessagePromise<T>(message: Record<string, unknown>): Promise<T>;
    addEventListener(event: "ready", listener: () => void): void;
    removeEventListener(event: "ready", listener: () => void): void;
}

export interface HomeAssistant {
    states: Record<string, HassEntity | undefined>;
    /** The entity registry, which says which integration an entity belongs to. */
    entities?: Record<string, { platform?: string } | undefined>;
    connection: HassConnection;
    /** `hassUrl` is where the instance is, which isn't this page's origin when the dashboard is cast. */
    auth?: { data?: { hassUrl?: string } };
    /** `theme` is the default theme; `selectedTheme` the viewer's own choice, null when they follow the default. */
    themes?: { darkMode?: boolean; theme?: string };
    selectedTheme?: { theme?: string } | null;
    /** Where home is, which the map shows until a feed has something on it. */
    config?: { latitude?: number; longitude?: number };
    language?: string;
    locale?: { language?: string };
    callService(
        domain: string,
        service: string,
        data?: Record<string, unknown>,
        target?: unknown,
        notifyOnError?: boolean,
        returnResponse?: boolean,
    ): Promise<unknown>;
    /** Present in Home Assistant 2025.10 and later. */
    formatEntityName?(state: HassEntity, parts: NamePart[]): string;
}

/** One part of an entity's name, as `formatEntityName` puts them together. */
interface NamePart {
    type: "entity" | "device" | "area" | "floor";
}

/** An entity's name as Home Assistant composes it from its device's and its own, or its friendly name before 2025.10. */
export function entityName(hass: HomeAssistant | undefined, state: HassEntity | undefined): string {
    const name = (state && hass?.formatEntityName?.(state, [{ type: "device" }, { type: "entity" }])) || state?.attributes.friendly_name;
    return typeof name === "string" ? name : "";
}
