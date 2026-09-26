import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { CoralLink } from "#/lib/coral-links";
import type { ServiceToken } from "#/lib/service-tokens";
import {
	addLink,
	fetchLinks,
	fetchServiceTokens,
	mintServiceTokenFn,
	probeModule,
	removeLink,
	revokeServiceTokenFn,
} from "#/server/coral-functions";

export const Route = createFileRoute("/connections")({
	loader: async () => ({ ...(await fetchServiceTokens()), links: await fetchLinks() }),
	component: ConnectionsPage,
});

function formatWhen(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value;

	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
		parsed,
	);
}

function ConnectionsPage() {
	const initial = Route.useLoaderData();
	const [tokens, setTokens] = useState<ServiceToken[]>(initial.tokens);
	const [label, setLabel] = useState("");
	const [scope, setScope] = useState<"read" | "full">("read");
	const [minted, setMinted] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function mint(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		try {
			setError(null);
			const result = await mintServiceTokenFn({ data: { label, scope } });
			setTokens((current) => [...current, result.record]);
			setMinted(result.token);
			setLabel("");
		} catch (mintError) {
			setError(mintError instanceof Error ? mintError.message : "Could not mint a token.");
		} finally {
			setBusy(false);
		}
	}

	async function revoke(id: string) {
		await revokeServiceTokenFn({ data: { id } });
		setTokens((current) => current.filter((token) => token.id !== id));
	}

	return (
		<main className="min-h-screen bg-abyss px-6 py-10 text-ink sm:px-8 lg:px-12">
			<div className="mx-auto max-w-4xl">
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div>
						<p className="text-xs font-semibold uppercase tracking-[0.35em] text-teal">Librarian</p>
						<h1 className="mt-3 font-display text-4xl leading-none">Connections</h1>
						<p className="mt-3 max-w-2xl text-sm leading-6 text-ink-muted">
							Tokens let another Coral module call this one. A token is a grant of capability, not
							an account — it carries no user identity and nothing it reaches will ask who it is.
						</p>
					</div>
					<Link
						to="/"
						className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-ink"
					>
						Back to dashboard
					</Link>
				</div>

				<section className="mt-8 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
					<h2 className="font-display text-2xl">Issue a token</h2>

					<form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]" onSubmit={mint}>
						<input
							aria-label="Token label"
							className="rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-ink"
							placeholder="What is it for? e.g. Tide"
							value={label}
							onChange={(event) => setLabel(event.target.value)}
						/>
						<select
							aria-label="Token scope"
							className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
							value={scope}
							onChange={(event) => setScope(event.target.value as "read" | "full")}
						>
							<option value="read">Read-only</option>
							<option value="full">Full</option>
						</select>
						<button
							type="submit"
							disabled={busy}
							className="rounded-xl bg-teal px-4 py-2 text-sm font-semibold text-abyss disabled:opacity-50"
						>
							Issue
						</button>
					</form>

					{error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}

					{minted ? (
						<div className="mt-4 rounded-2xl border border-teal/30 bg-teal/5 px-4 py-4">
							<p className="text-sm font-semibold text-teal">
								Copy this now — it is not shown again.
							</p>
							<p className="mt-2 break-all font-mono text-xs text-ink">{minted}</p>
							<button
								type="button"
								className="mt-3 rounded-full border border-white/10 px-3 py-1 text-xs text-ink-muted"
								onClick={() => setMinted(null)}
							>
								Done
							</button>
						</div>
					) : null}
				</section>

				<section className="mt-6 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
					<h2 className="font-display text-2xl">Issued</h2>

					{initial.environmentToken ? (
						<p className="mt-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-ink-muted">
							<span className="font-semibold text-ink">CORAL_SERVICE_TOKEN</span> is set in the
							environment and grants full access. It is not listed here and cannot be revoked from
							this page — remove it from your compose file.
						</p>
					) : null}

					<div className="mt-4 grid gap-2">
						{tokens.length === 0 ? <p className="text-sm text-ink-muted">None issued.</p> : null}

						{tokens.map((token) => (
							<div
								key={token.id}
								className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3"
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-semibold">{token.label}</p>
									<p className="truncate text-xs text-ink-muted">
										{token.scopes.includes("full") ? "Full access" : "Read-only"} ·{" "}
										{token.lastUsedAt ? `last used ${formatWhen(token.lastUsedAt)}` : "never used"}
									</p>
								</div>
								<button
									type="button"
									onClick={() => void revoke(token.id)}
									className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-muted"
								>
									Revoke
								</button>
							</div>
						))}
					</div>
				</section>

				<OutboundPanel initial={initial.links} />
			</div>
		</main>
	);
}

/**
 * Modules Librarian has been pointed at.
 *
 * Nothing is discovered: an operator pastes a URL and a token. The manifest
 * is read before anything is stored, so the page can say what it found
 * rather than saving a URL and failing later.
 */
function OutboundPanel({ initial }: { initial: CoralLink[] }) {
	const [links, setLinks] = useState<CoralLink[]>(initial);
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [found, setFound] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function probe() {
		setBusy(true);
		setFound(null);
		try {
			setError(null);
			const manifest = await probeModule({ data: { url, token } });
			const summary =
				manifest.capabilities.length > 0
					? manifest.capabilities.map((capability) => capability.name).join(", ")
					: manifest.auth.required && !token.trim()
						? "needs a token before it will offer anything"
						: "offers nothing Librarian can use";

			setFound(`${manifest.module.name} ${manifest.module.version} — ${summary}`);
		} catch (probeError) {
			setError(probeError instanceof Error ? probeError.message : "Could not read that module.");
		} finally {
			setBusy(false);
		}
	}

	async function connect(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		try {
			setError(null);
			const link = await addLink({ data: { url, token } });
			setLinks((current) => [...current.filter((item) => item.id !== link.id), link]);
			setUrl("");
			setToken("");
			setFound(null);
		} catch (connectError) {
			setError(connectError instanceof Error ? connectError.message : "Could not connect.");
		} finally {
			setBusy(false);
		}
	}

	async function disconnect(id: string) {
		await removeLink({ data: { id } });
		setLinks((current) => current.filter((link) => link.id !== id));
	}

	return (
		<section className="mt-6 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
			<h2 className="font-display text-2xl">Connected modules</h2>
			<p className="mt-2 text-sm text-ink-muted">
				Paste a module's address and a token it issued. Nothing is discovered or scanned — two
				modules that have not been introduced stay strangers.
			</p>

			<form className="mt-4 grid gap-3 sm:grid-cols-[1.2fr_1fr_auto_auto]" onSubmit={connect}>
				<input
					aria-label="Module URL"
					className="rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-ink"
					placeholder="http://tide:3000"
					value={url}
					onChange={(event) => setUrl(event.target.value)}
				/>
				<input
					aria-label="Module token"
					type="password"
					className="rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-ink"
					placeholder="coral_tide_…"
					value={token}
					onChange={(event) => setToken(event.target.value)}
				/>
				<button
					type="button"
					disabled={busy || !url.trim()}
					onClick={() => void probe()}
					className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
				>
					Check
				</button>
				<button
					type="submit"
					disabled={busy || !url.trim()}
					className="rounded-xl bg-teal px-4 py-2 text-sm font-semibold text-abyss disabled:opacity-50"
				>
					Connect
				</button>
			</form>

			{found ? <p className="mt-3 text-sm text-teal">{found}</p> : null}
			{error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}

			<div className="mt-4 grid gap-2">
				{links.length === 0 ? (
					<p className="text-sm text-ink-muted">Not connected to anything.</p>
				) : null}

				{links.map((link) => (
					<div
						key={link.id}
						className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3"
					>
						<div className="min-w-0">
							<p className="truncate text-sm font-semibold">
								{link.moduleName}{" "}
								<span className="text-xs font-normal text-ink-muted">{link.moduleVersion}</span>
							</p>
							<p className="truncate text-xs text-ink-muted">{link.url}</p>
							<p className="truncate text-xs text-ink-muted">
								{link.capabilities.map((capability) => capability.name).join(", ") || "nothing"}
								{link.lastSeenAt ? ` · seen ${formatWhen(link.lastSeenAt)}` : ""}
							</p>
						</div>
						<button
							type="button"
							onClick={() => void disconnect(link.id)}
							className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-muted"
						>
							Disconnect
						</button>
					</div>
				))}
			</div>

			<p className="mt-4 text-xs text-ink-muted">
				A token stored here cannot be hashed — Librarian has to send it. It sits at the same trust
				level as JELLYFIN_API_KEY already does in your compose file.
			</p>
		</section>
	);
}
