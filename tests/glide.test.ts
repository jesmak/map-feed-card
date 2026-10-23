import { describe, expect, it } from "vitest";

import type { LngLat } from "../src/feed";
import { cutTrail, MAX_GLIDE_MS, nextGlide, positionAt, type Glide, type Report } from "../src/glide";

const A: LngLat = [27.0, 61.0];
const B: LngLat = [27.1, 61.05];
const C: LngLat = [27.2, 61.1];
const at = (position: LngLat, ms: number): Report => ({ position, at: ms });

describe("a new report for a gliding marker", () => {
    it.each<[string, Report | null, Report, "stay" | "jump" | "glide"]>([
        ["the first report, with nothing to glide from", null, at(B, 30_000), "jump"],
        ["the same place again, later", at(B, 0), at(B, 30_000), "stay"],
        ["the same place, a centimetre apart", at(B, 0), at([B[0] + 1e-7, B[1]], 30_000), "stay"],
        ["a move 30 seconds after the last report", at(A, 0), at(B, 30_000), "glide"],
        ["a move at the longest gap still glided over", at(A, 0), at(B, MAX_GLIDE_MS), "glide"],
        ["a move after a longer gap, a lost item", at(A, 0), at(B, MAX_GLIDE_MS + 1), "jump"],
        ["a move measured at the same time as the last", at(A, 30_000), at(B, 30_000), "jump"],
        ["a move measured before the last, out of order", at(A, 30_000), at(B, 0), "jump"],
    ])("%s", (_, last, report, expected) => {
        const result = nextGlide([1, 2], last, report, 100_000);
        expect(typeof result === "string" ? result : "glide").toBe(expected);
    });

    it("glides from where the marker is drawn, to the new position, over the time between the reports", () => {
        expect(nextGlide([27.05, 61.02], at(A, 1_000), at(B, 16_000), 50_000)).toEqual({
            from: [27.05, 61.02],
            to: B,
            start: 50_000,
            duration: 15_000,
        });
    });
});

describe("where a gliding marker is", () => {
    const glide: Glide = { from: A, to: C, start: 10_000, duration: 20_000 };

    it.each<[string, number, LngLat]>([
        ["before the glide starts", 0, A],
        ["as it starts", 10_000, A],
        ["halfway", 20_000, B],
        ["at its end", 30_000, C],
        ["after it, staying at the newest position", 90_000, C],
    ])("%s", (_, now, expected) => {
        const [lon, lat] = positionAt(glide, now);
        expect(lon).toBeCloseTo(expected[0], 9);
        expect(lat).toBeCloseTo(expected[1], 9);
    });

    it("crosses the antimeridian the short way", () => {
        const across: Glide = { from: [179.9, 10], to: [-179.9, 10], start: 0, duration: 10 };
        expect(positionAt(across, 5)[0]).toBeCloseTo(180, 9);
        expect(positionAt(across, 10)[0]).toBeCloseTo(-179.9, 9);
        expect(Math.abs(positionAt(across, 2.5)[0])).toBeGreaterThan(179.9);
    });
});

describe("a gliding item's trail", () => {
    // Along latitude 60, where a degree of longitude is half a degree of latitude, and one corner north.
    const S: LngLat = [24.9, 60.0];
    const P: LngLat = [25.0, 60.0];
    const Q: LngLat = [25.1, 60.0];
    const R: LngLat = [25.2, 60.0];
    const N: LngLat = [25.1, 60.05];
    const glide = (from: LngLat, to: LngLat): Glide => ({ from, to, start: 0, duration: 15_000 });
    const rounded = (path: LngLat[]) => path.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)]);

    it.each<[string, Glide, LngLat, LngLat[], LngLat[]]>([
        ["ends at the marker, where the marker is on it", glide(P, Q), [25.05, 60.0], [S, P, Q], [S, P, [25.05, 60.0]]],
        [
            "drops what lies ahead of the marker, samples between the reports included",
            glide(P, R),
            [25.15, 60.0],
            [S, P, Q, [25.18, 60.0], R],
            [S, P, Q, [25.15, 60.0]],
        ],
        [
            "is cut without the report glided from, which a simplified trail leaves out of a straight leg",
            glide(P, Q),
            [25.05, 60.0],
            [S, Q],
            [S, [25.05, 60.0]],
        ],
        [
            "is cut after a glide that a report interrupted, whose start was never reported",
            glide([25.05, 60.0], R),
            [25.08, 60.0],
            [S, Q, R],
            [S, [25.08, 60.0]],
        ],
        [
            "across a corner, goes to the trail beside the marker and then to the marker",
            glide([25.05, 60.0], N),
            [25.075, 60.025],
            [S, P, Q, N],
            [S, P, Q, [25.1, 60.025], [25.075, 60.025]],
        ],
        [
            "looks back no further than twice the glide, so an older pass by the marker is left alone",
            glide(P, Q),
            [25.05, 60.001],
            [[25.05, 59.99], [25.05, 60.3], [24.9, 60.3], S, P, Q],
            [[25.05, 59.99], [25.05, 60.3], [24.9, 60.3], S, P, [25.05, 60.0], [25.05, 60.001]],
        ],
        [
            "takes a nearest point between one and two glides back, on a trail longer than the glide",
            glide(P, Q),
            [25.005, 60.0],
            [S, P, [25.0, 60.04], [25.1, 60.04], Q],
            [S, P, [25.005, 60.0]],
        ],
        [
            "leaves alone an older pass by the marker that begins just over two glides back",
            glide(P, Q),
            [25.05, 60.002],
            [[25.05, 59.99], [25.05, 60.03], [24.95, 60.03], [24.95, 60.0], P, Q],
            [[25.05, 59.99], [25.05, 60.03], [24.95, 60.03], [24.95, 60.0], P, [25.05, 60.0], [25.05, 60.002]],
        ],
        [
            "measures a degree of longitude as shorter than one of latitude, so the nearer of two segments is the one east",
            glide([25.05, 60.0], N),
            [25.08, 60.015],
            [S, P, Q, N],
            [S, P, Q, [25.1, 60.015], [25.08, 60.015]],
        ],
        [
            "is cut across the antimeridian",
            glide([179.95, 10.0], [-179.95, 10.0]),
            [-179.99, 10.0],
            [
                [179.8, 10.0],
                [179.95, 10.0],
                [-179.95, 10.0],
            ],
            [
                [179.8, 10.0],
                [179.95, 10.0],
                [-179.99, 10.0],
            ],
        ],
        ["is left alone when it ends somewhere else than the item", glide(P, Q), [25.05, 60.0], [S, P], [S, P]],
        ["is left alone when it is a single position", glide(P, Q), [25.05, 60.0], [Q], [Q]],
    ])("%s", (_, glide, drawn, path, expected) => {
        expect(rounded(cutTrail(path, glide, drawn))).toEqual(rounded(expected));
    });
});
