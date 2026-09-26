import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppDatabase } from "#/lib/config-store";
import { type FsRoot, listRoots } from "./roots";

/**
 * Translation between Jellyfin's idea of where a file is and Librarian's.
 *
 * Jellyfin reports library locations in *its own* namespace — `/media/movies`
 * inside its container. Librarian may have the same directory mounted
 * somewhere else entirely. A mapping is the sentence "Jellyfin's
 * /media/movies is my /library/media/movies".
 *
 * The best outcome is an empty table. Mount media and downloads at the same
 * container paths Jellyfin and Tide use and no translation is needed; this
 * machinery exists for the people who cannot.
 */

export interface PathMapping {
	id: string;
	namespace: "jellyfin";
	remotePrefix: string;
	localPrefix: string;
	/** When a real file was last resolved through this mapping, if ever. */
	verifiedAt: string | null;
	createdAt: string;
}

export class MappingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MappingError";
	}
}

const CREATE_MAPPINGS_TABLE_SQL = [
	"CREATE TABLE IF NOT EXISTS path_mappings (",
	"  id TEXT PRIMARY KEY,",
	"  namespace TEXT NOT NULL DEFAULT 'jellyfin',",
	"  remote_prefix TEXT NOT NULL,",
	"  local_prefix TEXT NOT NULL,",
	"  verified_at TEXT,",
	"  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
	"  UNIQUE (namespace, remote_prefix)",
	");",
].join("\n");

let mappingsTableReady = false;

function database() {
	const handle = getAppDatabase();
	if (!mappingsTableReady) {
		handle.exec(CREATE_MAPPINGS_TABLE_SQL);
		mappingsTableReady = true;
	}
	return handle;
}

type MappingRow = {
	id: string;
	namespace: string;
	remote_prefix: string;
	local_prefix: string;
	verified_at: string | null;
	created_at: string;
};

function toMapping(row: MappingRow): PathMapping {
	return {
		id: row.id,
		namespace: row.namespace as "jellyfin",
		remotePrefix: row.remote_prefix,
		localPrefix: row.local_prefix,
		verifiedAt: row.verified_at,
		createdAt: row.created_at,
	};
}

const SELECT_COLUMNS = "id, namespace, remote_prefix, local_prefix, verified_at, created_at";

export function listMappings(): PathMapping[] {
	const rows = database()
		.prepare(`SELECT ${SELECT_COLUMNS} FROM path_mappings ORDER BY length(remote_prefix) DESC`)
		.all() as unknown as MappingRow[];

	return rows.map(toMapping);
}

export function createMapping(input: { remotePrefix: string; localPrefix: string }): PathMapping {
	const remotePrefix = normalizePrefix(input.remotePrefix);
	const localPrefix = normalizePrefix(input.localPrefix);

	if (!path.isAbsolute(remotePrefix) || !path.isAbsolute(localPrefix)) {
		throw new MappingError("Both sides of a mapping must be absolute paths.");
	}

	const id = crypto.randomUUID();
	database()
		.prepare(
			"INSERT INTO path_mappings (id, namespace, remote_prefix, local_prefix) VALUES (?, 'jellyfin', ?, ?)",
		)
		.run(id, remotePrefix, localPrefix);

	return listMappings().find((mapping) => mapping.id === id) as PathMapping;
}

export function deleteMapping(id: string): void {
	database().prepare("DELETE FROM path_mappings WHERE id = ?").run(id);
}

export function markMappingVerified(id: string): void {
	database()
		.prepare("UPDATE path_mappings SET verified_at = CURRENT_TIMESTAMP WHERE id = ?")
		.run(id);
}

/** Trailing slashes make prefix comparison lie; strip them once, here. */
function normalizePrefix(value: string): string {
	const trimmed = value.trim();
	return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** Whether `candidate` is `prefix` or sits beneath it, by path segment. */
function hasPrefix(candidate: string, prefix: string): boolean {
	if (candidate === prefix) return true;
	return candidate.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * Translate a path Jellyfin reported into one Librarian can open.
 *
 * The longest matching prefix wins, so a specific mapping for one library
 * beats a general one for the whole tree. An unmapped path is returned as-is:
 * on a correctly mounted install the two namespaces are already the same, and
 * treating "no mapping" as an error would break the common case.
 */
export function toLocalPath(remotePath: string): string {
	for (const mapping of listMappings()) {
		if (hasPrefix(remotePath, mapping.remotePrefix)) {
			const rest = remotePath.slice(mapping.remotePrefix.length);
			return path.join(mapping.localPrefix, rest);
		}
	}

	return remotePath;
}

export interface MappingSuggestion {
	remotePrefix: string;
	localPrefix: string;
	rootId: string;
	/**
	 * True when both sides are the same path — the install is already aligned
	 * and needs no mapping row at all.
	 */
	aligned: boolean;
}

/**
 * Work out what each Jellyfin library location corresponds to locally.
 *
 * Takes the longest suffix of the location that exists under an enabled root.
 * Jellyfin's `/media/movies` under a `/library` root finds `/library/media/movies`
 * by trying `media/movies` after `library/media/movies` fails.
 */
export function suggestMappings(locations: string[], roots = listRoots()): MappingSuggestion[] {
	const enabled = roots.filter((root) => root.enabled);
	const suggestions: MappingSuggestion[] = [];

	for (const location of locations) {
		const match = findUnderRoots(location, enabled);
		if (!match) continue;

		suggestions.push({
			remotePrefix: normalizePrefix(location),
			localPrefix: match.localPath,
			rootId: match.root.id,
			aligned: normalizePrefix(location) === match.localPath,
		});
	}

	return suggestions;
}

function findUnderRoots(
	location: string,
	roots: FsRoot[],
): { root: FsRoot; localPath: string } | null {
	const segments = normalizePrefix(location).split("/").filter(Boolean);

	// A root that contains the location: Jellyfin's /media/movies under a
	// /library root is /library/media/movies. Longest suffix first, because
	// the most specific match is the right one.
	for (const root of roots) {
		for (let start = 0; start < segments.length; start++) {
			const candidate = path.join(root.path, ...segments.slice(start));
			if (isDirectory(candidate)) return { root, localPath: candidate };
		}
	}

	// A root that *is* the location, mounted under a different prefix:
	// Jellyfin's /library/media/movies is this host's
	// /Users/me/stack/library/media/movies. Neither path contains the other,
	// so the only evidence is that they end the same way.
	for (const root of roots) {
		if (sharedTrailingSegments(segments, root.path) > 0) {
			return { root, localPath: root.path };
		}
	}

	return null;
}

/** How many path segments `location` and `rootPath` end with in common. */
function sharedTrailingSegments(segments: string[], rootPath: string): number {
	const rootSegments = rootPath.split(path.sep).filter(Boolean);

	let shared = 0;
	while (
		shared < segments.length &&
		shared < rootSegments.length &&
		segments[segments.length - 1 - shared] === rootSegments[rootSegments.length - 1 - shared]
	) {
		shared++;
	}

	return shared;
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}
