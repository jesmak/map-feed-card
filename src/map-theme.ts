/**
 * What Home Assistant's frontend adds to a vector style, so the card's map looks like Home Assistant's own: its palette
 * on the default style, a theme's `--ha-color-map-*` colours, and English names beside names in other scripts.
 *
 * The palettes and the table of theme colours are copied from the Home Assistant frontend
 * (src/common/map/ha-map-palette.ts and map-theme-colors.ts), Apache License 2.0, see LICENSE-home-assistant-frontend.
 */
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

/** Home Assistant's default style: VersaTiles' colorful, painted with these. */
export const HA_MAP_COLORS: Readonly<Record<string, string>> = {
    background: "#f5efe5",
    land: "#f5efe5",
    water: "#b8daec",
    labelWater: "#5487aa",
    natureWood: "#cfe4bc",
    natureGrass: "#e2eed8",
    naturePark: "#cfe4bc",
    natureLeisure: "#e2eed8",
    natureAgriculture: "#e8efe1",
    natureWetland: "#e5ecdf",
    natureSand: "#f3eadd",
    natureRock: "#f3eadd",
    glacier: "#faf6f0",
    areaResidential: "#f1e9da",
    areaCommercial: "#f7e0d8",
    areaIndustrial: "#f0e7cb",
    areaWaste: "#eee3d3",
    areaBurial: "#f1e9da",
    siteParking: "#efe7d6",
    siteSports: "#cfe4bc26",
    building: "#eadec7",
    buildingBg: "#e0cdae",
    roadStreet: "#fcfaf8",
    roadStreetBg: "#e9dbc4",
    roadTrunk: "#ffe7be",
    roadTrunkBg: "#ebd09f",
    roadMotorway: "#f1d6a5",
    roadMotorwayBg: "#e8bd6e",
    transitRail: "#ece0cb",
    transitSubway: "#ece2cf",
    transitCycle: "#f3eee2",
    transitFoot: "#f3eee2",
    boundary: "#dbc49f",
    boundaryDisputed: "#e5d7bd",
    label: "#4b473c",
    labelHalo: "#faf8f5cc",
    labelSymbol: "#8f8774",
    labelPoi: "#8f877466",
    labelShield: "#fbf8f3",
    labelHousenumber: "#8f87744d",
};

export const HA_MAP_COLORS_DARK: Readonly<Record<string, string>> = {
    background: "#191b2c",
    land: "#191b2c",
    water: "#27357a",
    labelWater: "#9cc0f0",
    natureWood: "#254948",
    natureGrass: "#213b39",
    naturePark: "#28504b",
    natureLeisure: "#213532",
    natureAgriculture: "#203233",
    natureWetland: "#253337",
    natureSand: "#2a2c3d",
    natureRock: "#2a2c3d",
    glacier: "#2a2c3d",
    areaResidential: "#1d2034",
    areaCommercial: "#29213a",
    areaIndustrial: "#242431",
    areaWaste: "#1d2034",
    areaBurial: "#1d2034",
    siteParking: "#1d2034",
    siteSports: "#25413926",
    building: "#21243c",
    buildingBg: "#2a2e4a",
    roadStreet: "#2b3052",
    roadStreetBg: "#1a1d33",
    roadTrunk: "#383e67",
    roadTrunkBg: "#22263f",
    roadMotorway: "#454d7d",
    roadMotorwayBg: "#2a2f4c",
    transitRail: "#2c3150",
    transitSubway: "#2c3150",
    transitCycle: "#2b3052",
    transitFoot: "#2b3052",
    boundary: "#3b4068",
    boundaryDisputed: "#3b4068",
    label: "#e7ecf8",
    labelHalo: "#12141fcc",
    labelSymbol: "#959dbd",
    labelPoi: "#959dbd66",
    labelShield: "#191b2c",
    labelHousenumber: "#959dbd4d",
};

/** A theme's colour, and the style's colours it paints; one colour covers several, as a theme author sets a handful. */
const THEME_TOKENS: Readonly<Record<string, readonly string[]>> = {
    "--ha-color-map-land": ["background", "land"],
    "--ha-color-map-water": ["water"],
    "--ha-color-map-green": ["naturePark", "natureWood", "natureGrass", "natureLeisure", "natureWetland", "siteSports"],
    "--ha-color-map-area": [
        "areaResidential",
        "areaCommercial",
        "areaIndustrial",
        "areaWaste",
        "areaBurial",
        "siteParking",
        "natureAgriculture",
        "natureSand",
        "natureRock",
    ],
    "--ha-color-map-building": ["building"],
    "--ha-color-map-building-outline": ["buildingBg"],
    "--ha-color-map-road": ["roadStreet"],
    "--ha-color-map-road-major": ["roadMotorway", "roadTrunk"],
    "--ha-color-map-road-outline": ["roadStreetBg", "roadTrunkBg", "roadMotorwayBg"],
    "--ha-color-map-transit": ["transitRail", "transitSubway", "transitCycle", "transitFoot"],
    "--ha-color-map-boundary": ["boundary", "boundaryDisputed"],
    "--ha-color-map-label": ["label"],
    "--ha-color-map-label-halo": ["labelHalo"],
    "--ha-color-map-label-secondary": ["labelSymbol", "labelPoi", "labelHousenumber"],
};

/** Colours the palettes draw see-through; a theme gives a colour, not an opacity, so the opacity is kept. */
const KEY_ALPHA: Readonly<Record<string, number>> = { siteSports: 0.15, labelHalo: 0.8, labelPoi: 0.4, labelHousenumber: 0.3 };

/**
 * The map colours the theme in effect sets, as `rgba()`, or null when it sets none, which keeps the default map on
 * the style Home Assistant ships. The browser computes each value, so named colours and color-mix() work as well.
 */
export function readThemeColors(element: HTMLElement): Record<string, string> | null {
    const style = getComputedStyle(element);
    let colors: Record<string, string> | null = null;
    for (const [token, keys] of Object.entries(THEME_TOKENS)) {
        if (!style.getPropertyValue(token).trim()) continue;
        const rgba = computedColor(element, token);
        if (!rgba) continue;
        colors ??= {};
        const [r, g, b, a] = rgba;
        for (const key of keys) colors[key] = `rgba(${r},${g},${b},${Math.round(a * (KEY_ALPHA[key] ?? 1) * 1000) / 1000})`;
    }
    return colors;
}

/** A colour the probe could never have, so a value that isn't a colour at all is told apart from one. */
const SENTINEL = "rgb(1, 2, 3)";

function computedColor(element: HTMLElement, token: string): [number, number, number, number] | null {
    const probe = document.createElement("span");
    probe.style.cssText = `display:none;color:${SENTINEL}`;
    const inner = document.createElement("span");
    inner.style.color = `var(${token})`;
    probe.append(inner);
    element.append(probe);
    const value = getComputedStyle(inner).color;
    probe.remove();
    if (value === SENTINEL) return null;
    const rgb = value.match(/^rgba?\(([^)]+)\)$/);
    if (rgb) {
        const parts = rgb[1]!
            .split(/[,\s/]+/)
            .filter(Boolean)
            .map(Number);
        if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    }
    // What a browser hands back for color-mix() and other colours in sRGB.
    const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/);
    if (srgb)
        return [1, 2, 3].map((i) => Math.round(Number(srgb[i]) * 255)).concat(Number(srgb[4] ?? 1)) as [number, number, number, number];
    return null;
}

const NAME: ExpressionSpecification = ["get", "name"];
const NAME_EN: ExpressionSpecification = ["get", "name_en"];
/** Basic Latin up to Latin Extended-B, digits and punctuation included, compared by code point. */
const IS_LATIN: ExpressionSpecification = ["<", ["coalesce", NAME, ""], "ɐ"];

/** Adds the English name under a label in another script, such as Выборг, as Home Assistant's own map does. */
export function withLatinLabels(style: StyleSpecification): StyleSpecification {
    return {
        ...style,
        layers: style.layers.map((layer) => {
            const layout = (layer as { layout?: Record<string, unknown> }).layout;
            if (!layout || JSON.stringify(layout["text-field"]) !== JSON.stringify(NAME)) return layer;
            // Streets are placed along a line and can't break it, so their English name goes in brackets.
            const english: ExpressionSpecification =
                layout["symbol-placement"] === "line"
                    ? ["concat", NAME, " (", NAME_EN, ")"]
                    : ["format", NAME, {}, "\n", {}, NAME_EN, { "font-scale": 0.8 }];
            const textField: ExpressionSpecification = ["case", IS_LATIN, NAME, ["!", ["has", "name_en"]], NAME, english];
            return { ...layer, layout: { ...layout, "text-field": textField } } as LayerSpecification;
        }),
    };
}
