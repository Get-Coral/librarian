import fs from "node:fs";
import path from "node:path";
import { buildDestination, buildSidecarDestination } from "./layout";
import { type CollisionStrategy, realpathWithinRoot, resolveWithinRoot } from "./paths";
import { isSidecarFile, isVideoFile, type ParsedRelease, parseReleaseFromPath } from "./release";
import {
	planTransfer,
	probeTransferStrategy,
	type TransferStrategy,
	transferFile,
} from "./transfer";

/**
 * The import pipeline: look at what is in a download, work out what it is and
 * where each file should go, and say so — in full — before moving anything.
 *
 * `planImport` writes nothing. That is the point of it. The preview endpoint
 * returns exactly this object, the UI shows it, the operator corrects whatever
 * the parser got wrong, and only then does `runImport` touch the disk. There
 * is no unattended path through here in v1: the mitigation for a parser that
 * cannot be perfect is never letting it act alone.
 */

/** Directories inside a release that hold things nobody wants imported. */
const IGNORED_DIRECTORIES = new Set([
	"sample",
	"samples",
	"extras",
	"featurettes",
	"behind the scenes",
	"deleted scenes",
	"proof",
	"screens",
	"screenshots",
]);

/** Directories that hold subtitles for the video in the directory above. */
const SUBTITLE_DIRECTORIES = new Set(["sub", "subs", "subtitle", "subtitles"]);

export type ImportFileKind = "video" | "sidecar";

export type ImportItem = {
	/** Relative to the source root. Never absolute — see `resolveWithinRoot`. */
	from: string;
	/** Relative to the destination root. Null when Librarian cannot yet say. */
	to: string | null;
	kind: ImportFileKind;
	bytes: number;
};

export type ImportEntry = {
	release: ParsedRelease;
	video: ImportItem;
	/** Subtitles and artwork that travel with this video. */
	sidecars: ImportItem[];
	/**
	 * Why this cannot be imported as it stands, if it cannot.
	 *
	 * An unplaceable release is not a reason to refuse the whole preview —
	 * it is the preview doing its job, asking for the field it is missing.
	 */
	problem: string | null;
};

export type ImportWarning = {
	code:
		| "no-video"
		| "low-confidence"
		| "unplaceable"
		| "skipped"
		| "unmatched-sidecar"
		| "collision"
		| "insufficient-space";
	message: string;
	path?: string;
};

export type ImportPlan = {
	sourceRoot: string;
	destinationRoot: string;
	/** How every file in this plan will be transferred. */
	strategy: TransferStrategy;
	entries: ImportEntry[];
	/** Everything the plan touches, whether or not it consumes space. */
	totalBytes: number;
	/** What the destination filesystem actually has to find room for. */
	bytesNeeded: number;
	availableBytes: number | null;
	warnings: ImportWarning[];
	collision: CollisionStrategy;
	preserveSource: boolean;
};

/** The fields an operator is allowed to correct before importing. */
export type ReleaseOverrides = Partial<
	Pick<ParsedRelease, "kind" | "title" | "year" | "season" | "episode" | "episodes" | "airDate">
>;

export type ImportRequest = {
	sourceRoot: string;
	/** A file or a release folder, relative to `sourceRoot`. */
	path: string;
	destinationRoot: string;
	/** Corrections, keyed by the video's path relative to `sourceRoot`. */
	overrides?: Record<string, ReleaseOverrides>;
	collision?: CollisionStrategy;
	/** Defaults to true: the download keeps seeding from the same bytes. */
	preserveSource?: boolean;
};

function walkFiles(root: string, prefix = ""): string[] {
	const here = path.join(root, prefix);

	return fs.readdirSync(here, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix === "" ? entry.name : path.join(prefix, entry.name);
		if (entry.isSymbolicLink()) return [];
		if (entry.isDirectory()) return walkFiles(root, relative);
		return entry.isFile() ? [relative] : [];
	});
}

function isIgnored(relative: string): boolean {
	const segments = path.dirname(relative).split(path.sep);
	if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment.toLowerCase()))) return true;

	// "movie-sample.mkv", "Sample.mkv" — but not "Resample Nation (2019)".
	return /(^|[\s._-])sample([\s._-]|$)/i.test(path.basename(relative));
}

/** Subtitles in a `Subs/` folder belong to the video one level up. */
function effectiveDirectory(relative: string): string {
	const directory = path.dirname(relative);
	const name = path.basename(directory).toLowerCase();
	return SUBTITLE_DIRECTORIES.has(name) ? path.dirname(directory) : directory;
}

/**
 * Attach each sidecar to a video: the only one in its directory, or failing
 * that the one whose name its own name starts with.
 */
function attachSidecars(
	videos: string[],
	sidecars: string[],
): { attached: Map<string, string[]>; orphans: string[] } {
	const attached = new Map<string, string[]>(videos.map((video) => [video, []]));
	const orphans: string[] = [];

	for (const sidecar of sidecars) {
		const directory = effectiveDirectory(sidecar);
		const candidates = videos.filter((video) => path.dirname(video) === directory);

		const owner =
			candidates.length === 1 ? candidates[0] : (bestNameMatch(candidates, sidecar) ?? null);

		if (owner === null) {
			orphans.push(sidecar);
			continue;
		}

		attached.get(owner)?.push(sidecar);
	}

	return { attached, orphans };
}

function bestNameMatch(videos: string[], sidecar: string): string | undefined {
	const stem = path.basename(sidecar, path.extname(sidecar)).toLowerCase();

	return videos
		.filter((video) => stem.startsWith(path.basename(video, path.extname(video)).toLowerCase()))
		.sort((a, b) => b.length - a.length)[0];
}

function applyOverrides(release: ParsedRelease, overrides: ReleaseOverrides): ParsedRelease {
	const merged = { ...release, ...overrides };

	// Keeping `episode` and `episodes` in step matters: the layout reads one
	// and the UI edits the other.
	if (overrides.episode !== undefined && overrides.episodes === undefined) {
		merged.episodes = overrides.episode === null ? [] : [overrides.episode];
	}
	if (overrides.episodes !== undefined && overrides.episode === undefined) {
		merged.episode = overrides.episodes[0] ?? null;
	}

	return merged;
}

function sizeOf(absolute: string): number {
	return fs.statSync(absolute).size;
}

/**
 * Decide the whole import without performing any of it.
 *
 * Handles a single file, a release folder, and a season pack alike: every
 * video that is not a sample becomes its own entry with its own parse, so a
 * folder of episodes plans as a folder of episodes.
 */
export function planImport(request: ImportRequest): ImportPlan {
	const {
		sourceRoot,
		destinationRoot,
		overrides = {},
		collision = "fail",
		preserveSource = true,
	} = request;

	const source = realpathWithinRoot(sourceRoot, resolveWithinRoot(sourceRoot, request.path));
	const warnings: ImportWarning[] = [];

	const relativeFiles = fs.statSync(source).isDirectory()
		? walkFiles(source).map((file) => path.join(request.path, file))
		: [request.path];

	const usable = relativeFiles.filter((file) => {
		if (!isIgnored(file)) return true;
		warnings.push({ code: "skipped", message: "Looks like a sample or an extra.", path: file });
		return false;
	});

	const videos = usable.filter(isVideoFile);
	const sidecars = usable.filter(isSidecarFile);

	if (videos.length === 0) {
		warnings.push({ code: "no-video", message: "No video file to import." });
		return emptyPlan(request, warnings, collision, preserveSource);
	}

	const { attached, orphans } = attachSidecars(videos, sidecars);
	for (const orphan of orphans) {
		warnings.push({
			code: "unmatched-sidecar",
			message: "Could not tell which video this belongs to.",
			path: orphan,
		});
	}

	// The strategy is a property of the two filesystems, so it is probed once
	// for the whole plan rather than once per file. A real video is handed over
	// as the sample, so a read-only downloads mount still reports hardlink.
	const sample = resolveWithinRoot(sourceRoot, videos[0]);
	const strategy = probeTransferStrategy(path.dirname(sample), destinationRoot, {
		sample,
		preserveSource,
	});

	const entries = videos.map((video) =>
		planEntry({
			video,
			sidecars: attached.get(video) ?? [],
			sourceRoot,
			destinationRoot,
			overrides: overrides[video] ?? {},
			collision,
			preserveSource,
			strategy,
			warnings,
		}),
	);

	return finishPlan({
		request,
		entries,
		strategy,
		warnings,
		collision,
		preserveSource,
	});
}

type EntryContext = {
	video: string;
	sidecars: string[];
	sourceRoot: string;
	destinationRoot: string;
	overrides: ReleaseOverrides;
	collision: CollisionStrategy;
	preserveSource: boolean;
	strategy: TransferStrategy;
	warnings: ImportWarning[];
};

function planEntry(context: EntryContext): ImportEntry {
	const { video, sourceRoot, destinationRoot, collision, preserveSource, strategy } = context;

	const release = applyOverrides(parseReleaseFromPath(video), context.overrides);
	if (release.confidence === "low") {
		context.warnings.push({
			code: "low-confidence",
			message: "Librarian is guessing at this one — check it before importing.",
			path: video,
		});
	}

	const from = resolveWithinRoot(sourceRoot, video);

	let destination: string;
	try {
		destination = buildDestination(release);
	} catch (error) {
		context.warnings.push({
			code: "unplaceable",
			message: error instanceof Error ? error.message : "Cannot place this release.",
			path: video,
		});

		return {
			release,
			video: { from: video, to: null, kind: "video", bytes: sizeOf(from) },
			sidecars: context.sidecars.map((sidecar) => ({
				from: sidecar,
				to: null,
				kind: "sidecar" as const,
				bytes: sizeOf(resolveWithinRoot(sourceRoot, sidecar)),
			})),
			problem: error instanceof Error ? error.message : "Cannot place this release.",
		};
	}

	const to = resolveWithinRoot(destinationRoot, destination);
	const plan = planTransfer(from, to, { strategy, collision, preserveSource });
	if (plan.destination !== to) {
		context.warnings.push({
			code: "collision",
			message: "Something is already there, so this one is being renamed.",
			path: video,
		});
	}

	return {
		release,
		video: {
			from: video,
			to: path.relative(destinationRoot, plan.destination),
			kind: "video",
			bytes: plan.bytes,
		},
		sidecars: context.sidecars.map((sidecar) =>
			planSidecar({ sidecar, destination, sourceRoot, destinationRoot, collision }),
		),
		problem: null,
	};
}

function planSidecar(context: {
	sidecar: string;
	destination: string;
	sourceRoot: string;
	destinationRoot: string;
	collision: CollisionStrategy;
}): ImportItem {
	const to = buildSidecarDestination(context.destination, path.basename(context.sidecar));

	return {
		from: context.sidecar,
		to,
		kind: "sidecar",
		bytes: sizeOf(resolveWithinRoot(context.sourceRoot, context.sidecar)),
	};
}

function emptyPlan(
	request: ImportRequest,
	warnings: ImportWarning[],
	collision: CollisionStrategy,
	preserveSource: boolean,
): ImportPlan {
	return {
		sourceRoot: request.sourceRoot,
		destinationRoot: request.destinationRoot,
		strategy: "copy",
		entries: [],
		totalBytes: 0,
		bytesNeeded: 0,
		availableBytes: null,
		warnings,
		collision,
		preserveSource,
	};
}

function finishPlan(context: {
	request: ImportRequest;
	entries: ImportEntry[];
	strategy: TransferStrategy;
	warnings: ImportWarning[];
	collision: CollisionStrategy;
	preserveSource: boolean;
}): ImportPlan {
	const { request, entries, strategy, warnings } = context;

	const totalBytes = entries.reduce(
		(sum, entry) =>
			sum + entry.video.bytes + entry.sidecars.reduce((inner, file) => inner + file.bytes, 0),
		0,
	);

	// A hardlink and a rename both cost nothing; only a copy needs room.
	const bytesNeeded = strategy === "copy" ? totalBytes : 0;
	const availableBytes = freeSpaceAt(request.destinationRoot);

	if (availableBytes !== null && bytesNeeded > availableBytes) {
		warnings.push({
			code: "insufficient-space",
			message: "There is not enough free space at the destination for this import.",
		});
	}

	return {
		sourceRoot: request.sourceRoot,
		destinationRoot: request.destinationRoot,
		strategy,
		entries,
		totalBytes,
		bytesNeeded,
		availableBytes,
		warnings,
		collision: context.collision,
		preserveSource: context.preserveSource,
	};
}

function freeSpaceAt(directory: string): number | null {
	try {
		const stats = fs.statfsSync(directory);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

export type ImportOutcome = {
	item: ImportItem;
	/** Where it actually landed, relative to the destination root. */
	to: string;
	strategy: TransferStrategy;
};

export type ImportResult = {
	imported: ImportOutcome[];
	warnings: ImportWarning[];
};

/**
 * Hooks for a caller that wants to watch, without the pipeline knowing what a
 * job is. `checkpoint` is called before each file and may throw to stop.
 */
export type ImportHooks = {
	checkpoint?: () => void;
	onFile?: (outcome: ImportOutcome) => void;
};

/**
 * Carry out a plan.
 *
 * Videos go first, so a release that fails halfway has its video in place
 * rather than a folder of subtitles for a film that is not there. A sidecar
 * that fails is reported and skipped — losing an English subtitle is not a
 * reason to abandon an import that has already moved the film. An entry the
 * operator never resolved is skipped for the same reason: nine placeable
 * episodes should not wait on the tenth.
 */
export function runImport(plan: ImportPlan, hooks: ImportHooks = {}): ImportResult {
	const imported: ImportOutcome[] = [];
	const warnings: ImportWarning[] = [];

	for (const entry of plan.entries) {
		if (entry.problem !== null) {
			warnings.push({ code: "unplaceable", message: entry.problem, path: entry.video.from });
			continue;
		}

		hooks.checkpoint?.();
		const video = transfer(plan, entry.video);
		imported.push(video);
		hooks.onFile?.(video);

		for (const sidecar of entry.sidecars) {
			hooks.checkpoint?.();
			try {
				const outcome = transfer(plan, sidecar);
				imported.push(outcome);
				hooks.onFile?.(outcome);
			} catch (error) {
				warnings.push({
					code: "skipped",
					message: error instanceof Error ? error.message : "Could not import this file.",
					path: sidecar.from,
				});
			}
		}
	}

	return { imported, warnings };
}

function transfer(plan: ImportPlan, item: ImportItem): ImportOutcome {
	if (item.to === null) {
		throw new Error(`Librarian does not know where "${item.from}" should go.`);
	}

	const from = resolveWithinRoot(plan.sourceRoot, item.from);
	const to = resolveWithinRoot(plan.destinationRoot, item.to);

	const result = transferFile(from, to, {
		strategy: plan.strategy,
		collision: plan.collision,
		preserveSource: plan.preserveSource,
	});

	return {
		item,
		to: path.relative(plan.destinationRoot, result.destination),
		strategy: result.strategy,
	};
}
