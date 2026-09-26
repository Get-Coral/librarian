import crypto from "node:crypto";
import { getJsonSetting, setJsonSetting } from "./config-store";

/**
 * Other Coral modules Librarian has been pointed at.
 *
 * Nothing is discovered. An operator pastes a URL and a token, and until they
 * do, two modules on the same Docker network that have not been introduced
 * stay strangers.
 *
 * Be honest about the stored token: it cannot be hashed, because Librarian
 * has to send it. It sits at the same trust level as `JELLYFIN_API_KEY`
 * already does in a compose file, and the UI says so.
 */

const STORAGE_KEY = "coral.links";

export interface CoralCapability {
	name: string;
	version: number;
	path: string;
}

export interface CoralLink {
	id: string;
	/** No trailing slash. */
	url: string;
	moduleId: string;
	moduleName: string;
	moduleVersion: string;
	/** What the module said it could do when it was last checked. */
	capabilities: CoralCapability[];
	addedAt: string;
	lastSeenAt: string | null;
}

interface StoredLink extends CoralLink {
	token: string;
}

function load(): StoredLink[] {
	return getJsonSetting<StoredLink[]>(STORAGE_KEY, []);
}

function save(links: StoredLink[]): void {
	setJsonSetting(STORAGE_KEY, links);
}

function redact(link: StoredLink): CoralLink {
	const { token: _token, ...rest } = link;
	return rest;
}

export function normalizeUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

export function listLinks(): CoralLink[] {
	return load().map(redact);
}

/** Internal: the stored record including its token, for making a request. */
export function getLinkWithToken(id: string): StoredLink | null {
	return load().find((link) => link.id === id) ?? null;
}

export function saveLink(input: {
	url: string;
	token: string;
	moduleId: string;
	moduleName: string;
	moduleVersion: string;
	capabilities: CoralCapability[];
}): CoralLink {
	const url = normalizeUrl(input.url);
	const existing = load().find((link) => link.url === url);

	const record: StoredLink = {
		id: existing?.id ?? crypto.randomUUID(),
		url,
		token: input.token,
		moduleId: input.moduleId,
		moduleName: input.moduleName,
		moduleVersion: input.moduleVersion,
		capabilities: input.capabilities,
		addedAt: existing?.addedAt ?? new Date().toISOString(),
		lastSeenAt: new Date().toISOString(),
	};

	save([...load().filter((link) => link.id !== record.id), record]);

	return redact(record);
}

export function deleteLink(id: string): void {
	save(load().filter((link) => link.id !== id));
}

export function markLinkSeen(id: string, capabilities?: CoralCapability[]): void {
	save(
		load().map((link) =>
			link.id === id
				? {
						...link,
						lastSeenAt: new Date().toISOString(),
						capabilities: capabilities ?? link.capabilities,
					}
				: link,
		),
	);
}

/** Whether a link advertises a capability, at a version we understand. */
export function hasCapability(link: CoralLink, name: string, version = 1): boolean {
	return link.capabilities.some(
		(capability) => capability.name === name && capability.version === version,
	);
}

export function capabilityPath(link: CoralLink, name: string): string | null {
	// The path is declared by the module, never derived from the name.
	return link.capabilities.find((capability) => capability.name === name)?.path ?? null;
}
