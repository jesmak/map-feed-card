/**
 * Bundles src/ into the single file HACS installs: dist/map-feed-card.js
 *
 * lit, MapLibre and @versatiles/style are bundled; Home Assistant doesn't hand cards a copy of them. Our own code is
 * not minified, so anyone can read what runs in their browser. MapLibre comes minified as it is published.
 */
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { cwd } from "node:process";

/**
 * esbuild's stand-in for the `import.meta.glob` of vite, which the tests run on: an eager glob of the
 * files in one folder, such as `import.meta.glob('./languages/*.json', { eager: true, import: 'default' })`,
 * becomes an import of each file. This is what lets a language be added by adding its file alone.
 */
const importGlob = {
    name: "import-glob",
    setup(build) {
        build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8");
            const call = /import\.meta\.glob(?:<[^(]*>)?\(\s*["']\.\/([\w/-]+)\/\*(\.\w+)["'][^)]*\)/g;
            if (!call.test(source)) {
                return undefined;
            }
            const imports = [];
            const contents = await replaceAsync(source, call, async (_match, folder, extension) => {
                const files = (await readdir(join(dirname(path), folder))).filter((file) => file.endsWith(extension)).sort();
                const entries = files.map((file) => {
                    const name = `__glob${imports.length}`;
                    imports.push(`import ${name} from './${folder}/${file}';`);
                    return `'./${folder}/${file}': ${name}`;
                });
                return `{ ${entries.join(", ")} }`;
            });
            return { contents: `${imports.join("\n")}\n${contents}`, loader: "ts" };
        });
    },
};

/**
 * vite's `?raw` imports, which the tests run on: the file's text as a string. MapLibre's worker and stylesheet come in
 * this way, so the card stays one file.
 */
const importRaw = {
    name: "import-raw",
    setup(build) {
        build.onResolve({ filter: /\?raw$/ }, async ({ path, resolveDir, kind, importer }) => {
            const resolved = await build.resolve(path.slice(0, -"?raw".length), { resolveDir, kind, importer });
            if (resolved.errors.length) return { errors: resolved.errors };
            // esbuild writes the path into the bundle as a comment, so it is kept relative: the same on every machine.
            return { path: relative(cwd(), resolved.path), namespace: "raw" };
        });
        build.onLoad({ filter: /.*/, namespace: "raw" }, async ({ path }) => ({ contents: await readFile(path, "utf8"), loader: "text" }));
    },
};

async function replaceAsync(text, pattern, replacer) {
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
        parts.push(text.slice(last, match.index), await replacer(...match));
        last = match.index + match[0].length;
    }
    return parts.join("") + text.slice(last);
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await build({
    entryPoints: ["src/map-feed-card.ts"],
    outfile: "dist/map-feed-card.js",
    bundle: true,
    format: "esm",
    target: "es2020",
    minify: false,
    // MapLibre's licence stays with it in the bundle (LICENSE-maplibre-gl).
    legalComments: "inline",
    banner: {
        js: `/*! ${packageJson.name} ${packageJson.version} | MIT License */`,
    },
    define: {
        __CARD_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: [importGlob, importRaw],
    logLevel: "info",
});

// A glob the plugin missed would leave the card without its languages, and only a browser would notice.
const bundle = await readFile("dist/map-feed-card.js", "utf8");
if (bundle.includes("import.meta.glob")) {
    throw new Error("import.meta.glob was left in the bundle: the import-glob plugin did not match it");
}
// A path from this machine would make the committed build differ from CI's, and doesn't belong in a public file.
if (bundle.includes(cwd())) {
    throw new Error(`The bundle contains ${cwd()}: an import's absolute path was left in it`);
}
