import { createServerFn } from "@tanstack/react-start";
import { filesystemAccessMiddleware } from "./auth-middleware";

/**
 * Managing the tokens other Coral modules use to call this one.
 *
 * Behind the fail-closed guard rather than the ordinary admin one: a token
 * minted here is a credential that can be given file access, so an
 * unconfigured instance has no business issuing one.
 */

export const fetchServiceTokens = createServerFn({ method: "GET" })
	.middleware([filesystemAccessMiddleware])
	.handler(async () => {
		const { listServiceTokens } = await import("#/lib/service-tokens");
		return {
			tokens: listServiceTokens(),
			environmentToken: Boolean(process.env.CORAL_SERVICE_TOKEN?.trim()),
		};
	});

export const mintServiceTokenFn = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { label: string; scope: "read" | "full" }) => input)
	.handler(async ({ data }) => {
		const { mintServiceToken } = await import("#/lib/service-tokens");
		// Returned once. There is no second chance to read it.
		return mintServiceToken({ label: data.label, scopes: [data.scope] });
	});

export const revokeServiceTokenFn = createServerFn({ method: "POST" })
	.middleware([filesystemAccessMiddleware])
	.inputValidator((input: { id: string }) => input)
	.handler(async ({ data }) => {
		const { revokeServiceToken } = await import("#/lib/service-tokens");
		revokeServiceToken(data.id);
		return { revoked: true };
	});
