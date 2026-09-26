import path from "node:path";
import { sanitizeName } from "./paths";
import type { ParsedRelease } from "./release";

/**
 * Turning a parsed release into the path Jellyfin expects to find it at.
 *
 * Jellyfin's scanner is convention-driven, so getting the layout right is what
 * makes an imported file show up with the correct metadata instead of as an
 * unmatched oddity. The conventions implemented here are the ones Jellyfin
 * documents:
 *
 *     Movies/The Matrix (1999)/The Matrix (1999).mkv
 *     Shows/Show Name (2019)/Season 01/Show Name (2019) - S01E02.mkv
 *     Shows/Show Name (2019)/Specials/Show Name (2019) - S00E01.mkv
 *     Shows/Daily Show (2019)/Season 2019/Daily Show (2019) - 2019-05-12.mkv
 *
 * Paths are relative to a library root and every segment goes through
 * `sanitizeName`, so the result is always safe to hand to `resolveWithinRoot`.
 */

export class LayoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LayoutError";
	}
}

/** Artwork Jellyfin looks for by name — these keep theirs. */
const ARTWORK_BY_NAME = new Set([
	"backdrop",
	"banner",
	"clearart",
	"clearlogo",
	"cover",
	"disc",
	"fanart",
	"folder",
	"landscape",
	"logo",
	"poster",
	"thumb",
]);

/**
 * Subtitle suffixes worth carrying across a rename. A closed list, because
 * "any two or three letters" would turn `The.Fly.srt` into a Welsh subtitle.
 */
const SUBTITLE_SUFFIXES = new Set([
	"ar",
	"ara",
	"bg",
	"bul",
	"cs",
	"ces",
	"cze",
	"da",
	"dan",
	"de",
	"deu",
	"ger",
	"el",
	"ell",
	"gre",
	"en",
	"eng",
	"es",
	"spa",
	"et",
	"est",
	"fa",
	"fas",
	"fi",
	"fin",
	"fr",
	"fra",
	"fre",
	"he",
	"heb",
	"hi",
	"hin",
	"hr",
	"hrv",
	"hu",
	"hun",
	"id",
	"ind",
	"is",
	"isl",
	"it",
	"ita",
	"ja",
	"jpn",
	"ko",
	"kor",
	"lt",
	"lit",
	"lv",
	"lav",
	"ms",
	"msa",
	"nb",
	"nl",
	"nld",
	"dut",
	"no",
	"nor",
	"pl",
	"pol",
	"pt",
	"por",
	"ro",
	"ron",
	"rum",
	"ru",
	"rus",
	"sk",
	"slk",
	"sl",
	"slv",
	"sr",
	"srp",
	"sv",
	"swe",
	"th",
	"tha",
	"tr",
	"tur",
	"uk",
	"ukr",
	"vi",
	"vie",
	"zh",
	"zho",
	"chi",
	// Not languages, but they change how a track is used.
	"cc",
	"default",
	"forced",
	"foreign",
	"sdh",
]);

function pad(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** `Title (Year)`, or just the title when the year is unknown. */
function titleWithYear(release: ParsedRelease): string {
	if (release.title.trim().length === 0) {
		throw new LayoutError("A release needs a title before it can be given a destination.");
	}

	return release.year === null ? release.title : `${release.title} (${release.year})`;
}

/**
 * `S01E02`, or `S01E01-E02` for a contiguous run, or `S01E01E03` when the
 * episodes in the file are not neighbours.
 */
function episodeTag(season: number, episodes: number[]): string {
	const prefix = `S${pad(season)}`;
	if (episodes.length === 1) return `${prefix}E${pad(episodes[0])}`;

	const sorted = [...episodes].sort((a, b) => a - b);
	const contiguous = sorted.every((value, offset) => value === sorted[0] + offset);

	return contiguous
		? `${prefix}E${pad(sorted[0])}-E${pad(sorted[sorted.length - 1])}`
		: prefix + sorted.map((value) => `E${pad(value)}`).join("");
}

function movieDestination(release: ParsedRelease): string {
	const name = sanitizeName(titleWithYear(release));
	return path.join(name, `${name}${release.extension}`);
}

function episodeDestination(release: ParsedRelease): string {
	const show = sanitizeName(titleWithYear(release));

	if (release.airDate !== null) {
		// A daily show files under the year it aired in.
		const season = release.airDate.slice(0, 4);
		return path.join(
			show,
			sanitizeName(`Season ${season}`),
			`${show} - ${release.airDate}${release.extension}`,
		);
	}

	if (release.season === null || release.episodes.length === 0) {
		throw new LayoutError("An episode needs a season and an episode number.");
	}

	const folder = release.season === 0 ? "Specials" : `Season ${pad(release.season)}`;
	const tag = episodeTag(release.season, release.episodes);

	return path.join(show, sanitizeName(folder), `${show} - ${tag}${release.extension}`);
}

/**
 * Where a release belongs inside its library root.
 *
 * Throws on anything it cannot place. An unplaceable release is not an error
 * to swallow — it is the preview telling the operator to fill in what is
 * missing.
 */
export function buildDestination(release: ParsedRelease): string {
	if (release.kind === "movie") return movieDestination(release);
	if (release.kind === "episode") return episodeDestination(release);

	throw new LayoutError("Librarian could not tell what this release is.");
}

/** Split `movie.en.forced` into its stem and the suffixes worth keeping. */
function splitSubtitleSuffixes(stem: string): string[] {
	const parts = stem.split(".");
	const suffixes: string[] = [];

	while (parts.length > 1) {
		const candidate = parts[parts.length - 1];
		if (!SUBTITLE_SUFFIXES.has(candidate.toLowerCase())) break;
		suffixes.unshift(candidate.toLowerCase());
		parts.pop();
	}

	return suffixes;
}

/**
 * Where a file that travels with a video belongs.
 *
 * Subtitles take the video's name so Jellyfin pairs them, keeping any language
 * or `forced` suffix. Artwork Jellyfin identifies by name — `poster.jpg`,
 * `fanart.jpg` — keeps its own name instead, since renaming it to match the
 * video is what stops it being recognised.
 */
export function buildSidecarDestination(videoDestination: string, sidecarName: string): string {
	const directory = path.dirname(videoDestination);
	const videoBase = path.basename(videoDestination, path.extname(videoDestination));

	const extension = path.extname(sidecarName).toLowerCase();
	const stem = path.basename(sidecarName, path.extname(sidecarName));

	if (ARTWORK_BY_NAME.has(stem.toLowerCase())) {
		return path.join(directory, `${stem.toLowerCase()}${extension}`);
	}

	const suffixes = splitSubtitleSuffixes(stem);
	const tail = suffixes.length > 0 ? `.${suffixes.join(".")}` : "";

	return path.join(directory, `${sanitizeName(videoBase)}${tail}${extension}`);
}
