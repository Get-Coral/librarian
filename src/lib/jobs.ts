import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppDatabase } from "./config-store";
import { listRoots } from "./files/roots";
import { PARTIAL_SUFFIX } from "./files/transfer";

/**
 * A job queue, one worker, no concurrency.
 *
 * Importing is the only long-running thing Librarian does and it is
 * filesystem-bound, so two at once would only make both slower while doubling
 * the ways they can collide over the same destination. One at a time is not a
 * limitation to fix later; it is the design.
 *
 * Built on the existing `scan_jobs` table rather than a new one. `kind` was
 * already free-form, and `node:sqlite` has no `ADD COLUMN IF NOT EXISTS`, so
 * the extra columns go on through a `PRAGMA table_info` check.
 */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Payloads round-trip through SQLite as JSON, so this is what they can be. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface Job {
	id: string;
	kind: string;
	label: string;
	status: JobStatus;
	details: string | null;
	payload: JsonValue;
	totalBytes: number;
	doneBytes: number;
	error: string | null;
	cancelRequested: boolean;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}

export class JobCancelled extends Error {
	constructor() {
		super("Cancelled.");
		this.name = "JobCancelled";
	}
}

let columnsReady = false;

/** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which SQLite does not have. */
function ensureColumn(table: string, column: string, definition: string) {
	const handle = getAppDatabase();
	const existing = handle.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
		name: string;
	}[];

	if (existing.some((row) => row.name === column)) return;
	handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function database() {
	const handle = getAppDatabase();

	if (!columnsReady) {
		ensureColumn("scan_jobs", "payload", "TEXT");
		ensureColumn("scan_jobs", "total_bytes", "INTEGER NOT NULL DEFAULT 0");
		ensureColumn("scan_jobs", "done_bytes", "INTEGER NOT NULL DEFAULT 0");
		ensureColumn("scan_jobs", "error", "TEXT");
		ensureColumn("scan_jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
		columnsReady = true;
	}

	return handle;
}

type JobRow = {
	id: string;
	kind: string;
	label: string;
	status: string;
	details: string | null;
	payload: string | null;
	total_bytes: number;
	done_bytes: number;
	error: string | null;
	cancel_requested: number;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

function toJob(row: JobRow): Job {
	return {
		id: row.id,
		kind: row.kind,
		label: row.label,
		status: row.status as JobStatus,
		details: row.details,
		payload: row.payload === null ? null : safeParse(row.payload),
		totalBytes: row.total_bytes,
		doneBytes: row.done_bytes,
		error: row.error,
		cancelRequested: row.cancel_requested === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
	};
}

function safeParse(value: string): JsonValue {
	try {
		return JSON.parse(value) as JsonValue;
	} catch {
		return null;
	}
}

const SELECT_COLUMNS = [
	"id, kind, label, status, details, payload,",
	"total_bytes, done_bytes, error, cancel_requested,",
	"created_at, updated_at, completed_at",
].join(" ");

export function getJob(id: string): Job | null {
	const row = database().prepare(`SELECT ${SELECT_COLUMNS} FROM scan_jobs WHERE id = ?`).get(id) as
		| JobRow
		| undefined;

	return row ? toJob(row) : null;
}

export function listJobs(limit = 20): Job[] {
	const rows = database()
		.prepare(`SELECT ${SELECT_COLUMNS} FROM scan_jobs ORDER BY datetime(created_at) DESC LIMIT ?`)
		.all(limit) as unknown as JobRow[];

	return rows.map(toJob);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export interface JobContext {
	id: string;
	payload: JsonValue;
	/** Throw if the operator asked to stop. Call between units of work. */
	checkpoint(): void;
	report(update: { doneBytes?: number; totalBytes?: number; details?: string }): void;
}

export type JobHandler = (context: JobContext) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler) {
	handlers.set(kind, handler);
}

// ── Queue ────────────────────────────────────────────────────────────────────

export function enqueueJob(input: {
	kind: string;
	label: string;
	payload?: JsonValue;
	totalBytes?: number;
	details?: string;
}): Job {
	ensureBootRecovery();
	const id = randomUUID();

	database()
		.prepare(
			[
				"INSERT INTO scan_jobs (id, kind, label, status, details, payload, total_bytes)",
				"VALUES (?, ?, ?, 'queued', ?, ?, ?)",
			].join(" "),
		)
		.run(
			id,
			input.kind,
			input.label,
			input.details ?? null,
			input.payload === undefined ? null : JSON.stringify(input.payload),
			input.totalBytes ?? 0,
		);

	kick();

	return getJob(id) as Job;
}

export function requestCancel(id: string): void {
	database()
		.prepare(
			"UPDATE scan_jobs SET cancel_requested = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		)
		.run(id);

	// A job still waiting its turn can be stopped outright.
	database()
		.prepare(
			[
				"UPDATE scan_jobs",
				"SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP",
				"WHERE id = ? AND status = 'queued'",
			].join(" "),
		)
		.run(id);
}

function isCancelRequested(id: string): boolean {
	const row = database().prepare("SELECT cancel_requested FROM scan_jobs WHERE id = ?").get(id) as
		| { cancel_requested: number }
		| undefined;

	return row?.cancel_requested === 1;
}

function nextQueued(): Job | null {
	const row = database()
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM scan_jobs WHERE status = 'queued' ORDER BY datetime(created_at) LIMIT 1`,
		)
		.get() as JobRow | undefined;

	return row ? toJob(row) : null;
}

function finish(id: string, status: JobStatus, fields: { details?: string; error?: string }) {
	database()
		.prepare(
			[
				"UPDATE scan_jobs",
				// COALESCE: finishing without a message keeps whatever the handler
				// last reported, rather than erasing its summary.
				"SET status = ?, details = COALESCE(?, details), error = ?,",
				"    completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP",
				"WHERE id = ?",
			].join(" "),
		)
		.run(status, fields.details ?? null, fields.error ?? null, id);
}

function contextFor(job: Job): JobContext {
	return {
		id: job.id,
		payload: job.payload,
		checkpoint() {
			if (isCancelRequested(job.id)) throw new JobCancelled();
		},
		report(update) {
			database()
				.prepare(
					[
						"UPDATE scan_jobs",
						"SET done_bytes = COALESCE(?, done_bytes),",
						"    total_bytes = COALESCE(?, total_bytes),",
						"    details = COALESCE(?, details),",
						"    updated_at = CURRENT_TIMESTAMP",
						"WHERE id = ?",
					].join(" "),
				)
				.run(update.doneBytes ?? null, update.totalBytes ?? null, update.details ?? null, job.id);
		},
	};
}

async function runJob(job: Job) {
	const handler = handlers.get(job.kind);
	if (!handler) {
		finish(job.id, "failed", { error: `No handler registered for "${job.kind}".` });
		return;
	}

	database()
		.prepare("UPDATE scan_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
		.run(job.id);

	try {
		await handler(contextFor(job));
		finish(job.id, "completed", {});
	} catch (error) {
		if (error instanceof JobCancelled) {
			finish(job.id, "cancelled", { details: "Cancelled." });
			return;
		}
		finish(job.id, "failed", {
			error: error instanceof Error ? error.message : "The job failed unexpectedly.",
		});
	}
}

let worker: Promise<void> | null = null;

function kick() {
	if (worker) return;

	worker = (async () => {
		for (;;) {
			const job = nextQueued();
			if (!job) return;
			await runJob(job);
		}
	})().finally(() => {
		worker = null;
	});
}

/** Resolves when the queue is empty. Used by the tests and by `POST /import`. */
export async function whenIdle(): Promise<void> {
	while (worker) await worker;
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Put the job table back into a truthful state after a restart.
 *
 * A row left `running` means the process died mid-job — nothing is going to
 * finish it, so it is a failure and should say so rather than sitting there
 * looking busy forever. Any `.coral-partial` files under an enabled root are
 * from the same interrupted work and are swept.
 *
 * This is the difference between something you can hand a media library to
 * and something you cannot.
 */
let recovered = false;

/**
 * Run recovery once per process, on the first thing that touches the queue.
 *
 * The alternative is a startup hook in `server.mjs`, which cannot see the
 * app's modules without opening a second handle on the same SQLite file.
 * First-use is close enough to boot and impossible to forget.
 */
export function ensureBootRecovery(): void {
	if (recovered) return;
	recovered = true;
	recoverJobsAtBoot();
}

export function recoverJobsAtBoot(): { failed: number; sweptPartials: string[] } {
	const stranded = database()
		.prepare("SELECT id FROM scan_jobs WHERE status = 'running'")
		.all() as unknown as { id: string }[];

	for (const row of stranded) {
		finish(row.id, "failed", { error: "Interrupted by a restart." });
	}

	return { failed: stranded.length, sweptPartials: sweepPartials() };
}

function sweepPartials(): string[] {
	const swept: string[] = [];

	for (const root of listRoots()) {
		if (!root.enabled) continue;
		collectPartials(root.path, swept);
	}

	for (const partial of swept) {
		try {
			fs.unlinkSync(partial);
		} catch {
			// Gone already, or not ours to remove.
		}
	}

	return swept;
}

function collectPartials(directory: string, into: string[]) {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const absolute = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			collectPartials(absolute, into);
			continue;
		}
		if (entry.name.endsWith(PARTIAL_SUFFIX)) into.push(absolute);
	}
}
