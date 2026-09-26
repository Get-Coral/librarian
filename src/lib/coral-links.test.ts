// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let links: typeof import("./coral-links");
let ledger: typeof import("./import-ledger");
let client: typeof import("./coral-client");

beforeEach(async () => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-links-"));
	process.env.LIBRARIAN_DATA_DIR = dataDir;
	vi.resetModules();
	links = await import("./coral-links");
	ledger = await import("./import-ledger");
	client = await import("./coral-client");
});

afterEach(() => {
	delete process.env.LIBRARIAN_DATA_DIR;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

const CAPABILITIES = [{ name: "downloads.list", version: 1, path: "/api/coral/downloads" }];

function link(url = "http://tide:3000/") {
	return links.saveLink({
		url,
		token: "coral_tide_secret",
		moduleId: "tide",
		moduleName: "Tide",
		moduleVersion: "1.3.0",
		capabilities: CAPABILITIES,
	});
}

describe("links", () => {
	it("never hands the token back out", () => {
		link();

		expect(JSON.stringify(links.listLinks())).not.toContain("coral_tide_secret");
		expect(links.listLinks()[0]).not.toHaveProperty("token");
		// It is still there for making a request with.
		expect(links.getLinkWithToken(links.listLinks()[0].id)?.token).toBe("coral_tide_secret");
	});

	it("drops a trailing slash so paths join cleanly", () => {
		expect(link("http://tide:3000/").url).toBe("http://tide:3000");
	});

	it("updates the existing record rather than duplicating a URL", () => {
		const first = link();
		const second = link();

		expect(links.listLinks()).toHaveLength(1);
		expect(second.id).toBe(first.id);
		expect(second.addedAt).toBe(first.addedAt);
	});

	it("takes the path a module declares, never one derived from the name", () => {
		const saved = link();

		expect(links.hasCapability(saved, "downloads.list")).toBe(true);
		expect(links.capabilityPath(saved, "downloads.list")).toBe("/api/coral/downloads");
		expect(links.capabilityPath(saved, "downloads.events")).toBeNull();
	});

	it("does not claim a capability at a version it was not offered at", () => {
		const saved = link();

		expect(links.hasCapability(saved, "downloads.list", 1)).toBe(true);
		expect(links.hasCapability(saved, "downloads.list", 2)).toBe(false);
	});

	it("forgets a disconnected module", () => {
		const saved = link();
		links.deleteLink(saved.id);

		expect(links.listLinks()).toEqual([]);
	});
});

describe("parseManifest", () => {
	const valid = {
		spec: 1,
		module: { id: "tide", name: "Tide", version: "1.3.0" },
		auth: { required: true, schemes: ["bearer"] },
		capabilities: CAPABILITIES,
	};

	it("reads a manifest", () => {
		expect(client.parseManifest(valid)).toMatchObject({
			spec: 1,
			module: { id: "tide", name: "Tide" },
			capabilities: CAPABILITIES,
		});
	});

	it("ignores fields from a version it has not been taught about", () => {
		// Additive-only: an old consumer must keep working against a new module.
		const parsed = client.parseManifest({
			...valid,
			futureField: { nested: true },
			capabilities: [...CAPABILITIES, { name: "downloads.future", version: 9, path: "/f" }],
		});

		expect(parsed.capabilities).toHaveLength(2);
		expect(parsed.module.name).toBe("Tide");
	});

	it("drops a capability it could not use", () => {
		const parsed = client.parseManifest({
			...valid,
			capabilities: [
				{ name: "no.path", version: 1 },
				{ name: "no.version", path: "/x" },
				"nonsense",
				...CAPABILITIES,
			],
		});

		expect(parsed.capabilities).toEqual(CAPABILITIES);
	});

	it("refuses something that is not a Coral module", () => {
		expect(() => client.parseManifest({ hello: "world" })).toThrow(client.CoralError);
		expect(() => client.parseManifest("<html>")).toThrow(client.CoralError);
		expect(() => client.parseManifest(null)).toThrow(client.CoralError);
	});

	it("refuses a spec from the future rather than guessing", () => {
		expect(() => client.parseManifest({ ...valid, spec: 2 })).toThrow(/spec 2/);
	});

	it("assumes auth is required when a module does not say", () => {
		// The safe default: ask for a token rather than assume it is open.
		expect(client.parseManifest({ ...valid, auth: {} }).auth.required).toBe(true);
	});
});

describe("the import ledger", () => {
	it("remembers what has been imported, per link", () => {
		ledger.recordImported({
			linkId: "link-a",
			downloadId: "abc",
			rootRelativePath: "Some.Release",
			jobId: "job-1",
		});

		expect(ledger.importedIds("link-a").has("abc")).toBe(true);
		// Two modules may well use the same torrent id.
		expect(ledger.importedIds("link-b").has("abc")).toBe(false);
	});

	it("survives being told twice", () => {
		for (const jobId of ["job-1", "job-2"]) {
			ledger.recordImported({
				linkId: "link-a",
				downloadId: "abc",
				rootRelativePath: "Some.Release",
				jobId,
			});
		}

		const entries = ledger.listLedger("link-a");
		expect(entries).toHaveLength(1);
		expect(entries[0].jobId).toBe("job-2");
	});

	it("can be told to offer something again", () => {
		ledger.recordImported({
			linkId: "link-a",
			downloadId: "abc",
			rootRelativePath: null,
			jobId: null,
		});
		ledger.forgetImported("link-a", "abc");

		expect(ledger.importedIds("link-a").has("abc")).toBe(false);
	});
});
