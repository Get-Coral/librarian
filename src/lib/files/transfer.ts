import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertNotSymlink, type CollisionStrategy, resolveCollision } from "./paths";

/**
 * Getting one file from A to B without ever being the reason someone loses it.
 *
 * Three rungs, cheapest first:
 *
 * 1. **hardlink** — a second directory entry for the same inode. Zero bytes,
 *    instant, and the source keeps existing, so a torrent carries on seeding
 *    the very file Jellyfin is now playing. This is the whole reason imports
 *    are better here than the `renameSync` Tide does today.
 * 2. **rename** — same filesystem, but the source must not survive.
 * 3. **copy** — different filesystems. Verified, and the source is only
 *    unlinked once the destination is known good.
 *
 * Which rung applies is decided by trying it, not by comparing `statSync().dev`:
 * Docker bind mounts on macOS report matching device ids across mounts that
 * cannot link to each other, and will fail `link()` with EPERM. The device id
 * is a hint; an actual link is proof.
 *
 * No SQLite, no HTTP, no TanStack — the `fs_operations` audit row is written by
 * the caller, so this stays a unit-testable function.
 */

export type TransferStrategy = "hardlink" | "rename" | "copy";

export class TransferError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TransferError";
	}
}

/**
 * Marks a destination that is written but not yet verified. Anything wearing
 * this suffix is garbage from an interrupted run and is swept at boot.
 */
export const PARTIAL_SUFFIX = ".coral-partial";

/** Headroom left behind so an import never fills a disk to its last byte. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/** `link()` failures that mean "not supported here", rather than "went wrong". */
const LINK_UNSUPPORTED = new Set([
	"EXDEV",
	"EPERM",
	"EACCES",
	"EMLINK",
	"EOPNOTSUPP",
	"ENOSYS",
	"ENOTSUP",
]);

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return String((error as { code: unknown }).code);
}

function safeUnlink(target: string): void {
	try {
		fs.unlinkSync(target);
	} catch {
		// Already gone, which is the state we wanted.
	}
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** Flush a file's contents to the disk itself, not just to the page cache. */
function fsyncFile(target: string): void {
	const handle = fs.openSync(target, "r+");
	try {
		fs.fsyncSync(handle);
	} finally {
		fs.closeSync(handle);
	}
}

/**
 * Flush a directory entry, so the rename survives a power cut too.
 *
 * Best-effort: some filesystems (and every Windows build) reject `fsync` on a
 * directory handle, and a failure here does not mean the transfer failed.
 */
function fsyncDirectory(target: string): void {
	let handle: number;
	try {
		handle = fs.openSync(target, "r");
	} catch {
		return;
	}
	try {
		fs.fsyncSync(handle);
	} catch {
		// Not supported on this filesystem.
	} finally {
		fs.closeSync(handle);
	}
}

function freeBytes(directory: string): number {
	const stats = fs.statfsSync(directory);
	return Number(stats.bavail) * Number(stats.bsize);
}

/** Bytes that must be free before a copy is allowed to start. */
function assertRoomFor(directory: string, bytes: number): void {
	let available: number;
	try {
		available = freeBytes(directory);
	} catch {
		// If the filesystem will not answer, do not block the transfer on it.
		return;
	}

	if (available < bytes + FREE_SPACE_MARGIN_BYTES) {
		throw new TransferError(
			`Not enough free space in "${directory}": needs ${bytes} bytes, ${available} available.`,
		);
	}
}

export type ProbeOptions = {
	/**
	 * An existing file to test linking with. Lets the probe work when the
	 * source directory is mounted read-only — linking needs write permission on
	 * the *destination* directory, so a read-only source can still be imported.
	 */
	sample?: string;
	/**
	 * Whether the source has to survive the transfer. True by default, because
	 * the common case is importing a file a torrent is still seeding. When true
	 * `rename` is never offered, since it consumes the source.
	 */
	preserveSource?: boolean;
};

/**
 * Work out, empirically, the cheapest way to move a file between two
 * directories: create a link, see what happens, clean up.
 *
 * The destination directory must already exist — probing is read-only as far
 * as the caller's tree is concerned, and creating directories to answer a
 * question is a side effect nobody asked for.
 *
 * The answer is a property of the filesystem pair, so callers should cache it
 * per (source root, destination root) rather than probing per file.
 */
export function probeTransferStrategy(
	sourceDirectory: string,
	destinationDirectory: string,
	options: ProbeOptions = {},
): TransferStrategy {
	const { sample, preserveSource = true } = options;

	if (!isDirectory(destinationDirectory)) {
		throw new TransferError(`"${destinationDirectory}" is not a directory.`);
	}

	const token = randomBytes(6).toString("hex");
	const probeDestination = path.join(destinationDirectory, `.coral-probe-${token}`);
	const probeSource = path.join(sourceDirectory, `.coral-probe-${token}`);

	// A probe file of our own is the only thing we are allowed to rename or
	// delete. If the source is read-only we go without, and fall back to the
	// caller's sample for the link test.
	let ownsProbeSource = true;
	try {
		fs.closeSync(fs.openSync(probeSource, "wx"));
	} catch {
		ownsProbeSource = false;
	}

	const linkSource = ownsProbeSource ? probeSource : sample;

	try {
		if (linkSource !== undefined) {
			try {
				fs.linkSync(linkSource, probeDestination);
				return "hardlink";
			} catch {
				// Fall to the next rung.
			}
		}

		if (!preserveSource && ownsProbeSource) {
			try {
				fs.renameSync(probeSource, probeDestination);
				return "rename";
			} catch {
				// Fall to the next rung.
			}
		}

		return "copy";
	} finally {
		safeUnlink(probeDestination);
		if (ownsProbeSource) safeUnlink(probeSource);
	}
}

/**
 * Link `source` to `destination` via a partial name, so the destination
 * appears atomically and an existing file is replaced in one step rather than
 * being unlinked first and recreated a moment later.
 */
function linkInto(source: string, destination: string): void {
	const partial = `${destination}${PARTIAL_SUFFIX}`;
	safeUnlink(partial);

	fs.linkSync(source, partial);
	try {
		fs.renameSync(partial, destination);
	} catch (error) {
		safeUnlink(partial);
		throw error;
	}
}

/**
 * Rename `source` onto `destination`, bouncing through a temporary name when
 * the two are the same file under a different case.
 *
 * macOS and SMB are case-insensitive but case-preserving, so renaming
 * "movie.mkv" to "Movie.mkv" is a no-op there — or, worse, an error. Going via
 * a third name makes the rename actually happen.
 */
function renameInto(source: string, destination: string): void {
	if (isSameFile(source, destination)) {
		const staging = `${destination}${PARTIAL_SUFFIX}`;
		safeUnlink(staging);
		fs.renameSync(source, staging);
		fs.renameSync(staging, destination);
		return;
	}

	fs.renameSync(source, destination);
}

function isSameFile(a: string, b: string): boolean {
	try {
		const left = fs.lstatSync(a);
		const right = fs.lstatSync(b);
		return left.ino === right.ino && left.dev === right.dev;
	} catch {
		return false;
	}
}

/**
 * Copy to a partial name, flush it, check the size, put it in place, and only
 * then — if asked — remove the source.
 *
 * The ordering is the point. A copy that is interrupted anywhere leaves the
 * source untouched and a `.coral-partial` file to sweep, never a truncated
 * file sitting in a library under the name of the real thing.
 */
function copyInto(source: string, destination: string, bytes: number, removeSource: boolean): void {
	const directory = path.dirname(destination);
	assertRoomFor(directory, bytes);

	const partial = `${destination}${PARTIAL_SUFFIX}`;
	safeUnlink(partial);

	try {
		fs.copyFileSync(source, partial);
		fsyncFile(partial);

		const written = fs.statSync(partial).size;
		if (written !== bytes) {
			throw new TransferError(
				`Copy of "${path.basename(source)}" is ${written} bytes, expected ${bytes}.`,
			);
		}

		fs.renameSync(partial, destination);
		fsyncDirectory(directory);
	} catch (error) {
		safeUnlink(partial);
		throw error;
	}

	if (removeSource) fs.unlinkSync(source);
}

export type TransferOptions = {
	/** Skip the probe and use this rung. Falls down the ladder if it fails. */
	strategy?: TransferStrategy;
	/** What to do when the destination already exists. `fail` by default. */
	collision?: CollisionStrategy;
	/** Whether the source must survive. True by default — see `ProbeOptions`. */
	preserveSource?: boolean;
};

/** Everything a transfer decides before it writes anything. */
export type TransferPlan = {
	source: string;
	/** Where the file will land, which the collision policy may have renamed. */
	destination: string;
	strategy: TransferStrategy;
	bytes: number;
	/** Free space at the destination, or null when the filesystem will not say. */
	availableBytes: number | null;
	preserveSource: boolean;
};

export type TransferResult = {
	source: string;
	destination: string;
	strategy: TransferStrategy;
	bytes: number;
	sourceRemoved: boolean;
};

/**
 * The nearest ancestor of `target` that exists.
 *
 * Questions about a filesystem — can it link, how much room is left — have to
 * be asked of a directory that is actually there, and a destination usually is
 * not yet.
 */
function nearestExistingDirectory(target: string): string {
	let current = path.resolve(target);

	while (!isDirectory(current)) {
		const parent = path.dirname(current);
		if (parent === current) return current;
		current = parent;
	}

	return current;
}

/**
 * Symlinks are refused outright: following one is how "move this into the
 * library" becomes a write somewhere off the root. Hardlinks are fine, and are
 * in fact the happy path.
 */
function assertTransferableFile(source: string): fs.Stats {
	assertNotSymlink(source);

	const stats = fs.lstatSync(source);
	if (!stats.isFile()) {
		throw new TransferError(`"${source}" is not a regular file.`);
	}

	return stats;
}

/**
 * Decide everything about a transfer without performing it.
 *
 * Writes nothing outside a temporary probe name, so the import preview can put
 * the whole plan in front of an operator — strategy, destination, bytes needed
 * against bytes free — and let them correct it before anything moves.
 */
export function planTransfer(
	source: string,
	destination: string,
	options: TransferOptions = {},
): TransferPlan {
	const { collision = "fail", preserveSource = true } = options;

	const stats = assertTransferableFile(source);

	const resolvedSource = path.resolve(source);
	const requested = path.resolve(destination);
	if (resolvedSource === requested) {
		throw new TransferError("Source and destination are the same path.");
	}

	const directory = nearestExistingDirectory(path.dirname(requested));
	const finalDestination = resolveCollision(requested, collision);

	const strategy =
		options.strategy ??
		probeTransferStrategy(path.dirname(resolvedSource), directory, {
			sample: resolvedSource,
			preserveSource,
		});

	if (strategy === "rename" && preserveSource) {
		throw new TransferError("The rename strategy consumes the source, which must be preserved.");
	}

	let availableBytes: number | null = null;
	try {
		availableBytes = freeBytes(directory);
	} catch {
		// Some filesystems will not answer. Not a reason to refuse the transfer.
	}

	return {
		source: resolvedSource,
		destination: finalDestination,
		strategy,
		bytes: stats.size,
		availableBytes,
		preserveSource,
	};
}

/** Walk down the ladder until a rung holds. */
function executePlan(plan: TransferPlan): TransferResult {
	const { source, destination, bytes, preserveSource } = plan;
	const outcome = { source, destination, bytes };
	let strategy = plan.strategy;

	if (strategy === "hardlink") {
		try {
			linkInto(source, destination);
			if (!preserveSource) fs.unlinkSync(source);
			return { ...outcome, strategy: "hardlink", sourceRemoved: !preserveSource };
		} catch (error) {
			// A probed strategy can outlive the mount it was measured against, so
			// an unsupported link drops a rung instead of failing the import.
			if (!LINK_UNSUPPORTED.has(errorCode(error) ?? "")) throw error;
			strategy = preserveSource ? "copy" : "rename";
		}
	}

	if (strategy === "rename") {
		try {
			renameInto(source, destination);
			return { ...outcome, strategy: "rename", sourceRemoved: true };
		} catch (error) {
			if (errorCode(error) !== "EXDEV") throw error;
			strategy = "copy";
		}
	}

	copyInto(source, destination, bytes, !preserveSource);
	return { ...outcome, strategy: "copy", sourceRemoved: !preserveSource };
}

/** Transfer one regular file, choosing the cheapest strategy that works. */
export function transferFile(
	source: string,
	destination: string,
	options: TransferOptions = {},
): TransferResult {
	const plan = planTransfer(source, destination, options);
	fs.mkdirSync(path.dirname(plan.destination), { recursive: true });
	return executePlan(plan);
}
