import fs from "node:fs";
import path from "node:path";

/**
 * Path safety for every filesystem operation Librarian performs.
 *
 * Librarian is the only Coral module that mounts both the media tree and the
 * downloads tree read-write, so a mistake here moves or destroys somebody's
 * library. Everything in this file is pure apart from the `fs` calls it needs
 * to resolve symlinks, which keeps it exhaustively testable.
 */

/** Windows-reserved and shell-hostile characters, plus control codes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control codes is the point.
const UNSAFE_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Segments that mean something to the filesystem rather than naming a file. */
const RESERVED_SEGMENTS = new Set([".", ".."]);

export type CollisionStrategy = "fail" | "suffix" | "replace";

export class PathSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathSafetyError";
	}
}

/**
 * Whether `child` sits strictly inside `parent`.
 *
 * Uses `path.relative` rather than a string prefix test: `/library-old`
 * starts with `/library` but is a sibling, not a descendant. Equal paths are
 * deliberately not "inside" — callers that accept the root itself check for
 * that explicitly, so the permissive case is always visible at the call site.
 */
export function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	if (relative === "" || relative === undefined) return false;
	if (path.isAbsolute(relative)) return false;
	return !relative.split(path.sep).includes("..");
}

/** `isInside`, but the root itself also counts. */
export function isAtOrInside(parent: string, child: string): boolean {
	return parent === child || isInside(parent, child);
}

/**
 * Reject a single path segment that is not safe to join onto a root.
 *
 * Applied to every caller-supplied component before it reaches the
 * filesystem, so traversal and NUL injection are refused at the edge rather
 * than being normalised away somewhere downstream.
 */
export function assertSafeSegment(segment: string): void {
	if (segment.length === 0) {
		throw new PathSafetyError("Path segment is empty.");
	}
	if (RESERVED_SEGMENTS.has(segment)) {
		throw new PathSafetyError(`Path segment "${segment}" is not allowed.`);
	}
	if (segment.includes("\u0000")) {
		throw new PathSafetyError("Path segment contains a null byte.");
	}
	if (segment.includes("/") || segment.includes("\\")) {
		throw new PathSafetyError(`Path segment "${segment}" contains a separator.`);
	}
	if (Buffer.byteLength(segment, "utf8") > 255) {
		throw new PathSafetyError("Path segment is longer than 255 bytes.");
	}
}

/**
 * Turn an arbitrary title into something safe to use as a single path segment.
 *
 * Trailing dots and spaces are stripped because Windows and SMB shares silently
 * drop them, which turns "Movie ." and "Movie" into a surprise collision.
 */
export function sanitizeName(name: string): string {
	const cleaned = name
		.replace(UNSAFE_CHARACTERS, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "");

	if (cleaned.length === 0) {
		throw new PathSafetyError(`"${name}" leaves nothing usable as a filename.`);
	}

	// Keep room for an extension and a collision suffix.
	return Buffer.byteLength(cleaned, "utf8") > 200
		? Buffer.from(cleaned, "utf8").subarray(0, 200).toString("utf8").trim()
		: cleaned;
}

/**
 * Resolve a caller-supplied *relative* path against a root.
 *
 * No API in Librarian accepts an absolute path — callers name a root and a path
 * within it. That single rule removes an entire class of exploit before any
 * validation runs, so an absolute input here is a bug and is refused.
 */
export function resolveWithinRoot(root: string, relative: string): string {
	if (path.isAbsolute(relative)) {
		throw new PathSafetyError("Path must be relative to a root.");
	}
	if (relative.includes("\u0000")) {
		throw new PathSafetyError("Path contains a null byte.");
	}

	const segments = relative.split(/[/\\]+/).filter((segment) => segment.length > 0);
	for (const segment of segments) {
		assertSafeSegment(segment);
	}

	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(resolvedRoot, ...segments);

	if (!isAtOrInside(resolvedRoot, resolved)) {
		throw new PathSafetyError("Path escapes its root.");
	}

	return resolved;
}

/**
 * The nearest ancestor of `target` that exists, plus the segments below it.
 *
 * Needed because a destination usually does not exist yet, and `realpath`
 * fails on a missing path.
 */
function splitAtExisting(target: string): { existing: string; tail: string[] } {
	const tail: string[] = [];
	let existing = target;

	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		tail.unshift(path.basename(existing));
		existing = parent;
	}

	return { existing, tail };
}

/**
 * Containment check that survives symlinks, for a path that may not exist yet.
 *
 * This is the one most often got wrong. Resolving only the final path lets
 * `<root>/link-to-elsewhere/file.mkv` through, because the final component
 * does not exist and so is never resolved. Instead the nearest existing
 * ancestor is resolved — that is the part a symlink could redirect — and the
 * remaining segments are rejoined onto the real location.
 */
export function realpathWithinRoot(root: string, target: string): string {
	const realRoot = fs.realpathSync.native(path.resolve(root));
	const { existing, tail } = splitAtExisting(path.resolve(target));

	let realExisting: string;
	try {
		realExisting = fs.realpathSync.native(existing);
	} catch {
		throw new PathSafetyError("Path could not be resolved.");
	}

	const resolved = tail.length > 0 ? path.join(realExisting, ...tail) : realExisting;

	if (!isAtOrInside(realRoot, resolved)) {
		throw new PathSafetyError("Path escapes its root once symlinks are resolved.");
	}

	return resolved;
}

/** Refuse to act on a symlink. Hardlinks are unaffected — only the link type is checked. */
export function assertNotSymlink(target: string): void {
	let stats: fs.Stats;
	try {
		stats = fs.lstatSync(target);
	} catch {
		throw new PathSafetyError(`"${target}" does not exist.`);
	}

	if (stats.isSymbolicLink()) {
		throw new PathSafetyError("Refusing to operate on a symlink.");
	}
}

/**
 * Apply the collision policy for a destination that may already exist.
 *
 * `fail` is the default everywhere. Silently overwriting someone's media is
 * not a behaviour worth having as a default.
 */
export function resolveCollision(destination: string, strategy: CollisionStrategy): string {
	if (!fs.existsSync(destination)) return destination;

	if (strategy === "fail") {
		throw new PathSafetyError(`"${path.basename(destination)}" already exists.`);
	}
	if (strategy === "replace") {
		return destination;
	}

	const directory = path.dirname(destination);
	const extension = path.extname(destination);
	const base = path.basename(destination, extension);

	for (let counter = 2; counter < 1000; counter++) {
		const candidate = path.join(directory, `${base} (${counter})${extension}`);
		if (!fs.existsSync(candidate)) return candidate;
	}

	throw new PathSafetyError(`Could not find a free name for "${base}${extension}".`);
}
