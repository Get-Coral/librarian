import crypto from "node:crypto";
import { getJsonSetting, setJsonSetting } from "./config-store";

/**
 * Tokens that let another Coral module call this one.
 *
 * A token is a capability grant, not an impersonation: it carries no user
 * identity, and nothing downstream should ask it who it is. Scopes are in the
 * data model from the first commit even though the UI offers two choices,
 * because adding a field to a stored credential later means reasoning about
 * every token minted before it existed.
 *
 * Stored as JSON under `app_settings` rather than in a table — see
 * `getJsonSetting`.
 */

const STORAGE_KEY = "coral.serviceTokens";
const MODULE_ID = "librarian";

/** `read` can look; `full` can also act. */
export type TokenScope = "read" | "full";

export interface ServiceToken {
	id: string;
	label: string;
	scopes: TokenScope[];
	createdAt: string;
	lastUsedAt: string | null;
}

interface StoredToken extends ServiceToken {
	/** sha256 of the token. The token itself is shown once and never kept. */
	hash: string;
}

function load(): StoredToken[] {
	return getJsonSetting<StoredToken[]>(STORAGE_KEY, []);
}

function save(tokens: StoredToken[]): void {
	setJsonSetting(STORAGE_KEY, tokens);
}

function hash(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

function redact(token: StoredToken): ServiceToken {
	const { hash: _hash, ...rest } = token;
	return rest;
}

export function listServiceTokens(): ServiceToken[] {
	return load().map(redact);
}

/**
 * Mint a token. The secret is returned exactly once — it is not recoverable
 * afterwards, because only its hash is stored.
 */
export function mintServiceToken(input: { label: string; scopes: TokenScope[] }): {
	record: ServiceToken;
	token: string;
} {
	const token = `coral_${MODULE_ID}_${crypto.randomBytes(24).toString("hex")}`;

	const record: StoredToken = {
		id: crypto.randomUUID(),
		label: input.label.trim() || "Unnamed",
		scopes: input.scopes.length > 0 ? input.scopes : ["read"],
		createdAt: new Date().toISOString(),
		lastUsedAt: null,
		hash: hash(token),
	};

	save([...load(), record]);

	return { record: redact(record), token };
}

export function revokeServiceToken(id: string): void {
	save(load().filter((token) => token.id !== id));
}

/**
 * The token behind a presented secret, or null.
 *
 * Compared with `timingSafeEqual` over the hashes so that a wrong token takes
 * the same time to reject however much of it was right.
 */
export function verifyServiceToken(presented: string | null | undefined): ServiceToken | null {
	if (!presented) return null;

	const presentedHash = Buffer.from(hash(presented), "hex");
	const tokens = load();

	let matched: StoredToken | null = null;
	for (const token of tokens) {
		const candidate = Buffer.from(token.hash, "hex");
		if (
			candidate.length === presentedHash.length &&
			crypto.timingSafeEqual(candidate, presentedHash)
		) {
			matched = token;
		}
	}

	if (matched) {
		markUsed(matched.id, tokens);
		return redact(matched);
	}

	return environmentToken(presented);
}

/**
 * `CORAL_SERVICE_TOKEN` is an escape hatch for compose-only operators who
 * have no way to click a button. It grants full scope and is never stored.
 */
function environmentToken(presented: string): ServiceToken | null {
	const configured = process.env.CORAL_SERVICE_TOKEN?.trim();
	if (!configured) return null;

	const left = Buffer.from(hash(configured), "hex");
	const right = Buffer.from(hash(presented), "hex");
	if (!crypto.timingSafeEqual(left, right)) return null;

	return {
		id: "environment",
		label: "CORAL_SERVICE_TOKEN",
		scopes: ["full"],
		createdAt: new Date(0).toISOString(),
		lastUsedAt: null,
	};
}

function markUsed(id: string, tokens: StoredToken[]): void {
	save(
		tokens.map((token) =>
			token.id === id ? { ...token, lastUsedAt: new Date().toISOString() } : token,
		),
	);
}

/** The bearer token on a request, if it carries one. */
export function bearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;

	const [scheme, ...rest] = header.split(" ");
	if (scheme.toLowerCase() !== "bearer") return null;

	const value = rest.join(" ").trim();
	return value.length > 0 ? value : null;
}
