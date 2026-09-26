import type { AuthSession } from "#/lib/auth-store";

/**
 * Request-level guards for plain route handlers — the shape the cross-module
 * API in `src/routes/api/` uses, since server functions are not callable from
 * another module.
 *
 * Two of these are permissive: they allow everything when sign-in is not
 * enforced, which is how Tide and Aurora behave and what keeps an
 * unconfigured Librarian usable. `requireFilesystemAccess` is not one of
 * them, and is deliberately a separate function rather than a flag on the
 * others, so that reaching for the wrong guard is a thing you have to do on
 * purpose.
 */

export interface GuardResult {
	denied: Response | null;
	session: AuthSession | null;
}

/**
 * The permissive path. Only the read-only guards call this, and
 * `requireFilesystemAccess` must never be changed to.
 */
async function resolvePermissive(request: Request) {
	const { isLoginEnforced, getSessionFromRequest } = await import("#/lib/auth-store");

	if (!isLoginEnforced()) {
		return { enforced: false, session: null } as const;
	}

	return { enforced: true, session: getSessionFromRequest(request) } as const;
}

/** Read-only endpoints: unchanged behaviour for an instance with login off. */
export async function requireSession(request: Request): Promise<GuardResult> {
	const { enforced, session } = await resolvePermissive(request);

	if (!enforced) return { denied: null, session: null };
	if (!session) return { denied: unauthorized(), session: null };
	return { denied: null, session };
}

export async function requireAdmin(request: Request): Promise<GuardResult> {
	const { enforced, session } = await resolvePermissive(request);

	if (!enforced) return { denied: null, session: null };
	if (!session) return { denied: unauthorized(), session: null };
	if (!session.isAdmin) return { denied: forbidden(), session };
	return { denied: null, session };
}

/**
 * Anything that can move or delete a file. Fails closed, always.
 *
 * There is no "sign-in is off, so let it through" branch here and there must
 * never be one. Tide and Aurora can afford that branch because the worst an
 * open instance does is show someone a library they could already stream;
 * an open Librarian would let an unauthenticated request rearrange the disk.
 *
 * An unconfigured Librarian is refused too. That is not a deadlock — setup
 * does not need filesystem access, and until Jellyfin is connected there is
 * no account to prove anything with.
 */
export async function requireFilesystemAccess(request: Request): Promise<GuardResult> {
	const { getSessionFromRequest } = await import("#/lib/auth-store");
	const { isLibrarianConfigured } = await import("#/lib/config-store");

	if (!isLibrarianConfigured()) {
		return { denied: unconfigured(), session: null };
	}

	const session = getSessionFromRequest(request);
	if (!session) return { denied: unauthorized(), session: null };
	if (!session.isAdmin) return { denied: forbidden(), session };

	return { denied: null, session };
}

function unauthorized() {
	return new Response("Sign in to use Librarian.", { status: 401 });
}

function forbidden() {
	return new Response("This action is limited to Jellyfin administrators.", { status: 403 });
}

function unconfigured() {
	return new Response("Connect Librarian to Jellyfin first.", { status: 403 });
}
