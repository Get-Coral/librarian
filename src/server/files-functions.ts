import { createServerFn } from "@tanstack/react-start";
import { filesystemAccessMiddleware } from "./auth-middleware";

/**
 * The filesystem surface, as server functions.
 *
 * Every one of these is behind `filesystemAccessMiddleware`, and none of them
 * accepts an absolute path: a location is always a root id plus a path
 * relative to it. That single rule removes an entire class of exploit before
 * any validation runs.
 *
 * The cross-module REST version of this lives in Workstream C, when there is
 * a second consumer to justify it.
 */

export interface BrowseEntry {
	name: string;
	/** Relative to the root. */
	path: string;
	kind: "directory" | "file";
	bytes: number;
	isVideo: boolean;
}

export const fetchFilesOverview = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.handler(async () => {
		const { listRoots, seedRootsFromEnvironment } = await import("#/lib/files/roots");
		const { ensureBootRecovery, listJobs } = await import("#/lib/jobs");
		ensureBootRecovery();

		// Cheap and idempotent: picks up a root added to compose since last boot.
		seedRootsFromEnvironment();

		return { roots: listRoots(), jobs: listJobs(10) };
	});

export const createFilesRoot = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { label: string; kind: "downloads" | "media"; path: string }) => input)
	.handler(async ({ data }) => {
		const { createRoot } = await import("#/lib/files/roots");
		return createRoot(data);
	});

export const updateFilesRoot = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator(
		(input: { id: string; enabled?: boolean; label?: string; kind?: "downloads" | "media" }) =>
			input,
	)
	.handler(async ({ data }) => {
		const { updateRoot } = await import("#/lib/files/roots");
		return updateRoot(data.id, data);
	});

export const deleteFilesRoot = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { id: string }) => input)
	.handler(async ({ data }) => {
		const { deleteRoot } = await import("#/lib/files/roots");
		deleteRoot(data.id);
		return { deleted: true };
	});

export const browseFilesRoot = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { rootId: string; path?: string }) => input)
	.handler(async ({ data }): Promise<{ path: string; entries: BrowseEntry[] }> => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const { requireEnabledRoot } = await import("#/lib/files/roots");
		const { realpathWithinRoot, resolveWithinRoot } = await import("#/lib/files/paths");
		const { isVideoFile } = await import("#/lib/files/release");

		const root = requireEnabledRoot(data.rootId);
		const relative = data.path ?? "";

		const absolute = relative
			? realpathWithinRoot(root.path, resolveWithinRoot(root.path, relative))
			: root.path;

		const entries = fs
			.readdirSync(absolute, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith("."))
			.map((entry) => {
				const entryPath = relative ? path.join(relative, entry.name) : entry.name;
				const directory = entry.isDirectory();

				return {
					name: entry.name,
					path: entryPath,
					kind: directory ? ("directory" as const) : ("file" as const),
					bytes: directory ? 0 : sizeOf(fs, path.join(absolute, entry.name)),
					isVideo: !directory && isVideoFile(entry.name),
				};
			})
			.sort((a, b) => {
				if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
				return a.name.localeCompare(b.name);
			});

		return { path: relative, entries };
	});

function sizeOf(fs: typeof import("node:fs"), target: string): number {
	try {
		return fs.statSync(target).size;
	} catch {
		return 0;
	}
}

export const previewImport = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator(
		(input: {
			sourceRootId: string;
			path: string;
			destinationRootId: string;
			overrides?: Record<string, Record<string, unknown>>;
			collision?: "fail" | "suffix" | "replace";
		}) => input,
	)
	.handler(async ({ data }) => {
		const { planImportFor } = await import("#/lib/import-service");
		return planImportFor(data as Parameters<typeof planImportFor>[0]);
	});

export const startImport = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator(
		(input: {
			sourceRootId: string;
			path: string;
			destinationRootId: string;
			overrides?: Record<string, Record<string, unknown>>;
			collision?: "fail" | "suffix" | "replace";
		}) => input,
	)
	.handler(async ({ data }) => {
		const { queueImport } = await import("#/lib/import-service");
		return queueImport(data as Parameters<typeof queueImport>[0]);
	});

export const fetchJobs = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.handler(async () => {
		const { ensureBootRecovery, listJobs } = await import("#/lib/jobs");
		ensureBootRecovery();
		return listJobs(10);
	});

export const cancelJob = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { id: string }) => input)
	.handler(async ({ data }) => {
		const { requestCancel } = await import("#/lib/jobs");
		requestCancel(data.id);
		return { cancelled: true };
	});

// ── Path mappings ────────────────────────────────────────────────────────────

export const fetchMappings = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.handler(async () => {
		const { listMappings } = await import("#/lib/files/mappings");
		const { fetchLibraryLocations, suggestMappingsFromJellyfin } = await import(
			"#/lib/mapping-service"
		);

		// Jellyfin may be unreachable; the stored mappings are still worth showing.
		const [libraries, suggestions] = await Promise.all([
			fetchLibraryLocations().catch(() => []),
			suggestMappingsFromJellyfin().catch(() => []),
		]);

		return { mappings: listMappings(), suggestions, libraries };
	});

export const createMappingFn = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { remotePrefix: string; localPrefix: string }) => input)
	.handler(async ({ data }) => {
		const { createMapping } = await import("#/lib/files/mappings");
		return createMapping(data);
	});

export const deleteMappingFn = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { id: string }) => input)
	.handler(async ({ data }) => {
		const { deleteMapping } = await import("#/lib/files/mappings");
		deleteMapping(data.id);
		return { deleted: true };
	});

export const verifyMappingsFn = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.handler(async () => {
		const { listMappings } = await import("#/lib/files/mappings");
		const { verifyMappings } = await import("#/lib/mapping-service");

		return { outcomes: await verifyMappings(), mappings: listMappings() };
	});
