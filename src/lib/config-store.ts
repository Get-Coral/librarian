import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient, getUserById } from "@get-coral/jellyfin";

export interface JellyfinSettings {
	url: string;
	apiKey: string;
	userId: string;
	username?: string;
	password?: string;
}

type SettingsSource = "database" | "env" | "merged" | "missing";

export interface ScanJobRecord {
	id: string;
	kind: string;
	label: string;
	status: "queued" | "running" | "completed" | "failed";
	details?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface ReviewDecisionRecord {
	itemId: string;
	status: "dismissed";
	note?: string;
	createdAt: string;
	updatedAt: string;
}

function getDataDirectory() {
	return process.env.LIBRARIAN_DATA_DIR ?? path.join(process.cwd(), "data");
}

function getDatabasePath() {
	return path.join(getDataDirectory(), "librarian.sqlite");
}

let database: DatabaseSync | null = null;

const CREATE_TABLE_SQL = [
	"CREATE TABLE IF NOT EXISTS app_settings (",
	"  key TEXT PRIMARY KEY,",
	"  value TEXT NOT NULL,",
	"  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
	");",
	"CREATE TABLE IF NOT EXISTS scan_jobs (",
	"  id TEXT PRIMARY KEY,",
	"  kind TEXT NOT NULL,",
	"  label TEXT NOT NULL,",
	"  status TEXT NOT NULL,",
	"  details TEXT,",
	"  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
	"  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
	"  completed_at TEXT",
	");",
	"CREATE TABLE IF NOT EXISTS review_decisions (",
	"  item_id TEXT PRIMARY KEY,",
	"  status TEXT NOT NULL,",
	"  note TEXT,",
	"  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
	"  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
	");",
].join("\n");

function getDatabase() {
	if (database) return database;

	fs.mkdirSync(getDataDirectory(), { recursive: true });
	database = new DatabaseSync(getDatabasePath());
	database.exec(CREATE_TABLE_SQL);

	return database;
}

function getSetting(key: string) {
	const statement = getDatabase().prepare("SELECT value FROM app_settings WHERE key = ?");
	const row = statement.get(key) as { value?: string } | undefined;
	return row?.value;
}

const UPSERT_SQL = [
	"INSERT INTO app_settings (key, value, updated_at)",
	"VALUES (?, ?, CURRENT_TIMESTAMP)",
	"ON CONFLICT(key) DO UPDATE SET",
	"  value = excluded.value,",
	"  updated_at = CURRENT_TIMESTAMP",
].join("\n");

function setSetting(key: string, value: string) {
	const statement = getDatabase().prepare(UPSERT_SQL);
	statement.run(key, value);
}

function normalizeValue(value?: string) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeSettings(settings: Partial<JellyfinSettings>): Partial<JellyfinSettings> {
	return {
		url: normalizeValue(settings.url),
		apiKey: normalizeValue(settings.apiKey),
		userId: normalizeValue(settings.userId),
		username: normalizeValue(settings.username),
		password: normalizeValue(settings.password),
	};
}

function readEnvSettings(): Partial<JellyfinSettings> {
	return {
		url: process.env.JELLYFIN_URL,
		apiKey: process.env.JELLYFIN_API_KEY,
		userId: process.env.JELLYFIN_USER_ID,
		username: process.env.JELLYFIN_USERNAME,
		password: process.env.JELLYFIN_PASSWORD,
	};
}

function areRequiredSettingsComplete(
	settings: Partial<JellyfinSettings>,
): settings is JellyfinSettings {
	return Boolean(settings.url && settings.apiKey && settings.userId);
}

// ── Access control ───────────────────────────────────────────────────────────

const REQUIRE_LOGIN_KEY = "auth.requireLogin";

function parseBoolean(value: string | undefined): boolean | null {
	if (value === undefined) return null;

	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return null;
}

/** Whether `LIBRARIAN_REQUIRE_LOGIN` is pinning the setting from outside. */
export function isRequireLoginLocked(): boolean {
	return parseBoolean(process.env.LIBRARIAN_REQUIRE_LOGIN) !== null;
}

/**
 * Whether Librarian asks for a sign-in.
 *
 * Defaults to **true**, unlike Tide and Aurora. Those two read a library;
 * Librarian moves and deletes the files in it, so an instance nobody has
 * configured yet is closed rather than open.
 */
export function getRequireLogin(): boolean {
	const fromEnvironment = parseBoolean(process.env.LIBRARIAN_REQUIRE_LOGIN);
	if (fromEnvironment !== null) return fromEnvironment;

	return parseBoolean(getSetting(REQUIRE_LOGIN_KEY)) ?? true;
}

export function setRequireLogin(value: boolean): void {
	if (isRequireLoginLocked()) {
		throw new Error(
			"LIBRARIAN_REQUIRE_LOGIN is set in the environment and wins over this setting.",
		);
	}

	setSetting(REQUIRE_LOGIN_KEY, value ? "true" : "false");
}

/** Whether Librarian knows which Jellyfin it belongs to. */
export function isLibrarianConfigured(): boolean {
	return getEffectiveJellyfinSettings() !== null;
}

export function getJellyfinUrl(): string | null {
	return getEffectiveJellyfinSettings()?.url ?? null;
}

/** The shared SQLite handle, for the modules that keep their own tables. */
export function getAppDatabase() {
	return getDatabase();
}

export function getStoredJellyfinSettings(): Partial<JellyfinSettings> {
	return normalizeSettings({
		url: getSetting("jellyfin.url"),
		apiKey: getSetting("jellyfin.apiKey"),
		userId: getSetting("jellyfin.userId"),
		username: getSetting("jellyfin.username"),
		password: getSetting("jellyfin.password"),
	});
}

export function getEffectiveJellyfinSettings(): JellyfinSettings | null {
	const stored = getStoredJellyfinSettings();
	const env = normalizeSettings(readEnvSettings());
	const merged = {
		url: stored.url || env.url,
		apiKey: stored.apiKey || env.apiKey,
		userId: stored.userId || env.userId,
		username: stored.username || env.username,
		password: stored.password || env.password,
	};

	return areRequiredSettingsComplete(merged)
		? {
				url: merged.url,
				apiKey: merged.apiKey,
				userId: merged.userId,
				username: merged.username,
				password: merged.password,
			}
		: null;
}

export function getJellyfinSettingsSource(): SettingsSource {
	const stored = getStoredJellyfinSettings();
	const env = normalizeSettings(readEnvSettings());

	const storedComplete = areRequiredSettingsComplete(stored);
	const envComplete = areRequiredSettingsComplete(env);

	if (storedComplete) return "database";
	if (envComplete) return "env";
	if (Object.values({ ...stored, ...env }).some(Boolean)) return "merged";
	return "missing";
}

export function getConfigurationSummary() {
	const stored = getStoredJellyfinSettings();
	const effective = getEffectiveJellyfinSettings();

	return {
		configured: Boolean(effective),
		source: getJellyfinSettingsSource(),
		current: {
			url: stored.url ?? effective?.url ?? "",
			userId: stored.userId ?? effective?.userId ?? "",
			username: stored.username ?? effective?.username ?? "",
			// Never the secrets themselves. This summary is read by the setup
			// page, which is reachable before anyone has signed in.
			hasApiKey: Boolean(stored.apiKey ?? effective?.apiKey),
			hasPassword: Boolean(stored.password ?? effective?.password),
		},
	};
}

/**
 * Fill in the secrets an operator left blank with the ones already held.
 *
 * The setup form is never sent the API key or the password, so it cannot send
 * them back. A blank field therefore means "leave it alone", not "clear it" —
 * without this, opening setup to change the URL would wipe the credentials.
 */
export function withStoredSecrets(input: JellyfinSettings): JellyfinSettings {
	const stored = getStoredJellyfinSettings();
	const env = normalizeSettings(readEnvSettings());

	const username = normalizeValue(input.username);
	const password = normalizeValue(input.password) ?? stored.password ?? env.password;

	return {
		url: input.url,
		userId: input.userId,
		apiKey: normalizeValue(input.apiKey) ?? stored.apiKey ?? env.apiKey ?? "",
		username,
		// Clearing the account clears its password; there is nothing to keep.
		password: username ? password : undefined,
	};
}

export function saveJellyfinSettings(settings: JellyfinSettings) {
	setSetting("jellyfin.url", settings.url.trim());
	setSetting("jellyfin.apiKey", settings.apiKey.trim());
	setSetting("jellyfin.userId", settings.userId.trim());
	setSetting("jellyfin.username", settings.username?.trim() ?? "");
	setSetting("jellyfin.password", settings.password?.trim() ?? "");
}

export function createScanJob(input: {
	id: string;
	kind: string;
	label: string;
	status: ScanJobRecord["status"];
	details?: string;
}) {
	const statement = getDatabase().prepare(
		[
			"INSERT INTO scan_jobs (id, kind, label, status, details, created_at, updated_at)",
			"VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
		].join("\n"),
	);

	statement.run(input.id, input.kind, input.label, input.status, input.details ?? null);
}

export function updateScanJob(
	id: string,
	input: {
		status: ScanJobRecord["status"];
		details?: string;
		completed?: boolean;
	},
) {
	const statement = getDatabase().prepare(
		[
			"UPDATE scan_jobs",
			"SET status = ?,",
			"    details = ?,",
			"    updated_at = CURRENT_TIMESTAMP,",
			"    completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END",
			"WHERE id = ?",
		].join("\n"),
	);

	statement.run(input.status, input.details ?? null, input.completed ? 1 : 0, id);
}

export function listScanJobs(limit = 8): ScanJobRecord[] {
	const statement = getDatabase().prepare(
		[
			"SELECT id, kind, label, status, details,",
			"       created_at as createdAt,",
			"       updated_at as updatedAt,",
			"       completed_at as completedAt",
			"FROM scan_jobs",
			"ORDER BY datetime(created_at) DESC",
			"LIMIT ?",
		].join("\n"),
	);

	return statement.all(limit) as unknown as ScanJobRecord[];
}

export function dismissReviewItem(itemId: string, note?: string) {
	const statement = getDatabase().prepare(
		[
			"INSERT INTO review_decisions (item_id, status, note, created_at, updated_at)",
			"VALUES (?, 'dismissed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
			"ON CONFLICT(item_id) DO UPDATE SET",
			"  status = 'dismissed',",
			"  note = excluded.note,",
			"  updated_at = CURRENT_TIMESTAMP",
		].join("\n"),
	);

	statement.run(itemId, note ?? null);
}

export function restoreReviewItem(itemId: string) {
	const statement = getDatabase().prepare("DELETE FROM review_decisions WHERE item_id = ?");
	statement.run(itemId);
}

export function listDismissedReviewItems() {
	const statement = getDatabase().prepare(
		[
			"SELECT item_id as itemId, status, note,",
			"       created_at as createdAt,",
			"       updated_at as updatedAt",
			"FROM review_decisions",
			"WHERE status = 'dismissed'",
		].join("\n"),
	);

	return statement.all() as unknown as ReviewDecisionRecord[];
}

export async function validateJellyfinSettings(settings: JellyfinSettings) {
	const normalized = normalizeSettings(settings);

	if (!areRequiredSettingsComplete(normalized)) {
		throw new Error("Server URL, API key, and user ID are required.");
	}

	if (
		(normalized.username && !normalized.password) ||
		(!normalized.username && normalized.password)
	) {
		throw new Error("Provide both username and password, or leave both empty.");
	}

	const client = createClient({
		url: normalized.url,
		apiKey: normalized.apiKey,
		userId: normalized.userId,
		username: normalized.username,
		password: normalized.password,
		clientName: "Librarian",
		deviceName: "Librarian Web",
		deviceId: "librarian-web",
	});

	await getUserById(client, normalized.userId);

	if (normalized.username && normalized.password) {
		await client.getPlaybackAuth();
	}

	return {
		url: normalized.url,
		apiKey: normalized.apiKey,
		userId: normalized.userId,
		username: normalized.username,
		password: normalized.password,
	};
}
