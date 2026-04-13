import {
	createClient,
	getActiveSessions,
	getItem,
	getItemCounts,
	getLibraryItems,
	getMetadataGapKeys,
	getMetadataGapReasons,
	getSystemInfo,
	getUserById,
	getUsers,
	getVirtualFolders,
	type JellyfinActiveSession,
	type JellyfinItem,
	type JellyfinItemCounts,
	type JellyfinItemUpdate,
	type JellyfinSystemInfo,
	type JellyfinVirtualFolder,
	type MetadataGapKey,
	metadataGapReasonForKey,
	scanAllLibraries,
	scanLibrary,
	updateItem,
	updateItemName,
} from "@get-coral/jellyfin";
import {
	getEffectiveJellyfinSettings,
	listDismissedReviewItems,
	listScanJobs,
	type ScanJobRecord,
} from "./config-store";

export interface LibrarianUserSummary {
	id: string;
	name: string;
	hasPassword: boolean;
	lastLoginDate?: string;
	lastActivityDate?: string;
	isAdministrator: boolean;
	isDisabled: boolean;
}

export interface LibrarianDashboardData {
	systemInfo: JellyfinSystemInfo;
	itemCounts: JellyfinItemCounts;
	virtualFolders: JellyfinVirtualFolder[];
	activeSessions: JellyfinActiveSession[];
	users: LibrarianUserSummary[];
	currentUser: LibrarianUserSummary;
	health: LibrarianHealthMetric[];
	reviewQueue: LibrarianReviewItem[];
	scanJobs: ScanJobRecord[];
}

export interface LibrarianHealthMetric {
	id: string;
	label: string;
	count: number;
	description: string;
	tone: "coral" | "teal" | "gold";
}

export interface LibrarianReviewItem {
	id: string;
	title: string;
	type: string;
	library: string;
	year?: number;
	reasons: string[];
}

export interface LibrarianReviewDetail {
	id: string;
	title: string;
	type: string;
	overview: string;
	year?: number;
	genres: string[];
	studios: string[];
	people: Array<{
		id: string;
		name: string;
		role?: string;
		type?: string;
	}>;
	reasons: string[];
}

export interface LibrarianReviewUpdateInput {
	overview: string;
	year?: number;
	genres: string[];
}

function getRequiredSettings() {
	const settings = getEffectiveJellyfinSettings();

	if (!settings) {
		throw new Error("Librarian is not configured yet. Visit /setup to connect Jellyfin.");
	}

	return settings;
}

function createLibrarianClient() {
	const settings = getRequiredSettings();

	return createClient({
		url: settings.url,
		apiKey: settings.apiKey,
		userId: settings.userId,
		username: settings.username,
		password: settings.password,
		clientName: "Librarian",
		deviceName: "Librarian Web",
		deviceId: "librarian-web",
	});
}

const METADATA_GAP_HEALTH_CONFIG: Record<MetadataGapKey, Omit<LibrarianHealthMetric, "count">> = {
	overview: {
		id: "overview",
		label: "Missing overviews",
		description: "Items in the sampled libraries without a summary.",
		tone: "coral",
	},
	artwork: {
		id: "artwork",
		label: "Artwork gaps",
		description: "Titles missing a primary image in Jellyfin.",
		tone: "gold",
	},
	year: {
		id: "year",
		label: "Missing years",
		description: "Titles without a production year.",
		tone: "teal",
	},
	genres: {
		id: "genres",
		label: "Genre gaps",
		description: "Items missing genre tags.",
		tone: "coral",
	},
};

type SampleLibrary = {
	name: string;
	items: JellyfinItem[];
};

function createEmptyGapCounts(): Record<MetadataGapKey, number> {
	return {
		overview: 0,
		artwork: 0,
		year: 0,
		genres: 0,
	};
}

function collectReviewQueue(
	sampleLibraries: SampleLibrary[],
	dismissedIds: Set<string>,
	maxReviewItems = 18,
): {
	reviewQueue: LibrarianReviewItem[];
	gapCounts: Record<MetadataGapKey, number>;
} {
	const reviewQueue: LibrarianReviewItem[] = [];
	const gapCounts = createEmptyGapCounts();

	for (const library of sampleLibraries) {
		for (const item of library.items) {
			const gapKeys = getMetadataGapKeys(item);

			if (gapKeys.length === 0) {
				continue;
			}

			for (const key of gapKeys) {
				gapCounts[key] += 1;
			}

			if (reviewQueue.length >= maxReviewItems || dismissedIds.has(item.Id)) {
				continue;
			}

			reviewQueue.push({
				id: item.Id,
				title: item.Name,
				type: item.Type,
				library: library.name,
				year: item.ProductionYear,
				reasons: gapKeys.map((key) => metadataGapReasonForKey(key)),
			});
		}
	}

	return { reviewQueue, gapCounts };
}

function buildHealthMetrics(gapCounts: Record<MetadataGapKey, number>): LibrarianHealthMetric[] {
	const order: MetadataGapKey[] = ["overview", "artwork", "year", "genres"];

	return order.map((key) => {
		const config = METADATA_GAP_HEALTH_CONFIG[key];

		return {
			...config,
			count: gapCounts[key],
		};
	});
}

export async function fetchDashboardData(): Promise<LibrarianDashboardData> {
	const client = createLibrarianClient();
	const [
		systemInfo,
		itemCounts,
		virtualFolders,
		activeSessions,
		users,
		currentUser,
		movies,
		series,
		books,
	] = await Promise.all([
		getSystemInfo(client),
		getItemCounts(client),
		getVirtualFolders(client),
		getActiveSessions(client),
		getUsers(client),
		getUserById(client, client.config.userId),
		getLibraryItems(client, "Movie", {
			limit: 120,
			sortBy: "DateCreated",
			sortOrder: "Descending",
		}),
		getLibraryItems(client, "Series", {
			limit: 120,
			sortBy: "DateCreated",
			sortOrder: "Descending",
		}),
		getLibraryItems(client, "Book", {
			limit: 120,
			sortBy: "DateCreated",
			sortOrder: "Descending",
		}),
	]);

	const normalizeUser = (user: (typeof users)[number]): LibrarianUserSummary => ({
		id: user.Id,
		name: user.Name,
		hasPassword: user.HasPassword,
		lastLoginDate: user.LastLoginDate,
		lastActivityDate: user.LastActivityDate,
		isAdministrator: Boolean(user.Policy?.IsAdministrator),
		isDisabled: Boolean(user.Policy?.IsDisabled),
	});

	const sampleLibraries = [
		{ name: "Movies", items: movies.Items },
		{ name: "Shows", items: series.Items },
		{ name: "Books", items: books.Items },
	];

	const dismissedIds = new Set(listDismissedReviewItems().map((item) => item.itemId));
	const { reviewQueue, gapCounts } = collectReviewQueue(sampleLibraries, dismissedIds);
	const health = buildHealthMetrics(gapCounts);

	return {
		systemInfo,
		itemCounts,
		virtualFolders,
		activeSessions,
		users: users.map(normalizeUser),
		currentUser: normalizeUser(currentUser),
		health,
		reviewQueue,
		scanJobs: listScanJobs(),
	};
}

export async function triggerLibraryRefresh() {
	const client = createLibrarianClient();
	await scanAllLibraries(client);
}

export async function fetchReviewItemDetail(itemId: string): Promise<LibrarianReviewDetail> {
	const client = createLibrarianClient();
	const item = await getItem(client, itemId);
	const reasons = getMetadataGapReasons(item);

	return {
		id: item.Id,
		title: item.Name,
		type: item.Type,
		overview: item.Overview?.trim() ?? "",
		year: item.ProductionYear,
		genres: item.GenreItems?.map((genre) => genre.Name) ?? [],
		studios: item.Studios?.map((studio) => studio.Name) ?? [],
		people:
			item.People?.map((person) => ({
				id: person.Id,
				name: person.Name,
				role: person.Role,
				type: person.Type,
			})) ?? [],
		reasons,
	};
}

export async function refreshReviewItem(itemId: string) {
	const client = createLibrarianClient();
	await scanLibrary(client, itemId);
}

export async function renameReviewItem(itemId: string, name: string) {
	const client = createLibrarianClient();
	await updateItemName(client, itemId, name.trim());
}

export async function updateReviewItemMetadata(itemId: string, input: LibrarianReviewUpdateInput) {
	const client = createLibrarianClient();
	const patch: JellyfinItemUpdate = {
		overview: input.overview.trim(),
		productionYear: input.year ?? null,
		genres: input.genres,
	};

	await updateItem(client, itemId, patch);
}
