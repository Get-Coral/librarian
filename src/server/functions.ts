import { createServerFn } from "@tanstack/react-start";
import { adminRequiredMiddleware } from "./auth-middleware";

export const fetchSetupStatus = createServerFn({ method: "GET" }).handler(async () => {
	const { getConfigurationSummary } = await import("../lib/config-store");
	return getConfigurationSummary();
});

export const saveSetupConfiguration = createServerFn({ method: "POST" })
	.middleware([adminRequiredMiddleware])
	.inputValidator(
		(input: {
			url: string;
			apiKey: string;
			userId: string;
			username?: string;
			password?: string;
		}) => input,
	)
	.handler(async ({ data }) => {
		const { saveJellyfinSettings, validateJellyfinSettings, withStoredSecrets } = await import(
			"../lib/config-store"
		);
		const validated = await validateJellyfinSettings(
			withStoredSecrets({
				url: data.url,
				apiKey: data.apiKey,
				userId: data.userId,
				username: data.username,
				password: data.password,
			}),
		);

		saveJellyfinSettings(validated);

		return { configured: true };
	});

export const fetchDashboard = createServerFn({ method: "GET" }).handler(async () => {
	const { fetchDashboardData } = await import("../lib/jellyfin");
	return fetchDashboardData();
});

export const refreshLibraries = createServerFn({ method: "POST" }).handler(async () => {
	const { runFullLibraryScanJob } = await import("../lib/scan-jobs");
	await runFullLibraryScanJob();
	return { ok: true };
});

export const fetchReviewItemDetail = createServerFn({ method: "GET" })
	.inputValidator((input: { itemId: string }) => input)
	.handler(async ({ data }) => {
		const { fetchReviewItemDetail: fetchDetail } = await import("../lib/jellyfin");
		return fetchDetail(data.itemId);
	});

export const refreshReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string }) => input)
	.handler(async ({ data }) => {
		const { refreshReviewItem: refreshItem } = await import("../lib/jellyfin");
		await refreshItem(data.itemId);
		return { ok: true };
	});

export const renameReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string; name: string }) => input)
	.handler(async ({ data }) => {
		const { renameReviewItem: renameItem } = await import("../lib/jellyfin");
		await renameItem(data.itemId, data.name);
		return { ok: true };
	});

export const updateReviewItemMetadata = createServerFn({ method: "POST" })
	.inputValidator(
		(input: { itemId: string; overview: string; year?: number; genres: string[] }) => input,
	)
	.handler(async ({ data }) => {
		const { updateReviewItemMetadata: updateMetadata } = await import("../lib/jellyfin");
		await updateMetadata(data.itemId, {
			overview: data.overview,
			year: data.year,
			genres: data.genres,
		});
		return { ok: true };
	});

export const dismissReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string; note?: string }) => input)
	.handler(async ({ data }) => {
		const { dismissReviewItem: dismissItem } = await import("../lib/config-store");
		dismissItem(data.itemId, data.note);
		return { ok: true };
	});

export const restoreReviewItem = createServerFn({ method: "POST" })
	.inputValidator((input: { itemId: string }) => input)
	.handler(async ({ data }) => {
		const { restoreReviewItem: restoreItem } = await import("../lib/config-store");
		restoreItem(data.itemId);
		return { ok: true };
	});

// ── Sign in ──────────────────────────────────────────────────────────────────

const SESSION_COOKIE_OPTIONS = {
	httpOnly: true,
	sameSite: "lax",
	path: "/",
} as const;

export const fetchAuthStatus = createServerFn({ method: "GET" }).handler(async () => {
	const { isLoginEnforced, getSessionByToken, SESSION_COOKIE_NAME } = await import(
		"../lib/auth-store"
	);
	const { getRequireLogin, isRequireLoginLocked, isLibrarianConfigured } = await import(
		"../lib/config-store"
	);
	const { getCookie } = await import("@tanstack/react-start/server");

	const required = isLoginEnforced();
	const session = getSessionByToken(getCookie(SESSION_COOKIE_NAME));

	return {
		configured: isLibrarianConfigured(),
		requireLogin: getRequireLogin(),
		locked: isRequireLoginLocked(),
		required,
		authenticated: !required || session !== null,
		userId: session?.userId ?? null,
		username: session?.username ?? null,
		isAdmin: session?.isAdmin ?? false,
	};
});

export const signIn = createServerFn({ method: "POST" })
	.inputValidator((input: { username: string; password: string }) => input)
	.handler(async ({ data }) => {
		const {
			assertLoginAllowed,
			authenticateJellyfinCredentials,
			clearLoginFailures,
			createAuthSession,
			recordLoginFailure,
			sweepExpiredSessions,
			SESSION_COOKIE_NAME,
			SESSION_MAX_AGE_SECONDS,
		} = await import("../lib/auth-store");
		const { getRequestIP, getRequestProtocol, setCookie } = await import(
			"@tanstack/react-start/server"
		);

		const username = data.username.trim();
		if (!username) throw new Error("Username is required.");

		const ip = getRequestIP({ xForwardedFor: true }) ?? null;
		assertLoginAllowed(ip);

		let session: Awaited<ReturnType<typeof authenticateJellyfinCredentials>>;
		try {
			session = await authenticateJellyfinCredentials(username, data.password);
		} catch (error) {
			recordLoginFailure(ip);
			throw error;
		}
		clearLoginFailures(ip);
		sweepExpiredSessions();

		setCookie(SESSION_COOKIE_NAME, createAuthSession(session), {
			...SESSION_COOKIE_OPTIONS,
			maxAge: SESSION_MAX_AGE_SECONDS,
			secure: getRequestProtocol({ xForwardedProto: true }) === "https",
		});

		return { username: session.username, isAdmin: session.isAdmin };
	});

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
	const { destroySessionByToken, SESSION_COOKIE_NAME } = await import("../lib/auth-store");
	const { getCookie, getRequestProtocol, setCookie } = await import("@tanstack/react-start/server");

	await destroySessionByToken(getCookie(SESSION_COOKIE_NAME));

	setCookie(SESSION_COOKIE_NAME, "", {
		...SESSION_COOKIE_OPTIONS,
		maxAge: 0,
		secure: getRequestProtocol({ xForwardedProto: true }) === "https",
	});

	return { signedOut: true };
});
