/** Made-up feed entities and features for the tests, in the shapes the real integrations write. */
import type { HassEntity } from "../../src/hass";

export function feedState(entityId: string, features: unknown[], attributes: Record<string, unknown> = {}): HassEntity {
    return {
        entity_id: entityId,
        state: String(features.length),
        attributes: {
            map_feed_version: 1,
            geojson: { type: "FeatureCollection", features },
            ...attributes,
        },
    };
}

export function shipFeature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "Feature",
        id: "ship:230113940",
        geometry: { type: "Point", coordinates: [27.17012, 60.53044] },
        properties: {
            name: "PILOT L117",
            kind: "ship.pilot",
            updated: new Date().toISOString(),
            heading: 88,
            speed_kmh: 20.4,
            details: [
                { label: "Tyyppi", value: "Luotsivene" },
                { label: "Syväys", value: 2.2, unit: "m" },
            ],
            footer: "MMSI 230113940",
            ...overrides,
        },
    };
}

export function trainFeature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "Feature",
        id: "train:2026-09-14/8",
        geometry: { type: "Point", coordinates: [27.30011, 60.90204] },
        properties: {
            name: "IC 8",
            kind: "train.long_distance",
            updated: new Date().toISOString(),
            speed_kmh: 113,
            delay_minutes: 11,
            badge: "IC 8",
            label: "→ Helsinki",
            subtitle: "Joensuu → Helsinki",
            notices: ["Juna on myöhässä ratatöiden vuoksi."],
            detail_action: {
                action: "digitraffic_live.get_train_composition",
                data: { departure_date: "2026-09-14", train_number: 8 },
            },
            ...overrides,
        },
    };
}

/** A road work's warning sign. Its line is roadworkLine(). */
export function roadworkPoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "Feature",
        id: "roadwork:1",
        geometry: { type: "Point", coordinates: [27.2, 60.6] },
        properties: {
            name: "Tie 26, Luumäki. Tietyö.",
            kind: "road.roadwork",
            subtitle: "Tie 26 välillä Hamina - Lappeenranta.",
            details: [{ label: "Rajoitukset", value: "Yksi ajokaista suljettu" }],
            ...overrides,
        },
    };
}

export function roadworkLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "Feature",
        id: "roadwork:1/line",
        geometry: {
            type: "MultiLineString",
            coordinates: [
                [
                    [27.2, 60.6],
                    [27.21, 60.61],
                ],
                [
                    [27.25, 60.65],
                    [27.26, 60.66],
                ],
            ],
        },
        properties: { kind: "road.roadwork", point: "roadwork:1", ...overrides },
    };
}

export function cameraFeature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
        type: "Feature",
        id: "camera:C03558",
        geometry: { type: "Point", coordinates: [28.30757, 61.07104] },
        properties: {
            name: "Tie 6 Lappeenranta, Saimaan kanava",
            kind: "road.camera",
            updated: now,
            images: [{ url: "https://weathercam.digitraffic.fi/C0355801.jpg", caption: "Imatralle", time: now }],
            ...overrides,
        },
    };
}
