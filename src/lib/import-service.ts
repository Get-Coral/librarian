import { type ImportPlan, planImport, type ReleaseOverrides, runImport } from "./files/import";
import type { CollisionStrategy } from "./files/paths";
import { requireEnabledRoot } from "./files/roots";
import { enqueueJob, type Job, registerJobHandler } from "./jobs";

/**
 * Where the headless import pipeline meets Librarian's roots and its job
 * queue. The pipeline itself knows nothing about either, which is what keeps
 * it testable without a database.
 */

export const IMPORT_JOB_KIND = "import";

export interface ImportJobPayload {
	sourceRootId: string;
	/** Relative to the source root. Absolute paths are not accepted anywhere. */
	path: string;
	destinationRootId: string;
	overrides?: Record<string, ReleaseOverrides>;
	collision?: CollisionStrategy;
	preserveSource?: boolean;
}

/**
 * Resolve the named roots and plan the import.
 *
 * Roots are looked up by id and must be enabled, so a caller names a
 * directory an operator turned on rather than handing over a path.
 */
export function planImportFor(payload: ImportJobPayload): ImportPlan {
	const source = requireEnabledRoot(payload.sourceRootId);
	const destination = requireEnabledRoot(payload.destinationRootId);

	if (!destination.writable) {
		throw new Error(`The "${destination.label}" root is not writable.`);
	}

	return planImport({
		sourceRoot: source.path,
		destinationRoot: destination.path,
		path: payload.path,
		overrides: payload.overrides,
		collision: payload.collision,
		preserveSource: payload.preserveSource,
	});
}

export function queueImport(payload: ImportJobPayload): Job {
	// Planned once here so an impossible import is refused at the door rather
	// than failing later in a job nobody is watching.
	const plan = planImportFor(payload);

	return enqueueJob({
		kind: IMPORT_JOB_KIND,
		label: describe(plan, payload),
		payload,
		totalBytes: plan.totalBytes,
		details: "Queued.",
	});
}

function describe(plan: ImportPlan, payload: ImportJobPayload): string {
	const first = plan.entries[0]?.release.title;
	if (plan.entries.length > 1) return `Import ${plan.entries.length} files from ${payload.path}`;
	return first ? `Import ${first}` : `Import ${payload.path}`;
}

registerJobHandler(IMPORT_JOB_KIND, async (context) => {
	const payload = context.payload as ImportJobPayload;

	// Re-planned rather than trusting the plan made when it was queued: the
	// disk may have moved on between the preview and the job's turn.
	const plan = planImportFor(payload);
	context.report({ totalBytes: plan.totalBytes, details: "Importing." });

	let done = 0;
	const result = runImport(plan, {
		checkpoint: () => context.checkpoint(),
		onFile: (outcome) => {
			done += outcome.item.bytes;
			context.report({ doneBytes: done, details: `Imported ${outcome.to}` });
		},
	});

	const { triggerLibraryRefresh } = await import("./jellyfin");
	// Jellyfin's refresh is fire-and-forget, so the job says it asked, not
	// that anything has been scanned.
	const scanned = await triggerLibraryRefresh().then(
		() => true,
		() => false,
	);

	const skipped = result.warnings.length;
	context.report({
		details: [
			`Imported ${result.imported.length} file${result.imported.length === 1 ? "" : "s"}`,
			skipped > 0 ? `, ${skipped} skipped` : "",
			scanned ? ". Jellyfin scan requested." : ". Jellyfin did not accept a scan request.",
		].join(""),
	});
});
