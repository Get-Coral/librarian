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
