/**
 * A line whose positions have colours or opacities of their own (the format's `colors` and `opacities`), cut into pieces
 * of one colour and one opacity each, as a map layer draws a line in one of each.
 */
import type { LngLat } from "./feed";

export interface Piece {
    path: LngLat[];
    color: string;
    opacity: number;
}

/**
 * A stretch between two positions that differ is drawn in pieces, blending from one to the other: a piece for each
 * step of this size in a colour channel (0–255) or in opacity, so that neighbours that hardly differ stay one piece.
 */
const COLOR_STEP = 24;
const OPACITY_STEP = 0.15;
const MAX_STEPS = 6;

/**
 * The pieces of `path`, each position with its colour and opacity. A stretch between two positions that differ blends
 * from one to the other, and stretches that come out alike are joined into one piece.
 */
export function linePieces(path: LngLat[], colors: string[], opacities: number[]): Piece[] {
    const pieces: Piece[] = [];
    const add = (from: LngLat, to: LngLat, color: string, opacity: number) => {
        const last = pieces[pieces.length - 1];
        if (last && last.color === color && last.opacity === opacity) last.path.push(to);
        else pieces.push({ path: [from, to], color, opacity });
    };
    for (let index = 1; index < path.length; index++) {
        const [from, to] = [path[index - 1]!, path[index]!];
        const [fromColor, toColor] = [colors[index - 1]!, colors[index]!];
        const [fromOpacity, toOpacity] = [opacities[index - 1]!, opacities[index]!];
        if (fromColor === toColor && fromOpacity === toOpacity) {
            add(from, to, toColor, toOpacity);
            continue;
        }
        const [a, b] = [channels(fromColor), channels(toColor)];
        const colorSteps = Math.max(...a.map((channel, at) => Math.abs(channel - b[at]!))) / COLOR_STEP;
        const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(Math.max(colorSteps, Math.abs(toOpacity - fromOpacity) / OPACITY_STEP))));
        let start = from;
        for (let step = 0; step < steps; step++) {
            const end = step === steps - 1 ? to : between(from, to, (step + 1) / steps);
            const middle = (step + 0.5) / steps;
            add(start, end, mix(fromColor, toColor, middle), round(fromOpacity + (toOpacity - fromOpacity) * middle));
            start = end;
        }
    }
    return pieces;
}

function between(from: LngLat, to: LngLat, t: number): LngLat {
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/** The colour `t` of the way from one CSS hex colour to another, as #rrggbb, or #rrggbbaa when either has an alpha. */
function mix(from: string, to: string, t: number): string {
    if (from === to) return to;
    const [a, b] = [channels(from), channels(to)];
    const mixed = a.map((channel, index) => Math.round(channel + (b[index]! - channel) * t));
    if (mixed[3] === 255) mixed.pop();
    return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Red, green, blue and alpha, 0–255 each, of a CSS hex colour in any of its four lengths. */
function channels(hex: string): number[] {
    const digits = hex.slice(1);
    const pairs = digits.length <= 4 ? [...digits].map((digit) => digit + digit) : (digits.match(/../g) ?? []);
    const values = pairs.map((pair) => parseInt(pair, 16));
    return values.length === 3 ? [...values, 255] : values;
}
