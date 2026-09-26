// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let store: typeof import("./config-store");

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
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-config-"));
	process.env.LIBRARIAN_DATA_DIR = dataDir;
	clearEnv();
	// Fresh module graph per test so the SQLite handle picks up the data dir.
	vi.resetModules();
	store = await import("./config-store");
});

afterEach(() => {
	delete process.env.LIBRARIAN_DATA_DIR;
	clearEnv();
	fs.rmSync(dataDir, { recursive: true, force: true });
});

const SETTINGS = {
	url: "http://jellyfin.example",
	apiKey: "secret-key",
	userId: "user-1",
	username: "root",
	password: "secret-password",
};

describe("getConfigurationSummary", () => {
	it("never hands out the secrets it holds", () => {
		store.saveJellyfinSettings(SETTINGS);

		const summary = store.getConfigurationSummary();

		// The setup page is reachable before anyone has signed in, so this
		// payload must not carry credentials.
		expect(JSON.stringify(summary)).not.toContain("secret-key");
		expect(JSON.stringify(summary)).not.toContain("secret-password");
		expect(summary.current).not.toHaveProperty("apiKey");
		expect(summary.current).not.toHaveProperty("password");
	});

	it("says whether the secrets exist", () => {
		expect(store.getConfigurationSummary().current.hasApiKey).toBe(false);

		store.saveJellyfinSettings(SETTINGS);

		expect(store.getConfigurationSummary().current).toMatchObject({
			hasApiKey: true,
			hasPassword: true,
			url: "http://jellyfin.example",
			username: "root",
		});
	});

	it("reports an API key that only the environment knows about", () => {
		process.env.JELLYFIN_URL = "http://jellyfin.example";
		process.env.JELLYFIN_API_KEY = "env-key";
		process.env.JELLYFIN_USER_ID = "user-1";

		expect(store.getConfigurationSummary().current.hasApiKey).toBe(true);
	});
});

describe("withStoredSecrets", () => {
	it("keeps the stored API key when the field is left blank", () => {
		store.saveJellyfinSettings(SETTINGS);

		const merged = store.withStoredSecrets({
			url: "http://moved.example",
			apiKey: "",
			userId: "user-1",
			username: "root",
			password: "",
		});

		// Editing the URL must not wipe credentials the form never received.
		expect(merged.apiKey).toBe("secret-key");
		expect(merged.password).toBe("secret-password");
		expect(merged.url).toBe("http://moved.example");
	});

	it("takes a new secret when one is given", () => {
		store.saveJellyfinSettings(SETTINGS);

		const merged = store.withStoredSecrets({ ...SETTINGS, apiKey: "rotated", password: "changed" });

		expect(merged.apiKey).toBe("rotated");
		expect(merged.password).toBe("changed");
	});

	it("falls back to the environment when nothing is stored", () => {
		process.env.JELLYFIN_API_KEY = "env-key";
		process.env.JELLYFIN_PASSWORD = "env-password";

		const merged = store.withStoredSecrets({
			url: "http://jellyfin.example",
			apiKey: "",
			userId: "user-1",
			username: "root",
			password: "",
		});

		expect(merged.apiKey).toBe("env-key");
		expect(merged.password).toBe("env-password");
	});

	it("drops the password when the account it belongs to is cleared", () => {
		store.saveJellyfinSettings(SETTINGS);

		const merged = store.withStoredSecrets({
			url: SETTINGS.url,
			apiKey: "",
			userId: SETTINGS.userId,
			username: "",
			password: "",
		});

		expect(merged.username).toBeUndefined();
		expect(merged.password).toBeUndefined();
	});
});

describe("getRequireLogin", () => {
	it("defaults to on, unlike the read-only modules", () => {
		// Librarian can move and delete files, so a fresh install is closed.
		expect(store.getRequireLogin()).toBe(true);
		expect(store.isRequireLoginLocked()).toBe(false);
	});

	it("remembers being switched off", () => {
		store.setRequireLogin(false);

		expect(store.getRequireLogin()).toBe(false);
	});

	it("lets the environment pin it either way", () => {
		store.setRequireLogin(false);
		process.env.LIBRARIAN_REQUIRE_LOGIN = "true";

		expect(store.getRequireLogin()).toBe(true);
		expect(store.isRequireLoginLocked()).toBe(true);
		expect(() => store.setRequireLogin(false)).toThrow(/environment/i);
	});

	it("ignores a value it cannot read", () => {
		process.env.LIBRARIAN_REQUIRE_LOGIN = "perhaps";

		expect(store.isRequireLoginLocked()).toBe(false);
		expect(store.getRequireLogin()).toBe(true);
	});
});

describe("isLibrarianConfigured", () => {
	it("is false until there is a Jellyfin to talk to", () => {
		expect(store.isLibrarianConfigured()).toBe(false);

		store.saveJellyfinSettings(SETTINGS);

		expect(store.isLibrarianConfigured()).toBe(true);
		expect(store.getJellyfinUrl()).toBe("http://jellyfin.example");
	});
});
