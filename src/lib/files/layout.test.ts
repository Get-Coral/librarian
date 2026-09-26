import { describe, expect, it } from "vitest";
import { buildDestination, buildSidecarDestination, LayoutError } from "./layout";
import { parseRelease } from "./release";

/** Go through the parser, so the two halves are tested as they are used. */
function destinationFor(name: string): string {
	return buildDestination(parseRelease(name));
}

describe("buildDestination", () => {
	it("files a movie in its own folder", () => {
		expect(destinationFor("The.Matrix.1999.1080p.BluRay.x264-GRP.mkv")).toBe(
			"The Matrix (1999)/The Matrix (1999).mkv",
		);
	});

	it("files an episode under a padded season", () => {
		expect(destinationFor("Show.Name.2019.S01E02.1080p.mkv")).toBe(
			"Show Name (2019)/Season 01/Show Name (2019) - S01E02.mkv",
		);
	});

	it("puts season zero in Specials", () => {
		expect(destinationFor("Show.Name.2019.S00E01.mkv")).toBe(
			"Show Name (2019)/Specials/Show Name (2019) - S00E01.mkv",
		);
	});

	it("writes a contiguous multi-episode file as a range", () => {
		expect(destinationFor("Show.Name.2019.S01E01-E02.mkv")).toBe(
			"Show Name (2019)/Season 01/Show Name (2019) - S01E01-E02.mkv",
		);
	});

	it("does not pretend a gap is a range", () => {
		const release = parseRelease("Show.Name.2019.S01E01.mkv");
		release.episodes = [1, 3];

		expect(buildDestination(release)).toBe(
			"Show Name (2019)/Season 01/Show Name (2019) - S01E01E03.mkv",
		);
	});

	it("files a daily show under the year it aired", () => {
		expect(destinationFor("Daily.Show.2019.05.12.1080p.HDTV.mkv")).toBe(
			"Daily Show/Season 2019/Daily Show - 2019-05-12.mkv",
		);
	});

	it("copes with a show that has no year", () => {
		expect(destinationFor("Show.Name.S03E04.mkv")).toBe(
			"Show Name/Season 03/Show Name - S03E04.mkv",
		);
	});

	it("pads an episode number past ninety-nine without truncating it", () => {
		expect(destinationFor("Show.Name.S01E100.mkv")).toBe(
			"Show Name/Season 01/Show Name - S01E100.mkv",
		);
	});

	it("strips characters that are not safe in a path", () => {
		const release = parseRelease("movie.mkv");
		release.kind = "movie";
		release.title = "Face/Off: The Movie";
		release.year = 1997;

		expect(buildDestination(release)).toBe("FaceOff The Movie (1997)/FaceOff The Movie (1997).mkv");
	});

	it("refuses a release it could not identify", () => {
		expect(() => destinationFor("some-random-file.mkv")).toThrow(LayoutError);
	});

	it("refuses an episode with no episode number", () => {
		const release = parseRelease("Show.Name.S01E02.mkv");
		release.episodes = [];

		expect(() => buildDestination(release)).toThrow(LayoutError);
	});
});

describe("buildSidecarDestination", () => {
	const video = "The Matrix (1999)/The Matrix (1999).mkv";

	it("renames a subtitle to match its video", () => {
		expect(buildSidecarDestination(video, "the.matrix.1999.1080p.srt")).toBe(
			"The Matrix (1999)/The Matrix (1999).srt",
		);
	});

	it("keeps a language suffix", () => {
		expect(buildSidecarDestination(video, "the.matrix.en.srt")).toBe(
			"The Matrix (1999)/The Matrix (1999).en.srt",
		);
	});

	it("keeps a language and a flag together, in order", () => {
		expect(buildSidecarDestination(video, "the.matrix.en.forced.srt")).toBe(
			"The Matrix (1999)/The Matrix (1999).en.forced.srt",
		);
	});

	it("does not read a title's last word as a language", () => {
		// "Fly" is three letters, but it is not a language code.
		expect(buildSidecarDestination("The Fly (1986)/The Fly (1986).mkv", "The.Fly.srt")).toBe(
			"The Fly (1986)/The Fly (1986).srt",
		);
	});

	it("leaves named artwork alone, because the name is how it is found", () => {
		expect(buildSidecarDestination(video, "poster.jpg")).toBe("The Matrix (1999)/poster.jpg");
		expect(buildSidecarDestination(video, "Fanart.JPG")).toBe("The Matrix (1999)/fanart.jpg");
	});

	it("renames other artwork alongside the video", () => {
		expect(buildSidecarDestination(video, "the.matrix.1999.nfo")).toBe(
			"The Matrix (1999)/The Matrix (1999).nfo",
		);
	});
});
