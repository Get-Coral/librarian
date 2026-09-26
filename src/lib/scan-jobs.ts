import { triggerLibraryRefresh } from "./jellyfin";
import { enqueueJob, type Job, registerJobHandler } from "./jobs";

export const REFRESH_ALL_JOB_KIND = "refresh-all";

registerJobHandler(REFRESH_ALL_JOB_KIND, async (context) => {
	context.report({ details: "Submitting a Jellyfin library refresh request." });
	await triggerLibraryRefresh();
	// Jellyfin's refresh is fire-and-forget, so this is a request, not a result.
	context.report({ details: "Jellyfin accepted the library refresh request." });
});

export async function runFullLibraryScanJob(): Promise<{ id: Job["id"] }> {
	const job = enqueueJob({
		kind: REFRESH_ALL_JOB_KIND,
		label: "Refresh all Jellyfin libraries",
		details: "Queued from the Librarian dashboard.",
	});

	return { id: job.id };
}
