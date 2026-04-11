import { randomUUID } from "node:crypto";
import { createScanJob, updateScanJob } from "./config-store";
import { triggerLibraryRefresh } from "./jellyfin";

export async function runFullLibraryScanJob() {
	const id = randomUUID();

	createScanJob({
		id,
		kind: "refresh-all",
		label: "Refresh all Jellyfin libraries",
		status: "queued",
		details: "Queued from the Librarian dashboard.",
	});

	updateScanJob(id, {
		status: "running",
		details: "Submitting a Jellyfin library refresh request.",
	});

	try {
		await triggerLibraryRefresh();
		updateScanJob(id, {
			status: "completed",
			details: "Jellyfin accepted the library refresh request.",
			completed: true,
		});
		return { id };
	} catch (error) {
		updateScanJob(id, {
			status: "failed",
			details:
				error instanceof Error
					? error.message
					: "Library refresh failed unexpectedly.",
			completed: true,
		});
		throw error;
	}
}
