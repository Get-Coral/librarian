// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let guard: typeof import("./service-auth");
let tokens: typeof import("#/lib/service-tokens");

beforeEach(async () => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-service-auth-"));
	process.env.LIBRARIAN_DATA_DIR = dataDir;
	delete process.env.CORAL_SERVICE_TOKEN;
	delete process.env.LIBRARIAN_REQUIRE_LOGIN;
	vi.resetModules();
	guard = await import("./service-auth");
	tokens = await import("#/lib/service-tokens");
});

afterEach(() => {
	delete process.env.LIBRARIAN_DATA_DIR;
	delete process.env.CORAL_SERVICE_TOKEN;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

function request(token?: string) {
	const headers = new Headers();
	if (token) headers.set("authorization", `Bearer ${token}`);
	return new Request("http://librarian.test/api/coral/library/refresh", { headers });
}

describe("requireServiceAuth", () => {
	it("refuses a request with no token", async () => {
		const result = await guard.requireServiceAuth(request());

		expect(result.denied?.status).toBe(401);
		expect(result.denied?.headers.get("WWW-Authenticate")).toContain("Bearer");
	});

	it("refuses a token it does not know", async () => {
		expect((await guard.requireServiceAuth(request("made-up"))).denied?.status).toBe(401);
	});

	it("refuses an unconfigured instance just the same", async () => {
		// The escape hatch that keeps first-run setup reachable does not reach
		// here: a cross-module endpoint has no first run to protect.
		expect((await guard.requireServiceAuth(request())).denied?.status).toBe(401);
	});

	it("lets a read token read", async () => {
		const { token } = tokens.mintServiceToken({ label: "Tide", scopes: ["read"] });

		expect((await guard.requireServiceAuth(request(token), "read")).denied).toBeNull();
	});

	it("does not let a read token act", async () => {
		const { token } = tokens.mintServiceToken({ label: "Tide", scopes: ["read"] });

		expect((await guard.requireServiceAuth(request(token), "full")).denied?.status).toBe(403);
	});

	it("lets a full token do both", async () => {
		const { token } = tokens.mintServiceToken({ label: "Tide", scopes: ["full"] });

		expect((await guard.requireServiceAuth(request(token), "read")).denied).toBeNull();
		expect((await guard.requireServiceAuth(request(token), "full")).denied).toBeNull();
	});

	it("hands back a token that names no user", async () => {
		const { token } = tokens.mintServiceToken({ label: "Tide", scopes: ["full"] });

		const result = await guard.requireServiceAuth(request(token), "full");

		// A token is a capability grant, not an impersonation.
		expect(result.token).not.toHaveProperty("userId");
		expect(result.token).not.toHaveProperty("username");
	});
});
