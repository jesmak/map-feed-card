import { describe, expect, it } from "vitest";

import en from "../src/localize/languages/en.json";
import { LANGUAGE_CODES } from "../src/localize/localize";

const FILES = import.meta.glob<Record<string, unknown>>("../src/localize/languages/*.json", { eager: true, import: "default" });

function keys(table: Record<string, unknown>, prefix = ""): string[] {
    return Object.entries(table).flatMap(([key, value]) =>
        value !== null && typeof value === "object" ? keys(value as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`],
    );
}

describe("the languages", () => {
    it("include English, which every other falls back to", () => {
        expect(LANGUAGE_CODES).toContain("en");
    });

    it.each(Object.entries(FILES))("%s has the same texts as English", (_path, table) => {
        expect(keys(table).sort()).toEqual(keys(en).sort());
    });
});
