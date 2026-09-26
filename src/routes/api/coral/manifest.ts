import { createFileRoute } from "@tanstack/react-router";

/**
 * What this module is and what it can do for you.
 *
 * A caller with no credentials gets 200 and a reduced manifest: the module's
 * identity and what it wants from them, with no capabilities. The flow this
 * exists for is "paste a URL, see what this is, paste a token", and a bare
 * 401 would turn the first step into guesswork.
 *
 * A caller whose credentials do not work gets 401, because that is a
 * different situation and the second step of the same flow depends on being
 * able to tell them apart.
 *
 * Compatibility rules, which matter more than the contents:
 *
 * - `spec` is a single integer for the envelope.
 * - Each capability carries its own integer version, so one can move without
 *   the others.
 * - `path` is declared here, never derived by the caller from the name.
 * - Parsers must be lenient and additive-only: ignore unknown fields rather
 *   than throwing, so an old Librarian keeps working against a new Tide.
 */

const SPEC = 1;

interface Capability {
	name: string;
	version: number;
	path: string;
}

export const Route = createFileRoute("/api/coral/manifest")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const { bearerToken } = await import("#/lib/service-tokens");
				const { requireServiceAuth } = await import("#/server/service-auth");

				const base = {
					spec: SPEC,
					module: { id: "librarian", name: "Librarian", version: "1.0.0" },
					auth: { required: true, schemes: ["bearer"] },
				};

				// No credentials at all is the discovery case, and gets the reduced
				// manifest. Credentials that do not work is a different thing, and
				// saying 200 to it would leave someone who pasted a bad token unable
				// to tell that from a module with nothing to offer.
				if (bearerToken(request) === null) {
					return Response.json({ ...base, capabilities: [], roots: [] });
				}

				const { denied } = await requireServiceAuth(request);
				if (denied) return denied;

				const { listRoots } = await import("#/lib/files/roots");
				const roots = listRoots().filter((root) => root.enabled);

				return Response.json({
					...base,
					capabilities: await capabilities(),
					// Paths are Librarian's, in Librarian's namespace. A caller that
					// wants to name a location uses the id.
					roots: roots.map((root) => ({
						id: root.id,
						label: root.label,
						kind: root.kind,
						writable: root.writable,
					})),
				});
			},
		},
	},
});

/**
 * Derived from what actually works right now, not from a static list.
 *
 * A capability advertised while its endpoint is missing, or while no root is
 * enabled to act on, is worse than an absent one — the caller has no way to
 * find out except by failing.
 */
async function capabilities(): Promise<Capability[]> {
	const { isLibrarianConfigured } = await import("#/lib/config-store");

	const available: Capability[] = [];

	if (isLibrarianConfigured()) {
		available.push({ name: "library.refresh", version: 1, path: "/api/coral/library/refresh" });
	}

	return available;
}
