import {
	createClient,
	getActiveSessions,
	getItem,
	getLibraryItems,
	getItemCounts,
	getSystemInfo,
	getUserById,
	getUsers,
	getVirtualFolders,
	scanAllLibraries,
	scanLibrary,
	updateItemName,
	type JellyfinActiveSession,
	type JellyfinItemCounts,
	type JellyfinSystemInfo,
	type JellyfinVirtualFolder,
} from "@get-coral/jellyfin"
import {
	getEffectiveJellyfinSettings,
	listDismissedReviewItems,
	listScanJobs,
	type ScanJobRecord,
} from "./config-store"

export interface LibrarianUserSummary {
	id: string
	name: string
	hasPassword: boolean
	lastLoginDate?: string
	lastActivityDate?: string
	isAdministrator: boolean
	isDisabled: boolean
}

export interface LibrarianDashboardData {
	systemInfo: JellyfinSystemInfo
	itemCounts: JellyfinItemCounts
	virtualFolders: JellyfinVirtualFolder[]
	activeSessions: JellyfinActiveSession[]
	users: LibrarianUserSummary[]
	currentUser: LibrarianUserSummary
	health: LibrarianHealthMetric[]
	reviewQueue: LibrarianReviewItem[]
	scanJobs: ScanJobRecord[]
}

export interface LibrarianHealthMetric {
	id: string
	label: string
	count: number
	description: string
	tone: "coral" | "teal" | "gold"
}

export interface LibrarianReviewItem {
	id: string
	title: string
	type: string
	library: string
	year?: number
	reasons: string[]
}

export interface LibrarianReviewDetail {
	id: string
	title: string
	type: string
	overview: string
	year?: number
	genres: string[]
	studios: string[]
	people: Array<{
		id: string
		name: string
		role?: string
		type?: string
	}>
	reasons: string[]
}

function getRequiredSettings() {
	const settings = getEffectiveJellyfinSettings()

	if (!settings) {
		throw new Error("Librarian is not configured yet. Visit /setup to connect Jellyfin.")
	}

	return settings
}

function createLibrarianClient() {
	const settings = getRequiredSettings()

	return createClient({
		url: settings.url,
		apiKey: settings.apiKey,
		userId: settings.userId,
		username: settings.username,
		password: settings.password,
		clientName: "Librarian",
		deviceName: "Librarian Web",
		deviceId: "librarian-web",
	})
}

export async function fetchDashboardData(): Promise<LibrarianDashboardData> {
	const client = createLibrarianClient()
	const [systemInfo, itemCounts, virtualFolders, activeSessions, users, currentUser, movies, series, books] =
		await Promise.all([
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
		])

	const normalizeUser = (user: (typeof users)[number]): LibrarianUserSummary => ({
		id: user.Id,
		name: user.Name,
		hasPassword: user.HasPassword,
		lastLoginDate: user.LastLoginDate,
		lastActivityDate: user.LastActivityDate,
		isAdministrator: Boolean(user.Policy?.IsAdministrator),
		isDisabled: Boolean(user.Policy?.IsDisabled),
	})

	const sampleLibraries = [
		{ name: "Movies", items: movies.Items },
		{ name: "Shows", items: series.Items },
		{ name: "Books", items: books.Items },
	]

	const reviewQueue: LibrarianReviewItem[] = []
	const dismissedIds = new Set(listDismissedReviewItems().map((item) => item.itemId))
	let missingOverviewCount = 0
	let missingArtworkCount = 0
	let missingYearCount = 0
	let genreGapCount = 0

	for (const library of sampleLibraries) {
		for (const item of library.items) {
			const reasons: string[] = []

			if (!item.Overview?.trim()) {
				reasons.push("Missing overview")
				missingOverviewCount += 1
			}

			if (!item.ImageTags?.Primary) {
				reasons.push("Missing primary artwork")
				missingArtworkCount += 1
			}

			if (!item.ProductionYear) {
				reasons.push("Missing release year")
				missingYearCount += 1
			}

			if (!item.GenreItems?.length) {
				reasons.push("Missing genres")
				genreGapCount += 1
			}

			if (reasons.length > 0 && reviewQueue.length < 18 && !dismissedIds.has(item.Id)) {
				reviewQueue.push({
					id: item.Id,
					title: item.Name,
					type: item.Type,
					library: library.name,
					year: item.ProductionYear,
					reasons,
				})
			}
		}
	}

	const health: LibrarianHealthMetric[] = [
		{
			id: "overview",
			label: "Missing overviews",
			count: missingOverviewCount,
			description: "Items in the sampled libraries without a summary.",
			tone: "coral",
		},
		{
			id: "artwork",
			label: "Artwork gaps",
			count: missingArtworkCount,
			description: "Titles missing a primary image in Jellyfin.",
			tone: "gold",
		},
		{
			id: "year",
			label: "Missing years",
			count: missingYearCount,
			description: "Titles without a production year.",
			tone: "teal",
		},
		{
			id: "genres",
			label: "Genre gaps",
			count: genreGapCount,
			description: "Items missing genre tags.",
			tone: "coral",
		},
	]

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
	}
}

export async function triggerLibraryRefresh() {
	const client = createLibrarianClient()
	await scanAllLibraries(client)
}

export async function fetchReviewItemDetail(itemId: string): Promise<LibrarianReviewDetail> {
	const client = createLibrarianClient()
	const item = await getItem(client, itemId)
	const reasons: string[] = []

	if (!item.Overview?.trim()) reasons.push("Missing overview")
	if (!item.ImageTags?.Primary) reasons.push("Missing primary artwork")
	if (!item.ProductionYear) reasons.push("Missing release year")
	if (!item.GenreItems?.length) reasons.push("Missing genres")

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
	}
}

export async function refreshReviewItem(itemId: string) {
	const client = createLibrarianClient()
	await scanLibrary(client, itemId)
}

export async function renameReviewItem(itemId: string, name: string) {
	const client = createLibrarianClient()
	await updateItemName(client, itemId, name.trim())
}
