import { getAppDatabase } from "./config-store";

/**
 * What Librarian has already imported from a linked module.
 *
 * This is the whole reason consumer-pull works. A producer emits full
 * snapshots and has no idea what anyone has done with them; only the consumer
 * knows what it has already acted on, and that knowledge lives here. Diffing
 * a snapshot against this ledger is what makes re-reading the same download a
 * hundred times harmless.
 */

const CREATE_LEDGER_TABLE_SQL = [
	"CREATE TABLE IF NOT EXISTS import_ledger (",
	"  id TEXT PRIMARY KEY,",
	"  link_id TEXT NOT NULL,",
	"  download_id TEXT NOT NULL,",
	"  root_relative_path TEXT,",
	"  job_id TEXT,",
	"  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
	");",
].join("\n");

let ledgerTableReady = false;

function database() {
	const handle = getAppDatabase();
	if (!ledgerTableReady) {
		handle.exec(CREATE_LEDGER_TABLE_SQL);
		ledgerTableReady = true;
	}
	return handle;
}

export interface LedgerEntry {
	id: string;
	linkId: string;
	downloadId: string;
	rootRelativePath: string | null;
	jobId: string | null;
	importedAt: string;
}

/** Scoped per link: two modules may well use the same torrent id. */
function keyFor(linkId: string, downloadId: string): string {
	return `${linkId}:${downloadId}`;
}

export function recordImported(input: {
	linkId: string;
	downloadId: string;
	rootRelativePath: string | null;
	jobId: string | null;
}): void {
	database()
		.prepare(
			[
				"INSERT INTO import_ledger (id, link_id, download_id, root_relative_path, job_id)",
				"VALUES (?, ?, ?, ?, ?)",
				// Re-importing on purpose updates the record rather than failing.
				"ON CONFLICT(id) DO UPDATE SET",
				"  root_relative_path = excluded.root_relative_path,",
				"  job_id = excluded.job_id,",
				"  imported_at = CURRENT_TIMESTAMP",
			].join(" "),
		)
		.run(
			keyFor(input.linkId, input.downloadId),
			input.linkId,
			input.downloadId,
			input.rootRelativePath,
			input.jobId,
		);
}

export function importedIds(linkId: string): Set<string> {
	const rows = database()
		.prepare("SELECT download_id FROM import_ledger WHERE link_id = ?")
		.all(linkId) as unknown as { download_id: string }[];

	return new Set(rows.map((row) => row.download_id));
}

/** Forget one entry, so a download can be offered again. */
export function forgetImported(linkId: string, downloadId: string): void {
	database().prepare("DELETE FROM import_ledger WHERE id = ?").run(keyFor(linkId, downloadId));
}

export function listLedger(linkId: string, limit = 50): LedgerEntry[] {
	const rows = database()
		.prepare(
			[
				"SELECT id, link_id as linkId, download_id as downloadId,",
				"       root_relative_path as rootRelativePath, job_id as jobId,",
				"       imported_at as importedAt",
				"FROM import_ledger WHERE link_id = ?",
				"ORDER BY datetime(imported_at) DESC LIMIT ?",
			].join(" "),
		)
		.all(linkId, limit) as unknown as LedgerEntry[];

	return rows;
}
