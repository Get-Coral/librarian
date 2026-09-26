import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertNotSymlink,
	assertSafeSegment,
	isAtOrInside,
	isInside,
	PathSafetyError,
	realpathWithinRoot,
	resolveCollision,
	resolveWithinRoot,
	sanitizeName,
} from "./paths";

describe("isInside", () => {
	it("accepts descendants", () => {
		expect(isInside("/library", "/library/media")).toBe(true);
		expect(isInside("/library", "/library/media/movies/a.mkv")).toBe(true);
	});

	it("rejects the root itself", () => {
		expect(isInside("/library", "/library")).toBe(false);
		expect(isAtOrInside("/library", "/library")).toBe(true);
	});

	it("rejects a sibling that shares a string prefix", () => {
		// The bug a naive startsWith check has.
		expect(isInside("/library", "/library-old")).toBe(false);
		expect(isInside("/library", "/library-old/media")).toBe(false);
	});

	it("rejects ancestors and unrelated paths", () => {
		expect(isInside("/library", "/")).toBe(false);
		expect(isInside("/library", "/etc/passwd")).toBe(false);
	});
});

describe("assertSafeSegment", () => {
	it("accepts ordinary names", () => {
		expect(() => assertSafeSegment("The Movie (2019)")).not.toThrow();
	});

	it("rejects traversal, separators, empties and null bytes", () => {
		for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b"]) {
			expect(() => assertSafeSegment(bad)).toThrow(PathSafetyError);
		}
	});

	it("rejects segments longer than 255 bytes", () => {
		expect(() => assertSafeSegment("a".repeat(256))).toThrow(PathSafetyError);
		expect(() => assertSafeSegment("a".repeat(255))).not.toThrow();
	});
});

describe("sanitizeName", () => {
	it("strips characters that are unsafe as a path segment", () => {
		expect(sanitizeName('The: Movie / Part "2"')).toBe("The Movie Part 2");
	});

	it("collapses whitespace", () => {
		expect(sanitizeName("The    Movie")).toBe("The Movie");
	});

	it("strips trailing dots and spaces that Windows and SMB silently drop", () => {
		expect(sanitizeName("The Movie .")).toBe("The Movie");
		expect(sanitizeName("The Movie   ")).toBe("The Movie");
	});

	it("refuses a name with nothing usable left", () => {
		expect(() => sanitizeName("///")).toThrow(PathSafetyError);
	});
});

describe("resolveWithinRoot", () => {
	it("joins a relative path onto the root", () => {
		expect(resolveWithinRoot("/library", "media/movies")).toBe("/library/media/movies");
	});

	it("accepts the root itself", () => {
		expect(resolveWithinRoot("/library", "")).toBe("/library");
	});

	it("refuses absolute paths outright", () => {
		expect(() => resolveWithinRoot("/library", "/etc/passwd")).toThrow(/must be relative/);
	});

	it("refuses traversal even when it would stay inside", () => {
		// Normalising this away would be correct but silent; refusing is louder.
		expect(() => resolveWithinRoot("/library", "media/../media")).toThrow(PathSafetyError);
	});

	it("refuses traversal that escapes", () => {
		expect(() => resolveWithinRoot("/library", "../etc/passwd")).toThrow(PathSafetyError);
		expect(() => resolveWithinRoot("/library", "media/../../etc")).toThrow(PathSafetyError);
	});

	it("refuses null bytes", () => {
		expect(() => resolveWithinRoot("/library", "media\u0000/x")).toThrow(PathSafetyError);
	});
});

describe("realpathWithinRoot", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "coral-paths-"));
		root = path.join(base, "library");
		outside = path.join(base, "elsewhere");
		fs.mkdirSync(path.join(root, "media"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(path.dirname(root), { recursive: true, force: true });
	});

	it("resolves a path that exists inside the root", () => {
		const target = path.join(root, "media");
		expect(realpathWithinRoot(root, target)).toBe(fs.realpathSync.native(target));
	});

	it("resolves a destination that does not exist yet", () => {
		// Compared against the realpath of the root, because on macOS the temp
		// dir lives under /var, which is itself a symlink to /private/var.
		const target = path.join(root, "media", "The Movie (2019)", "The Movie (2019).mkv");
		const expected = path.join(
			fs.realpathSync.native(root),
			"media",
			"The Movie (2019)",
			"The Movie (2019).mkv",
		);
		expect(realpathWithinRoot(root, target)).toBe(expected);
	});

	it("rejects a symlink pointing outside the root", () => {
		fs.symlinkSync(outside, path.join(root, "escape"));
		expect(() => realpathWithinRoot(root, path.join(root, "escape"))).toThrow(PathSafetyError);
	});

	it("rejects a not-yet-existing destination whose PARENT is a symlink out", () => {
		// The case a final-path-only check misses: the leaf does not exist, so
		// resolving only the leaf never touches the symlinked parent.
		fs.symlinkSync(outside, path.join(root, "escape"));
		const target = path.join(root, "escape", "planted.mkv");
		expect(fs.existsSync(target)).toBe(false);
		expect(() => realpathWithinRoot(root, target)).toThrow(/escapes its root/);
	});

	it("accepts a symlink that stays inside the root", () => {
		fs.mkdirSync(path.join(root, "real"));
		fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
		const resolved = realpathWithinRoot(root, path.join(root, "alias", "file.mkv"));
		expect(resolved).toBe(path.join(fs.realpathSync.native(path.join(root, "real")), "file.mkv"));
	});
});

describe("assertNotSymlink", () => {
	let base: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "coral-lstat-"));
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it("accepts a regular file", () => {
		const file = path.join(base, "a.mkv");
		fs.writeFileSync(file, "x");
		expect(() => assertNotSymlink(file)).not.toThrow();
	});

	it("accepts a hardlink, which is not a symlink", () => {
		const file = path.join(base, "a.mkv");
		fs.writeFileSync(file, "x");
		const link = path.join(base, "b.mkv");
		fs.linkSync(file, link);
		expect(() => assertNotSymlink(link)).not.toThrow();
	});

	it("rejects a symlink even when its target is fine", () => {
		const file = path.join(base, "a.mkv");
		fs.writeFileSync(file, "x");
		const link = path.join(base, "s.mkv");
		fs.symlinkSync(file, link);
		expect(() => assertNotSymlink(link)).toThrow(/symlink/);
	});

	it("rejects a missing path", () => {
		expect(() => assertNotSymlink(path.join(base, "nope"))).toThrow(PathSafetyError);
	});
});

describe("resolveCollision", () => {
	let base: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "coral-collide-"));
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it("returns the destination untouched when it is free", () => {
		const target = path.join(base, "a.mkv");
		expect(resolveCollision(target, "fail")).toBe(target);
	});

	it("fails by default when the destination exists", () => {
		const target = path.join(base, "a.mkv");
		fs.writeFileSync(target, "x");
		expect(() => resolveCollision(target, "fail")).toThrow(/already exists/);
	});

	it("suffixes before the extension, skipping taken names", () => {
		fs.writeFileSync(path.join(base, "a.mkv"), "x");
		fs.writeFileSync(path.join(base, "a (2).mkv"), "x");
		expect(resolveCollision(path.join(base, "a.mkv"), "suffix")).toBe(path.join(base, "a (3).mkv"));
	});

	it("returns the original path when replacing", () => {
		const target = path.join(base, "a.mkv");
		fs.writeFileSync(target, "x");
		expect(resolveCollision(target, "replace")).toBe(target);
	});
});
