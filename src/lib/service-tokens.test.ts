// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let tokens: typeof import("./service-tokens");

beforeEach(async () => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tokens-"));
	process.env.LIBRARIAN_DATA_DIR = dataDir;
	delete process.env.CORAL_SERVICE_TOKEN;
	vi.resetModules();
	tokens = await import("./service-tokens");
});

afterEach(() => {
	delete process.env.LIBRARIAN_DATA_DIR;
	delete process.env.CORAL_SERVICE_TOKEN;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("mintServiceToken", () => {
	it("names the module it belongs to", () => {
		const { token } = tokens.mintServiceToken({ label: "Tide", scopes: ["read"] });

		expect(token).toMatch(/^coral_librarian_[0-9a-f]{48}$/);
	});

	it("keeps only a hash, so the secret cannot be read back", () => {
		const { token } = tokens.mintServiceToken({ label: "Tide", scopes: ["read"] });

		const stored = fs.readFileSync(path.join(dataDir, "librarian.sqlite"));
		expect(stored.includes(Buffer.from(token))).toBe(false);
		expect(JSON.stringify(tokens.listServiceTokens())).not.toContain(token);
	});

	it("never exposes the hash either", () => {
		tokens.mintServiceToken({ label: "Tide", scopes: ["read"] });

		expect(tokens.listServiceTokens()[0]).not.toHaveProperty("hash");
	});

	it("falls back to the narrower scope when none is given", () => {
		const { record } = tokens.mintServiceToken({ label: "Tide", scopes: [] });

		expect(record.scopes).toEqual(["read"]);
	});
});

describe("verifyServiceToken", () => {
	it("recognises a token it minted", () => {
		const { token, record } = tokens.mintServiceToken({ label: "Tide", scopes: ["full"] });

		expect(tokens.verifyServiceToken(token)?.id).toBe(record.id);
	});

	it("refuses anything it did not mint", () => {
		tokens.mintServiceToken({ label: "Tide", scopes: ["full"] });

		expect(tokens.verifyServiceToken("coral_librarian_nope")).toBeNull();
		expect(tokens.verifyServiceToken("")).toBeNull();
		expect(tokens.verifyServiceToken(null)).toBeNull();
	});

	it("forgets a revoked token", () => {
		const { token, record } = tokens.mintServiceToken({ label: "Tide", scopes: ["full"] });
		tokens.revokeServiceToken(record.id);

		expect(tokens.verifyServiceToken(token)).toBeNull();
		expect(tokens.listServiceTokens()).toEqual([]);
	});

	it("records when a token was last used", () => {
		const { token } = tokens.mintServiceToken({ label: "Tide", scopes: ["read"] });
		expect(tokens.listServiceTokens()[0].lastUsedAt).toBeNull();

		tokens.verifyServiceToken(token);

		expect(tokens.listServiceTokens()[0].lastUsedAt).not.toBeNull();
	});

	it("accepts the environment escape hatch with full scope", () => {
		process.env.CORAL_SERVICE_TOKEN = "compose-only-secret";

		const token = tokens.verifyServiceToken("compose-only-secret");

		expect(token).toMatchObject({ id: "environment", scopes: ["full"] });
		// It is never written down.
		expect(tokens.listServiceTokens()).toEqual([]);
	});

	it("does not accept a near miss of the environment token", () => {
		process.env.CORAL_SERVICE_TOKEN = "compose-only-secret";

		expect(tokens.verifyServiceToken("compose-only-secre")).toBeNull();
	});
});

describe("bearerToken", () => {
	function request(header?: string) {
		const headers = new Headers();
		if (header) headers.set("authorization", header);
		return new Request("http://librarian.test/api/coral/manifest", { headers });
	}

	it("reads a bearer header", () => {
		expect(tokens.bearerToken(request("Bearer abc123"))).toBe("abc123");
		expect(tokens.bearerToken(request("bearer abc123"))).toBe("abc123");
	});

	it("ignores other schemes and empty values", () => {
		expect(tokens.bearerToken(request("Basic abc123"))).toBeNull();
		expect(tokens.bearerToken(request("Bearer   "))).toBeNull();
		expect(tokens.bearerToken(request())).toBeNull();
	});
});
