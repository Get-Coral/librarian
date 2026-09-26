import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppDatabase } from "#/lib/config-store";

/**
 * The directories Librarian is allowed to touch.
 *
 * Kept separate from path mappings on purpose. A root answers "may Librarian
 * write here", a mapping answers "what does Jellyfin call this place".
 * Conflating the two is what makes remote-path-mapping confusing in the *arr
 * apps, where one field quietly does both jobs.
 *
 * Nothing is enabled by default. A Librarian that happens to have /media
 * mounted can do nothing with it until a human says so — the environment
 * seeds a row, it does not grant permission.
 */

export type RootKind = "downloads" | "media";
export type RootSource = "env" | "user";

export interface FsRoot {
	id: string;
	label: string;
	kind: RootKind;
	path: string;
	writable: boolean;
	enabled: boolean;
	source: RootSource;
	createdAt: string;
	updatedAt: string;
}

export class RootError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RootError";
	}
}

const CREATE_ROOTS_TABLE_SQL = [
	"CREATE TABLE IF NOT EXISTS fs_roots (",
	"  id TEXT PRIMARY KEY,",
	"  label TEXT NOT NULL,",
	"  kind TEXT NOT NULL,",
	"  path TEXT NOT NULL UNIQUE,",
	"  writable INTEGER NOT NULL DEFAULT 0,",
	"  enabled INTEGER NOT NULL DEFAULT 0,",
	"  source TEXT NOT NULL DEFAULT 'user',",
	"  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
	"  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
	");",
].join("\n");

let rootsTableReady = false;

function database() {
	const handle = getAppDatabase();
	if (!rootsTableReady) {
		handle.exec(CREATE_ROOTS_TABLE_SQL);
		rootsTableReady = true;
	}
	return handle;
}

type RootRow = {
	id: string;
	label: string;
	kind: string;
	path: string;
	writable: number;
	enabled: number;
	source: string;
	created_at: string;
	updated_at: string;
};

function toRoot(row: RootRow): FsRoot {
	return {
		id: row.id,
		label: row.label,
		kind: row.kind as RootKind,
		path: row.path,
		writable: row.writable === 1,
		enabled: row.enabled === 1,
		source: row.source as RootSource,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const SELECT_COLUMNS = "id, label, kind, path, writable, enabled, source, created_at, updated_at";

export function listRoots(): FsRoot[] {
	const rows = database()
		.prepare(`SELECT ${SELECT_COLUMNS} FROM fs_roots ORDER BY kind, label`)
		.all() as unknown as RootRow[];

	return rows.map(toRoot);
}

export function getRoot(id: string): FsRoot | null {
	const row = database().prepare(`SELECT ${SELECT_COLUMNS} FROM fs_roots WHERE id = ?`).get(id) as
		| RootRow
		| undefined;

	return row ? toRoot(row) : null;
}

/**
 * The root an API call named, or an error.
 *
 * Every filesystem endpoint goes through this rather than accepting a path,
 * so "which directory" is always a choice between rows an operator enabled.
 */
export function requireEnabledRoot(id: string): FsRoot {
	const root = getRoot(id);
	if (!root) throw new RootError(`No such root: ${id}`);
	if (!root.enabled) throw new RootError(`The "${root.label}" root is turned off.`);
	return root;
}

function assertUsableDirectory(target: string): string {
	if (!path.isAbsolute(target)) {
		throw new RootError("A root must be an absolute path.");
	}

	let resolved: string;
	try {
		resolved = fs.realpathSync.native(target);
	} catch {
		throw new RootError(`"${target}" does not exist.`);
	}

	if (!fs.statSync(resolved).isDirectory()) {
		throw new RootError(`"${target}" is not a directory.`);
	}

	return resolved;
}

/** Whether the process can actually write here, rather than whether it says so. */
export function probeWritable(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export interface CreateRootInput {
	label: string;
	kind: RootKind;
	path: string;
	enabled?: boolean;
	source?: RootSource;
}

export function createRoot(input: CreateRootInput): FsRoot {
	const resolved = assertUsableDirectory(input.path);

	const existing = database()
		.prepare(`SELECT ${SELECT_COLUMNS} FROM fs_roots WHERE path = ?`)
		.get(resolved) as RootRow | undefined;
	if (existing) {
		throw new RootError(`"${resolved}" is already a root.`);
	}

	const root: FsRoot = {
		id: crypto.randomUUID(),
		label: input.label.trim() || path.basename(resolved),
		kind: input.kind,
		path: resolved,
		writable: probeWritable(resolved),
		// Off unless someone deliberately says otherwise.
		enabled: input.enabled === true,
		source: input.source ?? "user",
		createdAt: "",
		updatedAt: "",
	};

	database()
		.prepare(
			[
				"INSERT INTO fs_roots (id, label, kind, path, writable, enabled, source)",
				"VALUES (?, ?, ?, ?, ?, ?, ?)",
			].join(" "),
		)
		.run(
			root.id,
			root.label,
			root.kind,
			root.path,
			root.writable ? 1 : 0,
			root.enabled ? 1 : 0,
			root.source,
		);

	return getRoot(root.id) as FsRoot;
}

export function updateRoot(
	id: string,
	patch: { label?: string; kind?: RootKind; enabled?: boolean },
): FsRoot {
	const root = getRoot(id);
	if (!root) throw new RootError(`No such root: ${id}`);

	const label = patch.label?.trim() || root.label;
	const kind = patch.kind ?? root.kind;
	const enabled = patch.enabled ?? root.enabled;

	// Re-probe on the way through: a mount can go read-only underneath us.
	database()
		.prepare(
			[
				"UPDATE fs_roots",
				"SET label = ?, kind = ?, enabled = ?, writable = ?, updated_at = CURRENT_TIMESTAMP",
				"WHERE id = ?",
			].join(" "),
		)
		.run(label, kind, enabled ? 1 : 0, probeWritable(root.path) ? 1 : 0, id);

	return getRoot(id) as FsRoot;
}

export function deleteRoot(id: string): void {
	database().prepare("DELETE FROM fs_roots WHERE id = ?").run(id);
}

/**
 * Turn `LIBRARIAN_DOWNLOADS_DIR` and `LIBRARIAN_MEDIA_DIR` into rows.
 *
 * Idempotent, and it only ever creates: an operator who turned a seeded root
 * off, relabelled it, or deleted it does not get overruled on the next boot.
 * Seeded rows arrive disabled like any other.
 */
export function seedRootsFromEnvironment(): FsRoot[] {
	const seeds: { variable: string; kind: RootKind; label: string }[] = [
		{ variable: "LIBRARIAN_DOWNLOADS_DIR", kind: "downloads", label: "Downloads" },
		{ variable: "LIBRARIAN_MEDIA_DIR", kind: "media", label: "Media" },
	];

	const created: FsRoot[] = [];

	for (const seed of seeds) {
		const value = process.env[seed.variable]?.trim();
		if (!value) continue;

		try {
			created.push(createRoot({ label: seed.label, kind: seed.kind, path: value, source: "env" }));
		} catch {
			// Already a root, or not a usable directory. Either way, leave it.
		}
	}

	return created;
}
