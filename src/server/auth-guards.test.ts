// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let guards: typeof import("./auth-guards");
let store: typeof import("#/lib/config-store");
let auth: typeof import("#/lib/auth-store");

const ENV_KEYS = [
	"LIBRARIAN_REQUIRE_LOGIN",
	"JELLYFIN_URL",
	"JELLYFIN_API_KEY",
	"JELLYFIN_USER_ID",
	"JELLYFIN_USERNAME",
	"JELLYFIN_PASSWORD",
];

function clearEnv() {
	for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(async () => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-guards-"));
	process.env.LIBRARIAN_DATA_DIR = dataDir;
	clearEnv();
	vi.resetModules();
	guards = await import("./auth-guards");
	store = await import("#/lib/config-store");
	auth = await import("#/lib/auth-store");
});

afterEach(() => {
	delete process.env.LIBRARIAN_DATA_DIR;
	clearEnv();
	fs.rmSync(dataDir, { recursive: true, force: true });
});

function connectJellyfin() {
	store.saveJellyfinSettings({
		url: "http://jellyfin.example",
		apiKey: "key",
		userId: "user-1",
	});
}

function signIn({ isAdmin }: { isAdmin: boolean }) {
	return auth.createAuthSession({
		userId: "user-1",
		username: "root",
		isAdmin,
		jellyfinToken: null,
		deviceId: null,
	});
}

function request(token?: string) {
	const headers = new Headers();
	if (token) headers.set("cookie", `librarian_session=${token}`);
	return new Request("http://librarian.test/api/import", { headers });
}

describe("requireFilesystemAccess", () => {
	it("refuses an unauthenticated request even when sign-in is switched off", async () => {
		connectJellyfin();
		store.setRequireLogin(false);

		// Tide and Aurora would allow this. Librarian must not: the worst an
		// open instance of those does is show a library, this one rearranges
		// the disk.
		const result = await guards.requireFilesystemAccess(request());

		expect(result.denied?.status).toBe(401);
		expect(result.session).toBeNull();
	});

	it("refuses an unauthenticated request when sign-in is on", async () => {
		connectJellyfin();

		expect((await guards.requireFilesystemAccess(request())).denied?.status).toBe(401);
	});

	it("refuses before Librarian is connected to anything", async () => {
		const result = await guards.requireFilesystemAccess(request());

		// No Jellyfin means no account to prove anything with. Setup does not
		// need filesystem access, so this is not a deadlock.
		expect(result.denied?.status).toBe(403);
	});

	it("refuses a signed-in user who is not an administrator", async () => {
		connectJellyfin();
		const token = signIn({ isAdmin: false });

		const result = await guards.requireFilesystemAccess(request(token));

		expect(result.denied?.status).toBe(403);
		expect(result.session?.username).toBe("root");
	});

	it("refuses a token that names no session", async () => {
		connectJellyfin();

		expect((await guards.requireFilesystemAccess(request("made-up"))).denied?.status).toBe(401);
	});

	it("lets a signed-in administrator through", async () => {
		connectJellyfin();
		const token = signIn({ isAdmin: true });

		const result = await guards.requireFilesystemAccess(request(token));

		expect(result.denied).toBeNull();
		expect(result.session).toMatchObject({ username: "root", isAdmin: true });
	});

	it("still refuses when sign-in is off and the instance is unconfigured", async () => {
		store.setRequireLogin(false);

		expect((await guards.requireFilesystemAccess(request())).denied).not.toBeNull();
	});
});

describe("the permissive guards", () => {
	it("allow everything when sign-in is not enforced", async () => {
		connectJellyfin();
		store.setRequireLogin(false);

		expect((await guards.requireSession(request())).denied).toBeNull();
		expect((await guards.requireAdmin(request())).denied).toBeNull();
	});

	it("allow everything before Librarian is configured", async () => {
		// Nothing to authenticate against, and these only read metadata.
		expect((await guards.requireSession(request())).denied).toBeNull();
		expect((await guards.requireAdmin(request())).denied).toBeNull();
	});

	it("ask for a session once sign-in is enforced", async () => {
		connectJellyfin();

		expect((await guards.requireSession(request())).denied?.status).toBe(401);
		expect((await guards.requireAdmin(request())).denied?.status).toBe(401);
	});

	it("separate a user from an administrator", async () => {
		connectJellyfin();
		const token = signIn({ isAdmin: false });

		expect((await guards.requireSession(request(token))).denied).toBeNull();
		expect((await guards.requireAdmin(request(token))).denied?.status).toBe(403);
	});
});

describe("sessions", () => {
	it("stores only a hash of the token", () => {
		connectJellyfin();
		const token = signIn({ isAdmin: true });

		const rows = fs.readFileSync(path.join(dataDir, "librarian.sqlite"));

		expect(rows.includes(Buffer.from(token))).toBe(false);
		expect(auth.getSessionByToken(token)).not.toBeNull();
	});

	it("forgets a session that has expired", () => {
		connectJellyfin();
		const token = signIn({ isAdmin: true });

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);

		expect(auth.getSessionByToken(token)).toBeNull();
	});
});
