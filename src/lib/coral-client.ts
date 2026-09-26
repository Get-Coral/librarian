import {
	type CoralCapability,
	type CoralLink,
	capabilityPath,
	getLinkWithToken,
	markLinkSeen,
	normalizeUrl,
} from "./coral-links";

/**
 * Calling another Coral module.
 *
 * Every parser here is lenient and additive-only: unknown fields are ignored
 * rather than thrown on, so an old Librarian keeps working against a newer
 * module. A field we do not recognise is not an error, it is a field from a
 * version we have not been taught about.
 */

export interface RemoteManifest {
	spec: number;
	module: { id: string; name: string; version: string };
	auth: { required: boolean; schemes: string[] };
	capabilities: CoralCapability[];
}

/** The most recent spec this build understands. */
const SUPPORTED_SPEC = 1;

export class CoralError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoralError";
	}
}

async function request(url: string, token: string | null, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);

	let response: Response;
	try {
		response = await fetch(url, { ...init, headers });
	} catch {
		throw new CoralError(`Could not reach ${url}.`);
	}

	if (response.status === 401 || response.status === 403) {
		throw new CoralError("That module refused the token.");
	}
	if (!response.ok) {
		throw new CoralError(`${url} answered ${response.status}.`);
	}

	return response;
}

/** Read a string from an unknown value, or a fallback. */
function text(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseCapabilities(value: unknown): CoralCapability[] {
	if (!Array.isArray(value)) return [];

	const capabilities: CoralCapability[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;

		// A capability without a declared path is unusable, and a version we
		// cannot read is not one we should claim to support.
		if (typeof record.name !== "string" || typeof record.path !== "string") continue;
		if (typeof record.version !== "number") continue;

		capabilities.push({ name: record.name, version: record.version, path: record.path });
	}

	return capabilities;
}

export function parseManifest(payload: unknown): RemoteManifest {
	if (typeof payload !== "object" || payload === null) {
		throw new CoralError("That did not look like a Coral module.");
	}

	const record = payload as Record<string, unknown>;
	const spec = typeof record.spec === "number" ? record.spec : 0;

	if (spec === 0) {
		throw new CoralError("That did not look like a Coral module.");
	}
	if (spec > SUPPORTED_SPEC) {
		throw new CoralError(
			`That module speaks Coral spec ${spec}; this Librarian understands ${SUPPORTED_SPEC}.`,
		);
	}

	const module = (record.module ?? {}) as Record<string, unknown>;
	const auth = (record.auth ?? {}) as Record<string, unknown>;

	return {
		spec,
		module: {
			id: text(module.id, "unknown"),
			name: text(module.name, text(module.id, "Unknown module")),
			version: text(module.version, "unknown"),
		},
		auth: {
			required: auth.required !== false,
			schemes: Array.isArray(auth.schemes) ? auth.schemes.filter((s) => typeof s === "string") : [],
		},
		capabilities: parseCapabilities(record.capabilities),
	};
}

/** Read a module's manifest. Used before a link exists, so it takes raw values. */
export async function fetchManifest(url: string, token: string | null): Promise<RemoteManifest> {
	const response = await request(`${normalizeUrl(url)}/api/coral/manifest`, token);
	return parseManifest(await response.json().catch(() => null));
}

export interface RemoteDownload {
	id: string;
	name: string;
	done: boolean;
	length: number;
	/** Where it sits under the producer's downloads root, once it is there. */
	rootRelativePath: string | null;
}

function parseDownloads(payload: unknown): RemoteDownload[] {
	if (typeof payload !== "object" || payload === null) return [];

	const items = (payload as Record<string, unknown>).items;
	if (!Array.isArray(items)) return [];

	const downloads: RemoteDownload[] = [];
	for (const entry of items) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.id !== "string") continue;

		downloads.push({
			id: record.id,
			name: text(record.name, record.id),
			done: record.done === true,
			length: typeof record.length === "number" ? record.length : 0,
			rootRelativePath:
				typeof record.rootRelativePath === "string" && record.rootRelativePath.length > 0
					? record.rootRelativePath
					: null,
		});
	}

	return downloads;
}

/**
 * What a linked module is downloading.
 *
 * The plan called for an SSE subscription with backoff on top of this poll.
 * It is not here: v1 imports only on an operator's say-so, so nothing acts on
 * a download the moment it lands, and a subscription would buy latency
 * nobody is waiting on while adding a reconnecting background client to keep
 * alive. The producer's stream stays a reconcile stream either way, so this
 * can become the fallback rather than the mechanism without the callers
 * changing.
 */
export async function fetchDownloads(linkId: string): Promise<RemoteDownload[]> {
	const link = getLinkWithToken(linkId);
	if (!link) throw new CoralError("No such connection.");

	const path = capabilityPath(link, "downloads.list");
	if (!path) throw new CoralError(`${link.moduleName} does not offer a downloads list.`);

	const response = await request(`${link.url}${path}`, link.token);
	const downloads = parseDownloads(await response.json().catch(() => null));

	markLinkSeen(link.id);

	return downloads;
}

/** Re-read a link's manifest, so capabilities that moved are noticed. */
export async function refreshLink(linkId: string): Promise<CoralLink | null> {
	const link = getLinkWithToken(linkId);
	if (!link) return null;

	const manifest = await fetchManifest(link.url, link.token);
	markLinkSeen(link.id, manifest.capabilities);

	const { listLinks } = await import("./coral-links");
	return listLinks().find((candidate) => candidate.id === link.id) ?? null;
}
