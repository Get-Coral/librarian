import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ImportPlan, planImport, runImport } from "./import";
import { PathSafetyError } from "./paths";

let workspace: string;
let downloads: string;
let media: string;

function make(root: string, relative: string, contents = "payload"): string {
	const absolute = path.join(root, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, contents);
	return absolute;
}

function plan(request: Partial<Parameters<typeof planImport>[0]> & { path: string }): ImportPlan {
	return planImport({ sourceRoot: downloads, destinationRoot: media, ...request });
}

function tree(root: string, prefix = ""): string[] {
	return fs
		.readdirSync(path.join(root, prefix), { withFileTypes: true })
		.flatMap((entry) => {
			const relative = prefix === "" ? entry.name : path.join(prefix, entry.name);
			return entry.isDirectory() ? tree(root, relative) : [relative];
		})
		.sort();
}

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-import-"));
	downloads = path.join(workspace, "downloads");
	media = path.join(workspace, "media");
	fs.mkdirSync(downloads);
	fs.mkdirSync(media);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(workspace, { recursive: true, force: true });
});

describe("planImport", () => {
	it("plans a single movie file", () => {
		make(downloads, "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv");

		const result = plan({ path: "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv" });

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].video.to).toBe("The Matrix (1999)/The Matrix (1999).mkv");
		expect(result.strategy).toBe("hardlink");
		expect(result.warnings).toEqual([]);
	});

	it("writes nothing at all", () => {
		make(downloads, "The.Matrix.1999.1080p.mkv");

		plan({ path: "The.Matrix.1999.1080p.mkv" });

		expect(tree(media)).toEqual([]);
	});

	it("plans a release folder with its subtitle", () => {
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.en.srt");

		const result = plan({ path: "The.Matrix.1999.1080p-GRP" });

		expect(result.entries[0].sidecars.map((file) => file.to)).toEqual([
			"The Matrix (1999)/The Matrix (1999).en.srt",
		]);
	});

	it("takes subtitles out of a Subs folder", () => {
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/Subs/the.matrix.1999.en.srt");

		const result = plan({ path: "The.Matrix.1999.1080p-GRP" });

		expect(result.entries[0].sidecars.map((file) => file.to)).toEqual([
			"The Matrix (1999)/The Matrix (1999).en.srt",
		]);
	});

	it("leaves samples and extras where they are", () => {
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/sample.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/Sample/the.matrix.sample.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/Featurettes/making.of.mkv");

		const result = plan({ path: "The.Matrix.1999.1080p-GRP" });

		expect(result.entries).toHaveLength(1);
		expect(result.warnings.filter((warning) => warning.code === "skipped")).toHaveLength(3);
	});

	it("does not mistake a title containing 'sample' for a sample", () => {
		make(downloads, "Resample.Nation.2019.1080p.mkv");

		expect(plan({ path: "Resample.Nation.2019.1080p.mkv" }).entries).toHaveLength(1);
	});

	it("plans a season pack as one entry per episode", () => {
		for (const episode of ["S01E01", "S01E02", "S01E03"]) {
			make(downloads, `Show.Name.S01.1080p-GRP/Show.Name.${episode}.1080p.mkv`);
		}

		const result = plan({ path: "Show.Name.S01.1080p-GRP" });

		expect(result.entries).toHaveLength(3);
		expect(result.entries.map((entry) => entry.video.to).sort()).toEqual([
			"Show Name/Season 01/Show Name - S01E01.mkv",
			"Show Name/Season 01/Show Name - S01E02.mkv",
			"Show Name/Season 01/Show Name - S01E03.mkv",
		]);
	});

	it("reports a release it cannot place instead of refusing the preview", () => {
		make(downloads, "unnamed.mkv");

		const result = plan({ path: "unnamed.mkv" });

		// The operator needs to see this one to fix it, so it has to render.
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].problem).toMatch(/could not tell what this release is/i);
		expect(result.entries[0].video.to).toBeNull();
		expect(result.warnings.map((warning) => warning.code)).toContain("unplaceable");
	});

	it("places it once the operator says what it is", () => {
		make(downloads, "unnamed.mkv");

		const result = plan({
			path: "unnamed.mkv",
			overrides: { "unnamed.mkv": { kind: "movie", title: "Unnamed Film", year: 2021 } },
		});

		expect(result.entries[0].problem).toBeNull();
		expect(result.entries[0].video.to).toBe("Unnamed Film (2021)/Unnamed Film (2021).mkv");
	});

	it("reports a download with no video in it", () => {
		make(downloads, "release/readme.nfo");

		const result = plan({ path: "release" });

		expect(result.entries).toEqual([]);
		expect(result.warnings[0].code).toBe("no-video");
	});

	it("flags a shaky parse instead of hiding it", () => {
		make(downloads, "Show.Name.S01E02.mkv");
		make(downloads, "junk/video.mkv");

		const confident = plan({ path: "Show.Name.S01E02.mkv" });
		expect(confident.warnings).toEqual([]);

		const shaky = plan({
			path: "junk/video.mkv",
			overrides: { "junk/video.mkv": { kind: "movie", title: "Something", year: 2020 } },
		});
		expect(shaky.warnings.map((warning) => warning.code)).toContain("low-confidence");
	});

	it("takes the operator's corrections", () => {
		make(downloads, "The.Matrix.1999.1080p.mkv");

		const result = plan({
			path: "The.Matrix.1999.1080p.mkv",
			overrides: { "The.Matrix.1999.1080p.mkv": { title: "The Matrix Reloaded", year: 2003 } },
		});

		expect(result.entries[0].video.to).toBe(
			"The Matrix Reloaded (2003)/The Matrix Reloaded (2003).mkv",
		);
	});

	it("keeps a corrected episode number in step with the list", () => {
		make(downloads, "Show.Name.S01E02.mkv");

		const result = plan({
			path: "Show.Name.S01E02.mkv",
			overrides: { "Show.Name.S01E02.mkv": { episode: 7 } },
		});

		expect(result.entries[0].release.episodes).toEqual([7]);
		expect(result.entries[0].video.to).toBe("Show Name/Season 01/Show Name - S01E07.mkv");
	});

	it("warns when something is already in the way", () => {
		make(downloads, "The.Matrix.1999.1080p.mkv");
		make(media, "The Matrix (1999)/The Matrix (1999).mkv", "already here");

		const result = plan({ path: "The.Matrix.1999.1080p.mkv", collision: "suffix" });

		expect(result.warnings.map((warning) => warning.code)).toContain("collision");
		expect(result.entries[0].video.to).toBe("The Matrix (1999)/The Matrix (1999) (2).mkv");
	});

	it("needs no room for a hardlink and the full size for a copy", () => {
		make(downloads, "The.Matrix.1999.1080p.mkv", "payload");

		const linked = plan({ path: "The.Matrix.1999.1080p.mkv" });
		expect(linked.bytesNeeded).toBe(0);
		expect(linked.totalBytes).toBe(Buffer.byteLength("payload"));

		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
		});
		const copied = plan({ path: "The.Matrix.1999.1080p.mkv" });
		expect(copied.strategy).toBe("copy");
		expect(copied.bytesNeeded).toBe(copied.totalBytes);
	});

	it("refuses a path that leaves the root", () => {
		make(downloads, "The.Matrix.1999.1080p.mkv");

		expect(() => plan({ path: "../escape.mkv" })).toThrow(PathSafetyError);
		expect(() => plan({ path: "/etc/passwd" })).toThrow(PathSafetyError);
	});
});

describe("runImport", () => {
	it("hardlinks the release into the library and leaves the download seeding", () => {
		const source = make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.en.srt");

		const result = runImport(plan({ path: "The.Matrix.1999.1080p-GRP" }));

		expect(tree(media)).toEqual([
			"The Matrix (1999)/The Matrix (1999).en.srt",
			"The Matrix (1999)/The Matrix (1999).mkv",
		]);
		expect(fs.existsSync(source)).toBe(true);
		expect(fs.statSync(source).ino).toBe(
			fs.statSync(path.join(media, "The Matrix (1999)/The Matrix (1999).mkv")).ino,
		);
		expect(result.warnings).toEqual([]);
	});

	it("moves the video before anything that decorates it", () => {
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.en.srt");

		const result = runImport(plan({ path: "The.Matrix.1999.1080p-GRP" }));

		expect(result.imported.map((outcome) => outcome.item.kind)).toEqual(["video", "sidecar"]);
	});

	it("does not abandon a film because a subtitle could not be placed", () => {
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.mkv");
		make(downloads, "The.Matrix.1999.1080p-GRP/the.matrix.1999.en.srt");
		// Something already occupies the subtitle's destination.
		make(media, "The Matrix (1999)/The Matrix (1999).en.srt", "existing");

		const result = runImport(plan({ path: "The.Matrix.1999.1080p-GRP" }));

		expect(result.imported.map((outcome) => outcome.item.kind)).toEqual(["video"]);
		expect(result.warnings[0].code).toBe("skipped");
		expect(fs.existsSync(path.join(media, "The Matrix (1999)/The Matrix (1999).mkv"))).toBe(true);
		expect(
			fs.readFileSync(path.join(media, "The Matrix (1999)/The Matrix (1999).en.srt"), "utf8"),
		).toBe("existing");
	});

	it("imports a season pack in one go", () => {
		for (const episode of ["S01E01", "S01E02"]) {
			make(downloads, `Show.Name.S01.1080p-GRP/Show.Name.${episode}.1080p.mkv`);
		}

		runImport(plan({ path: "Show.Name.S01.1080p-GRP" }));

		expect(tree(media)).toEqual([
			"Show Name/Season 01/Show Name - S01E01.mkv",
			"Show Name/Season 01/Show Name - S01E02.mkv",
		]);
	});

	it("imports the episodes it understands and skips the one it does not", () => {
		make(downloads, "Show.Name.S01.1080p-GRP/Show.Name.S01E01.1080p.mkv");
		make(downloads, "Show.Name.S01.1080p-GRP/Show.Name.S01E02.1080p.mkv");
		make(downloads, "Show.Name.S01.1080p-GRP/bonus.mkv");

		const result = runImport(plan({ path: "Show.Name.S01.1080p-GRP" }));

		expect(tree(media)).toEqual([
			"Show Name/Season 01/Show Name - S01E01.mkv",
			"Show Name/Season 01/Show Name - S01E02.mkv",
		]);
		expect(result.warnings.map((warning) => warning.code)).toContain("unplaceable");
	});
});
