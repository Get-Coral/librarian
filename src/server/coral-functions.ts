import { createServerFn } from "@tanstack/react-start";
import { filesystemAccessMiddleware } from "./auth-middleware";

/**
 * Managing the tokens other Coral modules use to call this one.
 *
 * Behind the fail-closed guard rather than the ordinary admin one: a token
 * minted here is a credential that can be given file access, so an
 * unconfigured instance has no business issuing one.
 */

export const fetchServiceTokens = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.handler(async () => {
		const { listServiceTokens } = await import("#/lib/service-tokens");
		return {
			tokens: listServiceTokens(),
			environmentToken: Boolean(process.env.CORAL_SERVICE_TOKEN?.trim()),
		};
	});

export const mintServiceTokenFn = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { label: string; scope: "read" | "full" }) => input)
	.handler(async ({ data }) => {
		const { mintServiceToken } = await import("#/lib/service-tokens");
		// Returned once. There is no second chance to read it.
		return mintServiceToken({ label: data.label, scopes: [data.scope] });
	});

export const revokeServiceTokenFn = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { id: string }) => input)
	.handler(async ({ data }) => {
		const { revokeServiceToken } = await import("#/lib/service-tokens");
		revokeServiceToken(data.id);
		return { revoked: true };
	});

// ── Outbound: modules Librarian has been pointed at ──────────────────────────

export const fetchLinks = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.handler(async () => {
		const { listLinks } = await import("#/lib/coral-links");
		return listLinks();
	});

/** Read a manifest before committing to it, so the UI can show what it found. */
export const probeModule = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { url: string; token: string }) => input)
	.handler(async ({ data }) => {
		const { fetchManifest } = await import("#/lib/coral-client");
		return fetchManifest(data.url, data.token.trim() || null);
	});

export const addLink = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { url: string; token: string }) => input)
	.handler(async ({ data }) => {
		const { fetchManifest } = await import("#/lib/coral-client");
		const { saveLink } = await import("#/lib/coral-links");

		const token = data.token.trim();
		const manifest = await fetchManifest(data.url, token || null);

		if (manifest.capabilities.length === 0) {
			throw new Error(
				manifest.auth.required && !token
					? `${manifest.module.name} needs a token before it will offer anything.`
					: `${manifest.module.name} offers nothing Librarian can use.`,
			);
		}

		return saveLink({
			url: data.url,
			token,
			moduleId: manifest.module.id,
			moduleName: manifest.module.name,
			moduleVersion: manifest.module.version,
			capabilities: manifest.capabilities,
		});
	});

export const removeLink = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { id: string }) => input)
	.handler(async ({ data }) => {
		const { deleteLink } = await import("#/lib/coral-links");
		deleteLink(data.id);
		return { removed: true };
	});

export interface WaitingDownload {
	linkId: string;
	moduleName: string;
	downloadId: string;
	name: string;
	bytes: number;
	/** Relative to the producer's downloads root. */
	rootRelativePath: string;
}

/**
 * Finished downloads a linked module is holding that Librarian has not
 * imported yet.
 *
 * The diff against the ledger is the whole trick: the producer re-sends the
 * same completed torrent forever and has no idea what was done with it, so
 * asking repeatedly is harmless and nothing is ever imported twice by
 * accident.
 */
/** The finished, unimported downloads one link is holding. */
async function waitingFor(link: { id: string; moduleName: string }): Promise<WaitingDownload[]> {
	const { fetchDownloads } = await import("#/lib/coral-client");
	const { importedIds } = await import("#/lib/import-ledger");

	const downloads = await fetchDownloads(link.id);
	const already = importedIds(link.id);

	return downloads
		.filter(
			(download) =>
				// Not finished, already handled, or not yet moved into the
				// completed directory — nothing to import in any of those cases.
				download.done && !already.has(download.id) && download.rootRelativePath !== null,
		)
		.map((download) => ({
			linkId: link.id,
			moduleName: link.moduleName,
			downloadId: download.id,
			name: download.name,
			bytes: download.length,
			rootRelativePath: download.rootRelativePath as string,
		}));
}

/**
 * Finished downloads a linked module is holding that Librarian has not
 * imported yet.
 *
 * The diff against the ledger is the whole trick: the producer re-sends the
 * same completed torrent forever and has no idea what was done with it, so
 * asking repeatedly is harmless and nothing is imported twice by accident.
 */
export const fetchWaitingDownloads = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.handler(async (): Promise<{ waiting: WaitingDownload[]; errors: string[] }> => {
		const { listLinks, hasCapability } = await import("#/lib/coral-links");

		const waiting: WaitingDownload[] = [];
		const errors: string[] = [];

		for (const link of listLinks()) {
			if (!hasCapability(link, "downloads.list")) continue;

			try {
				waiting.push(...(await waitingFor(link)));
			} catch (error) {
				// One unreachable module must not hide the others.
				errors.push(
					`${link.moduleName}: ${error instanceof Error ? error.message : "unreachable"}`,
				);
			}
		}

		return { waiting, errors };
	});

/** Stop offering a download without importing it. */
export const dismissDownload = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { linkId: string; downloadId: string }) => input)
	.handler(async ({ data }) => {
		const { recordImported } = await import("#/lib/import-ledger");
		recordImported({ ...data, rootRelativePath: null, jobId: null });
		return { dismissed: true };
	});
