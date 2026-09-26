import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";

/**
 * The same three gates as `auth-guards.ts`, in the shape server functions
 * take. The guards there answer a `Request` with a `Response`; these throw a
 * redirect, because their callers are pages rather than other modules.
 */

async function currentSession() {
	const { getSessionByToken, SESSION_COOKIE_NAME } = await import("#/lib/auth-store");
	const { getCookie } = await import("@tanstack/react-start/server");

	return getSessionByToken(getCookie(SESSION_COOKIE_NAME));
}

/** Read-only work: unchanged for an instance that does not enforce sign-in. */
export const authRequiredMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const { isLoginEnforced } = await import("#/lib/auth-store");

		if (isLoginEnforced() && !(await currentSession())) {
			throw redirect({ to: "/login" });
		}

		return next();
	},
);

/**
 * Changing the Jellyfin connection or Librarian's own settings always needs a
 * signed-in administrator — except on a fresh install, where there is no
 * Jellyfin to authenticate against and first-run setup has to get through.
 */
export const adminRequiredMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const { isLibrarianConfigured } = await import("#/lib/config-store");
		if (!isLibrarianConfigured()) return next();

		const session = await currentSession();
		if (!session) throw redirect({ to: "/login" });
		if (!session.isAdmin) throw redirect({ to: "/" });

		return next();
	},
);

/**
 * Anything that can move or delete a file. Fails closed, always — including
 * on an unconfigured install, which has no account to prove anything with.
 * See `requireFilesystemAccess` for why this has no permissive branch.
 */
export const filesystemAccessMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const { isLibrarianConfigured } = await import("#/lib/config-store");
		if (!isLibrarianConfigured()) throw redirect({ to: "/setup" });

		const session = await currentSession();
		if (!session) throw redirect({ to: "/login" });
		if (!session.isAdmin) throw redirect({ to: "/" });

		return next();
	},
);
