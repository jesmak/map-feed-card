/** The little of Home Assistant a card needs, so the unmaintained custom-card-helpers isn't a dependency. */

export interface HassEntity {
    entity_id: string;
    state: string;
    last_changed?: string;
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
    themes?: { darkMode?: boolean };
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
}

export interface LovelaceCardConfig {
    type: string;
    [key: string]: unknown;
}
