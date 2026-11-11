import { describe, expect, it } from "vitest";

import { linePieces } from "../src/blend";
import type { LngLat } from "../src/feed";

const A: LngLat = [24, 60];
const B: LngLat = [24.4, 60];
const C: LngLat = [24.8, 60];

describe("a line's pieces", () => {
    it("is one piece when every position is alike", () => {
        expect(linePieces([A, B, C], ["#ff0000", "#ff0000", "#ff0000"], [1, 1, 1])).toEqual([
            { path: [A, B, C], color: "#ff0000", opacity: 1 },
        ]);
    });

    it("blends a stretch between two colours in steps, and joins what comes after in the last one's colour", () => {
        const pieces = linePieces([A, B, C], ["#000000", "#000060", "#000060"], [1, 1, 1]);
        expect(pieces.map((piece) => piece.color)).toEqual(["#00000c", "#000024", "#00003c", "#000054", "#000060"]);
        expect(pieces.map((piece) => piece.path.map(([lon]) => +lon.toFixed(3)))).toEqual([
            [24, 24.1],
            [24.1, 24.2],
            [24.2, 24.3],
            [24.3, 24.4],
            [24.4, 24.8],
        ]);
        expect(pieces[3]!.path[1]).toBe(B);
    });

    it("draws a stretch between two colours that hardly differ as one piece, and one far apart in six at most", () => {
        expect(linePieces([A, B], ["#4131f2", "#3e34f2"], [1, 1])).toEqual([{ path: [A, B], color: "#4033f2", opacity: 1 }]);
        expect(linePieces([A, B], ["#000000", "#ffffff"], [1, 1])).toHaveLength(6);
    });

    it("fades a stretch between two opacities, in one colour", () => {
        const pieces = linePieces([A, B], ["#abc", "#abc"], [0.4, 1]);
        expect(pieces.map((piece) => piece.opacity)).toEqual([0.48, 0.63, 0.78, 0.93]);
        expect(new Set(pieces.map((piece) => piece.color))).toEqual(new Set(["#abc"]));
    });

    it("blends colours of different lengths, and keeps an alpha", () => {
        expect(linePieces([A, B], ["#000", "#606060"], [1, 1])[0]!.color).toBe("#0c0c0c");
        expect(linePieces([A, B], ["#00000000", "#606060"], [1, 1])[3]!.color).toBe("#38383895");
    });
});
