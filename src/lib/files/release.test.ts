import { describe, expect, it } from "vitest";
import {
	isSidecarFile,
	isVideoFile,
	type ParsedRelease,
	parseRelease,
	parseReleaseFromPath,
} from "./release";

type Expectation = Partial<ParsedRelease>;

/** Names taken from the shapes that actually turn up in a downloads folder. */
const MOVIES: [string, Expectation][] = [
	[
		"The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv",
		{
			kind: "movie",
			title: "The Matrix",
			year: 1999,
			resolution: "1080p",
			source: "bluray",
			group: "GROUP",
			extension: ".mkv",
			confidence: "high",
		},
	],
	[
		// The title ends in a number that looks exactly like a year.
		"Blade Runner 2049 2017 2160p UHD BluRay x265-TERMINAL.mkv",
		{ kind: "movie", title: "Blade Runner 2049", year: 2017, resolution: "2160p" },
	],
	[
		// A year in first position belongs to the title.
		"2012.2009.1080p.BluRay.mkv",
		{ kind: "movie", title: "2012", year: 2009 },
	],
	["1917.2019.1080p.WEB-DL.mkv", { kind: "movie", title: "1917", year: 2019, source: "web-dl" }],
	["The Movie (2019).mkv", { kind: "movie", title: "The Movie", year: 2019 }],
	[
		"Movie.Name.2019.EXTENDED.1080p.mkv",
		{ kind: "movie", title: "Movie Name", year: 2019, resolution: "1080p" },
	],
	[
		// "Web" opens the title, so it cannot be the start of the noise.
		"Web of Lies 2019 1080p.mkv",
		{ kind: "movie", title: "Web of Lies", year: 2019 },
	],
	[
		"[RlsGroup] The.Movie.2019.1080p.mkv",
		{ kind: "movie", title: "The Movie", year: 2019, resolution: "1080p" },
	],
];

const EPISODES: [string, Expectation][] = [
	[
		"Show.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv",
		{
			kind: "episode",
			title: "Show Name",
			season: 1,
			episode: 2,
			episodes: [2],
			source: "web-dl",
			group: "GRP",
			confidence: "high",
		},
	],
	[
		"Show Name - S01E02 - Episode Title.mkv",
		{ kind: "episode", title: "Show Name", season: 1, episode: 2, group: null },
	],
	[
		"Show.Name.2019.S02E10.mkv",
		{ kind: "episode", title: "Show Name", year: 2019, season: 2, episode: 10 },
	],
	["Show.Name.1x02.mkv", { kind: "episode", title: "Show Name", season: 1, episode: 2 }],
	["Show.Name.S01E01E02.1080p.mkv", { kind: "episode", season: 1, episode: 1, episodes: [1, 2] }],
	["Show.Name.S01E01-E02.mkv", { kind: "episode", season: 1, episode: 1, episodes: [1, 2] }],
	[
		"Show.Name.Season 1 Episode 5.mkv",
		{ kind: "episode", title: "Show Name", season: 1, episode: 5 },
	],
	["Show.Name.S00E01.mkv", { kind: "episode", title: "Show Name", season: 0, episode: 1 }],
	[
		"Show.Name.2019.05.12.1080p.HDTV.mkv",
		{
			kind: "episode",
			title: "Show Name",
			airDate: "2019-05-12",
			season: null,
			episode: null,
			year: null,
		},
	],
];

describe("parseRelease", () => {
	it.each(MOVIES)("reads the movie %s", (name, expected) => {
		expect(parseRelease(name)).toMatchObject(expected);
	});

	it.each(EPISODES)("reads the episode %s", (name, expected) => {
		expect(parseRelease(name)).toMatchObject(expected);
	});

	it("admits when a name says nothing", () => {
		expect(parseRelease("movie.mkv")).toMatchObject({
			kind: "unknown",
			confidence: "low",
			year: null,
		});
	});

	it("treats an episode without a year as confident anyway", () => {
		// SxxExx is unambiguous in a way a bare movie title never is.
		expect(parseRelease("Show.Name.S01E02.mkv").confidence).toBe("high");
	});

	it("keeps the extension only when it is one it recognises", () => {
		expect(parseRelease("The.Movie.2019.mkv").extension).toBe(".mkv");
		// A release folder, not a file: ".2019" is not an extension.
		expect(parseRelease("The.Movie.2019.1080p-GRP").extension).toBe("");
	});

	it("does not mistake a title's trailing words for a release group", () => {
		expect(parseRelease("Show Name - S01E02 - The Reckoning.mkv").group).toBeNull();
	});
});

describe("parseReleaseFromPath", () => {
	it("falls back to the folder when the file name carries nothing", () => {
		const parsed = parseReleaseFromPath("The.Movie.2019.1080p-GRP/movie.mkv");

		expect(parsed).toMatchObject({
			kind: "movie",
			title: "The Movie",
			year: 2019,
			extension: ".mkv",
		});
	});

	it("keeps the file's own extension when borrowing from the folder", () => {
		expect(parseReleaseFromPath("Show.Name.S01E02.1080p-GRP/video.mp4")).toMatchObject({
			kind: "episode",
			season: 1,
			episode: 2,
			extension: ".mp4",
		});
	});

	it("prefers the file when the file is already clear", () => {
		expect(parseReleaseFromPath("Some.Junk.Folder/The.Matrix.1999.1080p.mkv")).toMatchObject({
			title: "The Matrix",
			year: 1999,
		});
	});

	it("copes with a bare file name", () => {
		expect(parseReleaseFromPath("The.Matrix.1999.mkv")).toMatchObject({ title: "The Matrix" });
	});

	it("stays low-confidence when neither the file nor the folder helps", () => {
		expect(parseReleaseFromPath("stuff/movie.mkv").confidence).toBe("low");
	});
});

describe("file kinds", () => {
	it("knows a video", () => {
		expect(isVideoFile("movie.mkv")).toBe(true);
		expect(isVideoFile("MOVIE.MP4")).toBe(true);
		expect(isVideoFile("movie.srt")).toBe(false);
	});

	it("knows a sidecar", () => {
		expect(isSidecarFile("movie.en.srt")).toBe(true);
		expect(isSidecarFile("poster.jpg")).toBe(true);
		expect(isSidecarFile("movie.nfo")).toBe(true);
		expect(isSidecarFile("movie.mkv")).toBe(false);
	});

	it("ignores the junk that ships alongside a release", () => {
		expect(isVideoFile("rarbg.txt")).toBe(false);
		expect(isSidecarFile("rarbg.txt")).toBe(false);
	});
});

describe("casing", () => {
	it("gives an all-lowercase release its capitals back", () => {
		expect(parseRelease("coral.test.movie.2019.1080p.bluray.x264-coral.mkv").title).toBe(
			"Coral Test Movie",
		);
	});

	it("keeps minor words lowercase inside a title", () => {
		expect(parseRelease("the.lord.of.the.rings.2001.1080p.mkv").title).toBe(
			"The Lord of the Rings",
		);
	});

	it("capitalises both halves of a hyphenated name", () => {
		expect(parseRelease("spider-man.2002.1080p.mkv").title).toBe("Spider-Man");
	});

	it("leaves a title that already has capitals exactly as it found it", () => {
		// Deliberate casing has to survive: iRobot is not IRobot.
		expect(parseRelease("iRobot.2004.1080p.mkv").title).toBe("iRobot");
		expect(parseRelease("The.Matrix.1999.1080p.mkv").title).toBe("The Matrix");
	});

	it("does not touch a title that is all digits", () => {
		expect(parseRelease("2012.2009.1080p.mkv").title).toBe("2012");
	});
});
