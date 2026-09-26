import { createFileRoute } from "@tanstack/react-router";

/**
 * Ask Jellyfin to rescan. Jellyfin's refresh is fire-and-forget, so a 202 and
 * "requested" is the honest answer — nothing here knows when it finished.
 */
export const Route = createFileRoute("/api/coral/library/refresh")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const { requireServiceAuth } = await import("#/server/service-auth");
				const { denied } = await requireServiceAuth(request, "full");
				if (denied) return denied;

				const { runFullLibraryScanJob } = await import("#/lib/scan-jobs");
				const { id } = await runFullLibraryScanJob();

				return Response.json({ requested: true, jobId: id }, { status: 202 });
			},
		},
	},
});
