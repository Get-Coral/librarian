import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ServiceToken } from "#/lib/service-tokens";
import {
	fetchServiceTokens,
	mintServiceTokenFn,
	revokeServiceTokenFn,
} from "#/server/coral-functions";

export const Route = createFileRoute("/connections")({
	loader: async () => fetchServiceTokens(),
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

				<section className="mt-6 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
					<h2 className="font-display text-2xl">Outbound</h2>
					<p className="mt-3 text-sm text-ink-muted">
						Connecting Librarian to another module — pasting its URL and a token it issued — arrives
						when there is a module answering a manifest to connect to.
					</p>
				</section>
			</div>
		</main>
	);
}
