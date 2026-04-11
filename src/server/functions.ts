import { createServerFn } from "@tanstack/react-start"

export const fetchSetupStatus = createServerFn({ method: "GET" }).handler(async () => {
	const { getConfigurationSummary } = await import("../lib/config-store")
	return getConfigurationSummary()
})

export const saveSetupConfiguration = createServerFn({ method: "POST" })
	.inputValidator(
		(input: {
			url: string
			apiKey: string
			userId: string
			username?: string
			password?: string
		}) => input,
	)
	.handler(async ({ data }) => {
		const { saveJellyfinSettings, validateJellyfinSettings } = await import(
			"../lib/config-store"
		)
		const validated = await validateJellyfinSettings({
			url: data.url,
			apiKey: data.apiKey,
			userId: data.userId,
			username: data.username,
			password: data.password,
		})

		saveJellyfinSettings(validated)

		return { configured: true }
	})

export const fetchDashboard = createServerFn({ method: "GET" }).handler(async () => {
	const { fetchDashboardData } = await import("../lib/jellyfin")
	return fetchDashboardData()
})

export const refreshLibraries = createServerFn({ method: "POST" }).handler(async () => {
	const { runFullLibraryScanJob } = await import("../lib/scan-jobs")
	await runFullLibraryScanJob()
	return { ok: true }
})

export const fetchReviewItemDetail = createServerFn({ method: "GET" })
	.inputValidator((input: { itemId: string }) => input)
	.handler(async ({ data }) => {
		const { fetchReviewItemDetail: fetchDetail } = await import("../lib/jellyfin")
		return fetchDetail(data.itemId)
	})

export const refreshReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string }) => input)
	.handler(async ({ data }) => {
		const { refreshReviewItem: refreshItem } = await import("../lib/jellyfin")
		await refreshItem(data.itemId)
		return { ok: true }
	})

export const renameReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string; name: string }) => input)
	.handler(async ({ data }) => {
		const { renameReviewItem: renameItem } = await import("../lib/jellyfin")
		await renameItem(data.itemId, data.name)
		return { ok: true }
	})

export const dismissReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string; note?: string }) => input)
	.handler(async ({ data }) => {
		const { dismissReviewItem: dismissItem } = await import("../lib/config-store")
		dismissItem(data.itemId, data.note)
		return { ok: true }
	})

export const restoreReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string }) => input)
	.handler(async ({ data }) => {
		const { restoreReviewItem: restoreItem } = await import("../lib/config-store")
		restoreItem(data.itemId)
		return { ok: true }
	})
