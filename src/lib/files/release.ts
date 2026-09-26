import path from "node:path";

/**
 * Working out what a downloaded file actually is, from its name.
 *
 * Release names are a folk convention, not a format, so this is a heuristic
 * and is treated as one: every parse carries a confidence, the preview always
 * shows what was inferred, and the operator can always correct it before
 * anything moves. The mitigation for an imperfect parser is not a better
 * parser — it is never trusting it silently.
 *
 * Pure: strings in, a plain object out. No filesystem, no network.
 */

const VIDEO_EXTENSIONS = new Set([
	".mkv",
	".mp4",
	".m4v",
	".avi",
	".mov",
	".wmv",
	".mpg",
	".mpeg",
	".m2ts",
	".ts",
	".webm",
	".flv",
	".divx",
	".iso",
]);

const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".sup"]);

const ARTWORK_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tbn", ".nfo"]);

/** Files worth importing on their own. */
export function isVideoFile(name: string): boolean {
	return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Files that travel with a video rather than standing alone. */
export function isSidecarFile(name: string): boolean {
	const extension = path.extname(name).toLowerCase();
	return SUBTITLE_EXTENSIONS.has(extension) || ARTWORK_EXTENSIONS.has(extension);
}

function knownExtension(name: string): string {
	const extension = path.extname(name).toLowerCase();
	return VIDEO_EXTENSIONS.has(extension) ||
		SUBTITLE_EXTENSIONS.has(extension) ||
		ARTWORK_EXTENSIONS.has(extension)
		? extension
		: "";
}

/**
 * Tokens that mark the end of a title and the start of the technical
 * description. Everything after the first one is noise as far as naming goes.
 */
const QUALITY_TOKEN =
	/\b(?:4320p|2160p|1440p|1080p|720p|576p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|bdremux|remux|web-?dl|web-?rip|webdl|hdtv|pdtv|dvdrip|dvdscr|hdrip|cam|telesync|x264|x265|h\.?264|h\.?265|hevc|xvid|divx|av1|10bit|8bit|hdr10\+?|hdr|dovi|sdr|aac\d?|ac3|eac3|dts(?:-hd)?|truehd|atmos|ddp?\d(?:\s\d)?|flac|opus|proper|repack|internal|limited|extended|unrated|remastered|imax|multi|dual|subbed|dubbed|hardcoded|readnfo)\b/i;

const RESOLUTION = /\b(4320p|2160p|1440p|1080p|720p|576p|480p|4k|uhd)\b/i;

const SOURCE =
	/\b(bluray|blu-ray|bdremux|bdrip|brrip|remux|web-?dl|web-?rip|webdl|hdtv|pdtv|dvdrip|dvdscr|hdrip)\b/i;

/** `S01E02`, plus any further episodes glued on: `S01E01E02`, `S01E01-E02`. */
const SEASON_EPISODE = /\bS(\d{1,2})\s?E(\d{1,3})((?:\s?-?\s?E?\d{1,3})*)\b/i;

/** The older `1x02` form. */
const SEASON_X_EPISODE = /\b(\d{1,2})x(\d{1,3})\b/i;

const SPELLED_OUT = /\bSeason\s?(\d{1,2})\s?Episode\s?(\d{1,3})\b/i;

/** A dated episode of a daily show. */
const AIR_DATE = /\b((?:19|20)\d{2})[\s-](\d{2})[\s-](\d{2})\b/;

const YEAR = /\b((?:19|20)\d{2})\b/g;

/**
 * Dots and underscores are separators in every release convention, and a
 * leading `[Group]` is an anime one. Hyphens survive: they carry the release
 * group and the `E01-E02` range.
 */
function normalize(name: string): string {
	return name
		.replace(/^\s*\[[^\]]*\]\s*/, "")
		.replace(/[._]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Words that stay lowercase inside a title, unless they open or close it.
 */
const MINOR_WORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"but",
	"by",
	"for",
	"from",
	"in",
	"nor",
	"of",
	"on",
	"or",
	"the",
	"to",
	"via",
	"vs",
	"with",
]);

function capitalize(word: string): string {
	// Hyphenated names get both halves: "spider-man" is "Spider-Man".
	return word.replace(/(^|-)([a-z])/g, (_match, lead, letter) => lead + letter.toUpperCase());
}

/**
 * Give an all-lowercase title its capitals back.
 *
 * Scene releases are routinely lowercase throughout, and filing
 * "coral test movie (2019)" into someone's library is not acceptable output.
 * Only applied when there is no capital anywhere: a name that already has one
 * has made a choice, and "S.W.A.T." or "iRobot" must survive it.
 */
function restoreTitleCase(title: string): string {
	if (title !== title.toLowerCase() || !/[a-z]/.test(title)) return title;

	const words = title.split(" ");
	return words
		.map((word, index) =>
			index > 0 && index < words.length - 1 && MINOR_WORDS.has(word) ? word : capitalize(word),
		)
		.join(" ");
}

function cleanTitle(raw: string): string {
	return raw
		.replace(/[([{].*$/, "")
		.replace(/[\s\-–—:]+$/, "")
		.replace(/^[\s\-–—]+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

function matchIndex(value: string, pattern: RegExp): number {
	const match = value.match(pattern);
	return match?.index === undefined ? -1 : match.index;
}

/** Every episode number in an `S01E01E02` / `S01E01-E02` tail. */
function parseEpisodeRun(first: string, rest: string): number[] {
	const episodes = [Number.parseInt(first, 10)];

	for (const extra of rest.matchAll(/\d{1,3}/g)) {
		const value = Number.parseInt(extra[0], 10);
		if (!episodes.includes(value)) episodes.push(value);
	}

	return episodes;
}

type EpisodeMatch = {
	index: number;
	season: number;
	episodes: number[];
};

function findEpisode(value: string): EpisodeMatch | null {
	const standard = value.match(SEASON_EPISODE);
	if (standard?.index !== undefined) {
		return {
			index: standard.index,
			season: Number.parseInt(standard[1], 10),
			episodes: parseEpisodeRun(standard[2], standard[3] ?? ""),
		};
	}

	const spelled = value.match(SPELLED_OUT);
	if (spelled?.index !== undefined) {
		return {
			index: spelled.index,
			season: Number.parseInt(spelled[1], 10),
			episodes: [Number.parseInt(spelled[2], 10)],
		};
	}

	const compact = value.match(SEASON_X_EPISODE);
	if (compact?.index !== undefined) {
		return {
			index: compact.index,
			season: Number.parseInt(compact[1], 10),
			episodes: [Number.parseInt(compact[2], 10)],
		};
	}

	return null;
}

/**
 * The release year, which is the *last* year-shaped token before the noise
 * starts — "Blade Runner 2049 2017" is a 2017 release of a film whose title
 * happens to end in a number. A year in first position is part of the title
 * ("2012", "1917"), never the release year.
 */
function findYear(value: string, limit: number): { year: number; index: number } | null {
	let found: { year: number; index: number } | null = null;

	for (const match of value.matchAll(YEAR)) {
		if (match.index === undefined || match.index === 0) continue;
		if (limit >= 0 && match.index >= limit) break;
		found = { year: Number.parseInt(match[1], 10), index: match.index };
	}

	return found;
}

function findGroup(name: string): string | null {
	const match = name.match(/(?<!\s)-([A-Za-z0-9]{2,})$/);
	return match ? match[1] : null;
}

function normalizeResolution(value: string): string {
	const lower = value.toLowerCase();
	return lower === "4k" || lower === "uhd" ? "2160p" : lower;
}

export type ReleaseKind = "movie" | "episode" | "unknown";

export type ParsedRelease = {
	kind: ReleaseKind;
	title: string;
	year: number | null;
	season: number | null;
	/** The first episode; `episodes` holds them all for a multi-episode file. */
	episode: number | null;
	episodes: number[];
	/** `YYYY-MM-DD` for a daily show, which numbers nothing. */
	airDate: string | null;
	resolution: string | null;
	source: string | null;
	group: string | null;
	extension: string;
	/**
	 * `low` means "do not act on this without a human". It drives emphasis in
	 * the preview rather than permission, because nothing imports unattended.
	 */
	confidence: "high" | "low";
};

/** Where the technical description takes over from the title. */
function findNoiseStart(normalized: string): number {
	const index = matchIndex(normalized, QUALITY_TOKEN);
	// A quality word in first position is part of the title ("Web of Lies").
	return index > 0 ? index : -1;
}

/**
 * The title runs up to whichever comes first: the year, the episode marker, or
 * the technical description.
 */
function extractTitleAndYear(
	normalized: string,
	marker: number,
): { title: string; year: number | null } {
	const boundary = marker >= 0 ? marker : findNoiseStart(normalized);
	const year = findYear(normalized, boundary);
	const titleEnd = year ? year.index : boundary >= 0 ? boundary : normalized.length;

	return {
		title: restoreTitleCase(cleanTitle(normalized.slice(0, titleEnd))),
		year: year?.year ?? null,
	};
}

type ReleaseSpecifics = Pick<ParsedRelease, "kind" | "season" | "episode" | "episodes" | "airDate">;

function classify(
	episode: EpisodeMatch | null,
	airDate: string | null,
	title: string,
	year: number | null,
): ReleaseSpecifics {
	if (episode) {
		return {
			kind: "episode",
			season: episode.season,
			episode: episode.episodes[0],
			episodes: episode.episodes,
			airDate: null,
		};
	}

	if (airDate) {
		return { kind: "episode", season: null, episode: null, episodes: [], airDate };
	}

	// A movie is only a movie once there is something to look it up by.
	const identified = title.length > 0 && year !== null;
	return {
		kind: identified ? "movie" : "unknown",
		season: null,
		episode: null,
		episodes: [],
		airDate: null,
	};
}

function confidenceOf(kind: ReleaseKind, title: string, year: number | null): "high" | "low" {
	if (title.length === 0) return "low";
	// SxxExx is unambiguous in a way a bare movie title never is.
	if (kind === "episode") return "high";
	return year !== null ? "high" : "low";
}

/**
 * Parse a single release name — a file name, or the directory name of a
 * release folder.
 */
export function parseRelease(name: string): ParsedRelease {
	const extension = knownExtension(name);
	const base = extension ? name.slice(0, -extension.length) : name;
	const normalized = normalize(base);

	const episode = findEpisode(normalized);
	const airMatch = episode ? null : normalized.match(AIR_DATE);
	const airDate = airMatch ? `${airMatch[1]}-${airMatch[2]}-${airMatch[3]}` : null;

	const marker = episode?.index ?? airMatch?.index ?? -1;
	const { title, year } = extractTitleAndYear(normalized, marker);
	const specifics = classify(episode, airDate, title, year);

	const resolution = normalized.match(RESOLUTION);
	const source = normalized.match(SOURCE);

	return {
		...specifics,
		title,
		year,
		resolution: resolution ? normalizeResolution(resolution[1]) : null,
		source: source ? source[1].toLowerCase().replace("blu-ray", "bluray") : null,
		group: findGroup(base.trim()),
		extension,
		confidence: confidenceOf(specifics.kind, title, year),
	};
}

/**
 * Parse a file within a release, falling back to the folder that contains it.
 *
 * `The.Movie.2019.1080p-GRP/movie.mkv` is extremely common: the folder carries
 * every useful field and the file carries none. The folder is only consulted
 * when the file name alone does not produce a confident parse, and the file's
 * own extension always wins.
 */
export function parseReleaseFromPath(relativePath: string): ParsedRelease {
	const fromFile = parseRelease(path.basename(relativePath));
	if (fromFile.confidence === "high") return fromFile;

	const parent = path.dirname(relativePath);
	if (parent === "." || parent === "" || parent === path.sep) return fromFile;

	const fromFolder = parseRelease(path.basename(parent));
	if (fromFolder.confidence === "low") return fromFile;

	return { ...fromFolder, extension: fromFile.extension };
}
