import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathSafetyError } from "./paths";
import {
	PARTIAL_SUFFIX,
	planTransfer,
	probeTransferStrategy,
	TransferError,
	transferFile,
} from "./transfer";

let workspace: string;
let sourceDirectory: string;
let destinationDirectory: string;

/** Tests that rely on permissions are meaningless as root, which ignores them. */
const isRoot = process.getuid?.() === 0;

/** A filesystem with 512 bytes left on it. */
const noRoom = {
	bavail: 1,
	bfree: 1,
	blocks: 1024,
	bsize: 512,
	ffree: 1,
	files: 1024,
	type: 0,
} as fs.StatsFs;

function errno(code: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(code);
	error.code = code;
	return error;
}

function write(target: string, contents: string): string {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, contents);
	return target;
}

function inodeOf(target: string): number {
	return fs.statSync(target).ino;
}

function entries(directory: string): string[] {
	return fs.readdirSync(directory).sort();
}

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-transfer-"));
	sourceDirectory = path.join(workspace, "downloads");
	destinationDirectory = path.join(workspace, "media");
	fs.mkdirSync(sourceDirectory);
	fs.mkdirSync(destinationDirectory);
});

afterEach(() => {
	vi.restoreAllMocks();
	// A test may have made a directory read-only to simulate a ro mount.
	for (const directory of [sourceDirectory, destinationDirectory]) {
		try {
			fs.chmodSync(directory, 0o755);
		} catch {
			// Already gone.
		}
	}
	fs.rmSync(workspace, { recursive: true, force: true });
});

describe("probeTransferStrategy", () => {
	it("chooses hardlink between two directories on one filesystem", () => {
		expect(probeTransferStrategy(sourceDirectory, destinationDirectory)).toBe("hardlink");
	});

	it("leaves nothing behind in either directory", () => {
		probeTransferStrategy(sourceDirectory, destinationDirectory);

		expect(entries(sourceDirectory)).toEqual([]);
		expect(entries(destinationDirectory)).toEqual([]);
	});

	it("falls back to rename when linking is unsupported and the source may go", () => {
		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw errno("EPERM");
		});

		expect(
			probeTransferStrategy(sourceDirectory, destinationDirectory, { preserveSource: false }),
		).toBe("rename");
		expect(entries(sourceDirectory)).toEqual([]);
		expect(entries(destinationDirectory)).toEqual([]);
	});

	it("never offers rename when the source must be preserved", () => {
		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw errno("EPERM");
		});

		// Rename would succeed here — it is withheld because it eats the source.
		expect(probeTransferStrategy(sourceDirectory, destinationDirectory)).toBe("copy");
	});

	it("falls back to copy when neither linking nor renaming works", () => {
		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw errno("EXDEV");
		});
		vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw errno("EXDEV");
		});

		expect(
			probeTransferStrategy(sourceDirectory, destinationDirectory, { preserveSource: false }),
		).toBe("copy");
	});

	it.skipIf(isRoot)("uses the sample when the source directory is read-only", () => {
		const sample = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		fs.chmodSync(sourceDirectory, 0o555);

		// Linking needs write permission on the destination, not the source, so
		// a read-only downloads mount can still be imported at zero cost.
		expect(probeTransferStrategy(sourceDirectory, destinationDirectory, { sample })).toBe(
			"hardlink",
		);
		expect(entries(destinationDirectory)).toEqual([]);
	});

	it.skipIf(isRoot)("falls back to copy on a read-only source with no sample", () => {
		fs.chmodSync(sourceDirectory, 0o555);

		expect(probeTransferStrategy(sourceDirectory, destinationDirectory)).toBe("copy");
	});

	it("rejects a destination directory that does not exist", () => {
		expect(() => probeTransferStrategy(sourceDirectory, path.join(workspace, "absent"))).toThrow(
			TransferError,
		);
	});
});

describe("transferFile", () => {
	it("hardlinks by default, leaving the source seeding", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		const destination = path.join(destinationDirectory, "Movie (2019)", "Movie (2019).mkv");

		const result = transferFile(source, destination);

		expect(result.strategy).toBe("hardlink");
		expect(result.sourceRemoved).toBe(false);
		expect(fs.existsSync(source)).toBe(true);
		expect(inodeOf(source)).toBe(inodeOf(destination));
		expect(fs.readFileSync(destination, "utf8")).toBe("payload");
	});

	it("creates the destination directories it needs", () => {
		const source = write(path.join(sourceDirectory, "episode.mkv"), "payload");
		const destination = path.join(destinationDirectory, "Show (2019)", "Season 01", "e.mkv");

		transferFile(source, destination);

		expect(fs.existsSync(destination)).toBe(true);
	});

	it("removes the source when it does not have to survive", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		const destination = path.join(destinationDirectory, "movie.mkv");

		const result = transferFile(source, destination, { preserveSource: false });

		expect(result.sourceRemoved).toBe(true);
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.readFileSync(destination, "utf8")).toBe("payload");
	});

	it("copies when linking is unsupported and the source must stay", () => {
		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw errno("EPERM");
		});
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		const destination = path.join(destinationDirectory, "movie.mkv");

		const result = transferFile(source, destination);

		expect(result.strategy).toBe("copy");
		expect(fs.existsSync(source)).toBe(true);
		expect(inodeOf(source)).not.toBe(inodeOf(destination));
		expect(fs.readFileSync(destination, "utf8")).toBe("payload");
	});

	it("renames when linking is unsupported and the source may go", () => {
		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw errno("EPERM");
		});
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		const destination = path.join(destinationDirectory, "movie.mkv");

		const result = transferFile(source, destination, { preserveSource: false });

		expect(result.strategy).toBe("rename");
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.readFileSync(destination, "utf8")).toBe("payload");
	});

	it("refuses an explicit rename when the source must be preserved", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");

		expect(() =>
			transferFile(source, path.join(destinationDirectory, "movie.mkv"), { strategy: "rename" }),
		).toThrow(TransferError);
		expect(fs.existsSync(source)).toBe(true);
	});

	it("falls back to a verified copy when rename reports EXDEV", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		const destination = path.join(destinationDirectory, "movie.mkv");

		const realRename = fs.renameSync.bind(fs);
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (from === source) throw errno("EXDEV");
			return realRename(from, to);
		});

		const result = transferFile(source, destination, {
			strategy: "rename",
			preserveSource: false,
		});

		expect(result.strategy).toBe("copy");
		expect(result.sourceRemoved).toBe(true);
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.readFileSync(destination, "utf8")).toBe("payload");
	});

	it("leaves no partial file behind on a successful copy", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");

		transferFile(source, path.join(destinationDirectory, "movie.mkv"), { strategy: "copy" });

		expect(entries(destinationDirectory)).toEqual(["movie.mkv"]);
	});

	it("keeps the source and clears the partial when a copy comes up short", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "the whole payload");
		const destination = path.join(destinationDirectory, "movie.mkv");

		vi.spyOn(fs, "copyFileSync").mockImplementation((_from, to) => {
			fs.writeFileSync(to as string, "trunc");
		});

		expect(() =>
			transferFile(source, destination, { strategy: "copy", preserveSource: false }),
		).toThrow(TransferError);

		// The source is the only intact copy, so it must still be there.
		expect(fs.readFileSync(source, "utf8")).toBe("the whole payload");
		expect(entries(destinationDirectory)).toEqual([]);
		expect(fs.existsSync(`${destination}${PARTIAL_SUFFIX}`)).toBe(false);
	});

	it("refuses a copy that would not fit", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		vi.spyOn(fs, "statfsSync").mockReturnValue(noRoom);

		expect(() =>
			transferFile(source, path.join(destinationDirectory, "movie.mkv"), { strategy: "copy" }),
		).toThrow(/free space/i);
		expect(entries(destinationDirectory)).toEqual([]);
	});

	it("hardlinks onto a full disk, because a link costs no bytes", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		const destination = path.join(destinationDirectory, "movie.mkv");
		vi.spyOn(fs, "statfsSync").mockReturnValue(noRoom);

		const result = transferFile(source, destination);

		expect(result.strategy).toBe("hardlink");
		expect(fs.readFileSync(destination, "utf8")).toBe("payload");
	});

	it("refuses a symlink source", () => {
		const real = write(path.join(workspace, "outside.mkv"), "payload");
		const link = path.join(sourceDirectory, "movie.mkv");
		fs.symlinkSync(real, link);

		expect(() => transferFile(link, path.join(destinationDirectory, "movie.mkv"))).toThrow(
			PathSafetyError,
		);
		expect(entries(destinationDirectory)).toEqual([]);
	});

	it("refuses anything that is not a regular file", () => {
		const directory = path.join(sourceDirectory, "season");
		fs.mkdirSync(directory);

		expect(() => transferFile(directory, path.join(destinationDirectory, "season"))).toThrow(
			TransferError,
		);
	});

	it("refuses a transfer onto itself", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");

		expect(() => transferFile(source, source)).toThrow(TransferError);
	});

	it("fails on a collision by default, leaving the existing file untouched", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "new");
		const destination = write(path.join(destinationDirectory, "movie.mkv"), "existing");

		expect(() => transferFile(source, destination)).toThrow(PathSafetyError);
		expect(fs.readFileSync(destination, "utf8")).toBe("existing");
	});

	it("suffixes around a collision when asked", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "new");
		write(path.join(destinationDirectory, "movie.mkv"), "existing");

		const result = transferFile(source, path.join(destinationDirectory, "movie.mkv"), {
			collision: "suffix",
		});

		expect(path.basename(result.destination)).toBe("movie (2).mkv");
		expect(fs.readFileSync(result.destination, "utf8")).toBe("new");
		expect(fs.readFileSync(path.join(destinationDirectory, "movie.mkv"), "utf8")).toBe("existing");
	});

	it("replaces on a collision when asked", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "new");
		const destination = write(path.join(destinationDirectory, "movie.mkv"), "existing");

		const result = transferFile(source, destination, { collision: "replace" });

		expect(fs.readFileSync(destination, "utf8")).toBe("new");
		expect(entries(destinationDirectory)).toEqual(["movie.mkv"]);
		expect(result.strategy).toBe("hardlink");
	});

	it("reports the bytes moved and the strategy used", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");

		const result = transferFile(source, path.join(destinationDirectory, "movie.mkv"));

		expect(result).toMatchObject({
			bytes: Buffer.byteLength("payload"),
			strategy: "hardlink",
			sourceRemoved: false,
		});
	});
});

describe("planTransfer", () => {
	it("decides everything without writing anything", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		const destination = path.join(destinationDirectory, "Movie (2019)", "Movie (2019).mkv");

		const plan = planTransfer(source, destination);

		expect(plan).toMatchObject({
			source,
			destination,
			strategy: "hardlink",
			bytes: Buffer.byteLength("payload"),
			preserveSource: true,
		});
		// The preview endpoint runs this against directories that do not exist
		// yet, and must not bring them into being.
		expect(entries(destinationDirectory)).toEqual([]);
		expect(fs.existsSync(path.dirname(destination))).toBe(false);
	});

	it("reports the space available where the file will land", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");
		vi.spyOn(fs, "statfsSync").mockReturnValue(noRoom);

		const plan = planTransfer(source, path.join(destinationDirectory, "deep", "movie.mkv"));

		expect(plan.availableBytes).toBe(512);
	});

	it("names the destination the collision policy actually picked", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "new");
		write(path.join(destinationDirectory, "movie.mkv"), "existing");

		const plan = planTransfer(source, path.join(destinationDirectory, "movie.mkv"), {
			collision: "suffix",
		});

		expect(path.basename(plan.destination)).toBe("movie (2).mkv");
	});

	it("refuses a rename that would consume a source it must preserve", () => {
		const source = write(path.join(sourceDirectory, "movie.mkv"), "payload");

		expect(() =>
			planTransfer(source, path.join(destinationDirectory, "movie.mkv"), { strategy: "rename" }),
		).toThrow(TransferError);
	});
});
