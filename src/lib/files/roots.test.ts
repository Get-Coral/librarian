// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let tree: string;
let roots: typeof import("./roots");
let mappings: typeof import("./mappings");

function mkdir(relative: string): string {
	const absolute = path.join(tree, relative);
	fs.mkdirSync(absolute, { recursive: true });
	return absolute;
}

beforeEach(async () => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-roots-"));
	// Roots are stored realpath-resolved, and /var is a symlink on macOS.
	tree = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tree-")));
	process.env.LIBRARIAN_DATA_DIR = dataDir;
	delete process.env.LIBRARIAN_DOWNLOADS_DIR;
	delete process.env.LIBRARIAN_MEDIA_DIR;
	vi.resetModules();
	roots = await import("./roots");
	mappings = await import("./mappings");
});

afterEach(() => {
	delete process.env.LIBRARIAN_DATA_DIR;
	delete process.env.LIBRARIAN_DOWNLOADS_DIR;
	delete process.env.LIBRARIAN_MEDIA_DIR;
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(tree, { recursive: true, force: true });
});

describe("roots", () => {
	it("arrives switched off", () => {
		const root = roots.createRoot({ label: "Media", kind: "media", path: mkdir("media") });

		// A mounted directory is not permission to use it.
		expect(root.enabled).toBe(false);
		expect(() => roots.requireEnabledRoot(root.id)).toThrow(/turned off/i);
	});

	it("can be turned on", () => {
		const root = roots.createRoot({ label: "Media", kind: "media", path: mkdir("media") });
		roots.updateRoot(root.id, { enabled: true });

		expect(roots.requireEnabledRoot(root.id).enabled).toBe(true);
	});

	it("records whether it can actually be written to", () => {
		const root = roots.createRoot({ label: "Media", kind: "media", path: mkdir("media") });

		expect(root.writable).toBe(true);
	});

	it("refuses anything that is not an existing directory", () => {
		expect(() =>
			roots.createRoot({ label: "Gone", kind: "media", path: path.join(tree, "absent") }),
		).toThrow(roots.RootError);

		fs.writeFileSync(path.join(tree, "file"), "x");
		expect(() =>
			roots.createRoot({ label: "File", kind: "media", path: path.join(tree, "file") }),
		).toThrow(roots.RootError);
	});

	it("refuses a relative path", () => {
		expect(() => roots.createRoot({ label: "Rel", kind: "media", path: "media" })).toThrow(
			roots.RootError,
		);
	});

	it("refuses the same directory twice", () => {
		const target = mkdir("media");
		roots.createRoot({ label: "Media", kind: "media", path: target });

		expect(() => roots.createRoot({ label: "Again", kind: "media", path: target })).toThrow(
			/already a root/i,
		);
	});

	it("rejects an unknown root by id", () => {
		expect(() => roots.requireEnabledRoot("nope")).toThrow(/no such root/i);
	});

	it("seeds from the environment, still switched off", () => {
		process.env.LIBRARIAN_DOWNLOADS_DIR = mkdir("downloads");
		process.env.LIBRARIAN_MEDIA_DIR = mkdir("media");

		const seeded = roots.seedRootsFromEnvironment();

		expect(seeded.map((root) => root.kind).sort()).toEqual(["downloads", "media"]);
		expect(seeded.every((root) => root.enabled)).toBe(false);
		expect(seeded.every((root) => root.source === "env")).toBe(true);
	});

	it("does not overrule an operator on the next boot", () => {
		process.env.LIBRARIAN_MEDIA_DIR = mkdir("media");
		const [seeded] = roots.seedRootsFromEnvironment();
		roots.updateRoot(seeded.id, { enabled: true, label: "My Films" });

		roots.seedRootsFromEnvironment();

		expect(roots.listRoots()).toHaveLength(1);
		expect(roots.getRoot(seeded.id)).toMatchObject({ enabled: true, label: "My Films" });
	});

	it("ignores an environment root that does not exist", () => {
		process.env.LIBRARIAN_MEDIA_DIR = path.join(tree, "absent");

		expect(roots.seedRootsFromEnvironment()).toEqual([]);
		expect(roots.listRoots()).toEqual([]);
	});
});

describe("mappings", () => {
	function enabledRoot(relative: string, kind: "media" | "downloads" = "media") {
		const root = roots.createRoot({ label: relative, kind, path: mkdir(relative) });
		return roots.updateRoot(root.id, { enabled: true });
	}

	it("finds the longest suffix of a Jellyfin location under a root", () => {
		enabledRoot("library");
		mkdir("library/media/movies");

		const [suggestion] = mappings.suggestMappings(["/media/movies"]);

		expect(suggestion).toMatchObject({
			remotePrefix: "/media/movies",
			localPrefix: path.join(tree, "library/media/movies"),
			aligned: false,
		});
	});

	it("says when an install needs no mapping at all", () => {
		const root = enabledRoot("library");
		mkdir("library/media/movies");
		const location = path.join(root.path, "media/movies");

		const [suggestion] = mappings.suggestMappings([location]);

		// Same path both sides: the best possible outcome, and no row needed.
		expect(suggestion.aligned).toBe(true);
	});

	it("ignores roots nobody turned on", () => {
		roots.createRoot({ label: "library", kind: "media", path: mkdir("library") });
		mkdir("library/media/movies");

		expect(mappings.suggestMappings(["/media/movies"])).toEqual([]);
	});

	it("suggests nothing for a location it cannot find", () => {
		enabledRoot("library");

		expect(mappings.suggestMappings(["/somewhere/else"])).toEqual([]);
	});

	it("translates a path through the longest matching prefix", () => {
		mappings.createMapping({ remotePrefix: "/media", localPrefix: "/library/media" });
		mappings.createMapping({
			remotePrefix: "/media/movies",
			localPrefix: "/elsewhere/movies",
		});

		expect(mappings.toLocalPath("/media/movies/A (2019)/A.mkv")).toBe(
			"/elsewhere/movies/A (2019)/A.mkv",
		);
		expect(mappings.toLocalPath("/media/tv/B/B.mkv")).toBe("/library/media/tv/B/B.mkv");
	});

	it("does not match a sibling that merely shares a prefix string", () => {
		mappings.createMapping({ remotePrefix: "/media", localPrefix: "/library/media" });

		// /media-old is not inside /media.
		expect(mappings.toLocalPath("/media-old/x.mkv")).toBe("/media-old/x.mkv");
	});

	it("leaves an unmapped path alone", () => {
		expect(mappings.toLocalPath("/library/media/movies/A.mkv")).toBe("/library/media/movies/A.mkv");
	});

	it("shrugs off a trailing slash", () => {
		mappings.createMapping({ remotePrefix: "/media/", localPrefix: "/library/media/" });

		expect(mappings.toLocalPath("/media/movies/A.mkv")).toBe("/library/media/movies/A.mkv");
	});

	it("refuses a relative mapping", () => {
		expect(() =>
			mappings.createMapping({ remotePrefix: "media", localPrefix: "/library/media" }),
		).toThrow(mappings.MappingError);
	});

	it("remembers that a mapping was proven to work", () => {
		const mapping = mappings.createMapping({
			remotePrefix: "/media",
			localPrefix: "/library/media",
		});
		expect(mapping.verifiedAt).toBeNull();

		mappings.markMappingVerified(mapping.id);

		expect(mappings.listMappings()[0].verifiedAt).not.toBeNull();
	});

	it("matches a root that is the location itself, mounted elsewhere", () => {
		// Jellyfin in a container says /library/media/movies; the same
		// directory is somewhere else entirely on this host. Neither path
		// contains the other, so the evidence is that they end the same way.
		mkdir("stack/library/media/movies");
		const root = roots.createRoot({
			label: "Movies",
			kind: "media",
			path: path.join(tree, "stack/library/media/movies"),
		});
		roots.updateRoot(root.id, { enabled: true });

		const [suggestion] = mappings.suggestMappings(["/library/media/movies"]);

		expect(suggestion).toMatchObject({
			remotePrefix: "/library/media/movies",
			localPrefix: path.join(tree, "stack/library/media/movies"),
			aligned: false,
		});
	});

	it("does not pair a location with a root that ends differently", () => {
		mkdir("stack/library/media/movies");
		const root = roots.createRoot({
			label: "Movies",
			kind: "media",
			path: path.join(tree, "stack/library/media/movies"),
		});
		roots.updateRoot(root.id, { enabled: true });

		expect(mappings.suggestMappings(["/library/media/music"])).toEqual([]);
	});
});
