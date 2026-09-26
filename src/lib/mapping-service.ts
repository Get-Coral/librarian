import fs from "node:fs";
import { getItemPath, getVirtualFolders } from "@get-coral/jellyfin";
import { getEffectiveJellyfinSettings } from "./config-store";
import {
	listMappings,
	type MappingSuggestion,
	markMappingVerified,
	suggestMappings,
	toLocalPath,
} from "./files/mappings";

/**
 * Proving that a path mapping is right, rather than assuming it.
 *
 * A mapping that looks plausible and is wrong is worse than no mapping: it
 * sends an import into a directory nobody is watching. So a mapping is only
 * marked verified once a real file Jellyfin reported has been found through
 * it on Librarian's own filesystem.
 */

export interface LibraryLocation {
	libraryId: string;
	name: string;
	collectionType: string | null;
	locations: string[];
}

async function client() {
	const { createClient } = await import("@get-coral/jellyfin");
	const settings = getEffectiveJellyfinSettings();

	if (!settings) throw new Error("Librarian is not connected to Jellyfin yet.");

	return createClient({
		url: settings.url,
		apiKey: settings.apiKey,
		userId: settings.userId,
		clientName: "Librarian",
		deviceName: "Librarian Web",
		deviceId: "librarian-web",
	});
}

export async function fetchLibraryLocations(): Promise<LibraryLocation[]> {
	const folders = await getVirtualFolders(await client());

	return folders.map((folder) => ({
		libraryId: folder.ItemId,
		name: folder.Name,
		collectionType: folder.CollectionType ?? null,
		locations: folder.Locations ?? [],
	}));
}

/** Every Jellyfin library location, matched against the roots that are on. */
export async function suggestMappingsFromJellyfin(): Promise<MappingSuggestion[]> {
	const libraries = await fetchLibraryLocations();
	return suggestMappings(libraries.flatMap((library) => library.locations));
}

/**
 * The on-disk path of one item from a given library, as Jellyfin sees it.
 *
 * The id lookup goes through `client.fetch` because the client's
 * `getLibraryItems` is scoped by media type rather than by library, and two
 * movie libraries would otherwise verify each other's mapping. The path
 * itself comes from `getItemPath`.
 *
 * Jellyfin withholds `Path` from callers without permission to see server
 * paths, so an absent value means "cannot check", not "wrong".
 */
async function sampleItemPath(libraryId: string): Promise<string | null> {
	const jellyfin = await client();

	const response = await jellyfin.fetch<{ Items?: { Id?: string }[] }>(
		`/Users/${jellyfin.config.userId}/Items`,
		{
			ParentId: libraryId,
			Recursive: "true",
			IncludeItemTypes: "Movie,Episode",
			Limit: "1",
		},
	);

	const itemId = response.Items?.[0]?.Id;
	return itemId ? await getItemPath(jellyfin, itemId) : null;
}

export type VerificationOutcome =
	| { status: "verified"; checked: string }
	| { status: "unverified"; reason: string };

/**
 * Check every mapping by resolving a real file through it.
 *
 * Returns one outcome per mapping, keyed by id. A library Jellyfin reports no
 * items for, or withholds paths for, comes back unverified with the reason
 * rather than being quietly failed.
 */
export async function verifyMappings(): Promise<Record<string, VerificationOutcome>> {
	const mappings = listMappings();
	if (mappings.length === 0) return {};

	const libraries = await fetchLibraryLocations();
	const outcomes: Record<string, VerificationOutcome> = {};

	for (const mapping of mappings) {
		const library = libraries.find((candidate) =>
			candidate.locations.some((location) => location.startsWith(mapping.remotePrefix)),
		);

		if (!library) {
			outcomes[mapping.id] = {
				status: "unverified",
				reason: "No Jellyfin library uses this path.",
			};
			continue;
		}

		const remotePath = await sampleItemPath(library.libraryId).catch(() => null);
		if (!remotePath) {
			outcomes[mapping.id] = {
				status: "unverified",
				reason: `Jellyfin did not report a file path for "${library.name}".`,
			};
			continue;
		}

		const localPath = toLocalPath(remotePath);
		if (!fs.existsSync(localPath)) {
			outcomes[mapping.id] = {
				status: "unverified",
				reason: `Followed "${remotePath}" to "${localPath}", which is not there.`,
			};
			continue;
		}

		markMappingVerified(mapping.id);
		outcomes[mapping.id] = { status: "verified", checked: localPath };
	}

	return outcomes;
}
