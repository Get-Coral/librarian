/**
 * Cookie plumbing for the sign-in flow. Deliberately free of `node:sqlite` and
 * of `@get-coral/jellyfin`, so it can be imported and unit tested without
 * touching the database or the network.
 */

export const SESSION_COOKIE_NAME = "librarian_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function getSessionTokenFromCookieHeader(cookieHeader: string | null | undefined) {
	if (!cookieHeader) return null;

	for (const part of cookieHeader.split(";")) {
		const separatorIndex = part.indexOf("=");
		if (separatorIndex === -1) continue;
		if (part.slice(0, separatorIndex).trim() !== SESSION_COOKIE_NAME) continue;
		const value = part.slice(separatorIndex + 1).trim();
		if (value) return decodeURIComponent(value);
	}

	return null;
}

/**
 * Librarian is usually reverse-proxied with TLS terminated upstream, so
 * `Secure` follows `x-forwarded-proto` rather than the scheme the app itself
 * sees. Setting it unconditionally would silently drop the cookie on the
 * plain-HTTP LAN installs that are the common self-hosted case.
 */
export function isSecureRequest(request: Request) {
	const forwarded = request.headers.get("x-forwarded-proto");
	if (forwarded) {
		return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
	}

	try {
		return new URL(request.url).protocol === "https:";
	} catch {
		return false;
	}
}

export function buildSessionCookie(token: string, options: { secure: boolean }) {
	return buildCookie(encodeURIComponent(token), SESSION_MAX_AGE_SECONDS, options.secure);
}

export function buildClearedSessionCookie(options: { secure: boolean }) {
	return buildCookie("", 0, options.secure);
}

function buildCookie(value: string, maxAgeSeconds: number, secure: boolean) {
	const parts = [
		`${SESSION_COOKIE_NAME}=${value}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${maxAgeSeconds}`,
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}
