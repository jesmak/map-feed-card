/**
 * Gliding markers, a feed's `glide` option. Between two reports a moving item's marker travels in a straight line from
 * the position before to the newest one, taking as long as the source took between them. It never runs ahead of the
 * newest report, at the price of showing each one an update late.
 */
import type { LngLat } from "./feed";

/** A longer gap is a lost item or a stalled feed rather than a step to glide over, and the marker jumps. */
export const MAX_GLIDE_MS = 120_000;

/** A marker's newest position, and when it was measured, or when its feed last changed when the feed doesn't say. */
export interface Report {
    position: LngLat;
    at: number;
}

export interface Glide {
    from: LngLat;
    to: LngLat;
    start: number;
    duration: number;
}

/**
 * What a new report does to a gliding marker drawn at `current`: nothing when the item hasn't moved, a jump when there
 * is nothing to glide from or the gap is no step, otherwise a glide from where the marker is now.
 */
export function nextGlide(current: LngLat, last: Report | null, report: Report, now: number): "stay" | "jump" | Glide {
    if (last && samePosition(last.position, report.position)) return "stay";
    const duration = last ? report.at - last.at : 0;
    if (!last || duration <= 0 || duration > MAX_GLIDE_MS) return "jump";
    return { from: current, to: report.position, start: now, duration };
}

export function positionAt(glide: Glide, now: number): LngLat {
    const t = Math.min(1, Math.max(0, (now - glide.start) / glide.duration));
    // Across the antimeridian the short way round, not back across the whole world.
    return [wrap(glide.from[0] + wrap(glide.to[0] - glide.from[0]) * t), glide.from[1] + (glide.to[1] - glide.from[1]) * t];
}

/**
 * A line that ends where its point was reported, such as an aircraft's trail, cut to end at the gliding marker instead:
 * at the line's point nearest the marker, and then the marker. The reports needn't be on the line, as a simplified trail
 * leaves out those on a straight leg. It searches only the segments that begin within twice the glide's length of the
 * line's end, so that a holding pattern's older pass by the marker isn't taken for where it is now. A line that ends
 * anywhere else is left as it is.
 */
export function cutTrail(path: LngLat[], glide: Glide, drawn: LngLat): LngLat[] {
    if (path.length < 2 || !samePosition(path[path.length - 1], glide.to)) return path;
    // Flat around the marker, a degree of longitude as long as it is there, which is close enough for a glide's length.
    const scale = Math.cos((drawn[1] * Math.PI) / 180);
    const flat = ([lon, lat]: LngLat) => [wrap(lon - drawn[0]) * scale, lat - drawn[1]];
    const [fromX, fromY] = flat(glide.from);
    const [toX, toY] = flat(glide.to);
    const reach = 2 * Math.hypot(toX - fromX, toY - fromY);
    let best = { distance: Infinity, index: path.length - 1, t: 1 };
    let walked = 0;
    for (let index = path.length - 1; index > 0 && walked <= reach; index--) {
        const [ax, ay] = flat(path[index - 1]);
        const [bx, by] = flat(path[index]);
        const length = Math.hypot(bx - ax, by - ay);
        // The segment's point nearest the marker, which is at the origin.
        const t = length === 0 ? 0 : Math.min(1, Math.max(0, -(ax * (bx - ax) + ay * (by - ay)) / length ** 2));
        const distance = Math.hypot(ax + (bx - ax) * t, ay + (by - ay) * t);
        if (distance < best.distance) best = { distance, index, t };
        walked += length;
    }
    const [a, b] = [path[best.index - 1], path[best.index]];
    const cut: LngLat = [wrap(a[0] + wrap(b[0] - a[0]) * best.t), a[1] + (b[1] - a[1]) * best.t];
    const trail = path.slice(0, best.index);
    for (const position of [cut, drawn]) if (!samePosition(trail[trail.length - 1], position)) trail.push(position);
    return trail;
}

/** Closer than about ten centimetres is the same place, as feeds round to about a metre. */
function samePosition(a: LngLat, b: LngLat): boolean {
    return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

function wrap(lon: number): number {
    return lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
}
