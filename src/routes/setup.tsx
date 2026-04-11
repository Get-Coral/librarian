import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { fetchSetupStatus, saveSetupConfiguration } from "#/server/functions";

export const Route = createFileRoute("/setup")({
	loader: async () => {
		return fetchSetupStatus();
	},
	component: SetupPage,
});

function SetupPage() {
	const navigate = useNavigate();
	const summary = Route.useLoaderData();
	const [url, setUrl] = useState(summary.current.url);
	const [apiKey, setApiKey] = useState(summary.current.apiKey);
	const [userId, setUserId] = useState(summary.current.userId);
	const [username, setUsername] = useState(summary.current.username);
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setError(null);

		try {
			await saveSetupConfiguration({
				data: {
					url,
					apiKey,
					userId,
					username,
					password,
				},
			});
			await navigate({ to: "/" });
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: "Librarian could not save your Jellyfin settings.",
			);
		} finally {
			setSaving(false);
		}
	}

	return (
		<main className="min-h-screen bg-abyss px-6 py-10 text-ink sm:px-8 lg:px-12">
			<div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
				<section className="rounded-[2rem] border border-white/10 bg-gradient-to-br from-teal/10 via-white/[0.04] to-coral/10 p-8">
					<p className="text-xs font-semibold uppercase tracking-[0.35em] text-teal">
						Librarian Setup
					</p>
					<h1 className="mt-4 font-display text-5xl leading-none">
						{summary.configured
							? "Edit Jellyfin connection"
							: "Connect Librarian to Jellyfin"}
					</h1>
					<p className="mt-6 text-lg leading-8 text-ink-muted">
						Use the same local-first model as Aurora: if `JELLYFIN_*` env vars
						are present, Librarian can skip onboarding on the homepage. This
						page still lets you inspect the current values and save a local
						SQLite override when you want to change them.
					</p>

					<div className="mt-10 space-y-4">
						{[
							"Server URL, API key, and user ID are required.",
							"Username and password are optional, but validate admin access if provided.",
							"Saved settings go to Librarian's local SQLite database.",
							summary.source === "env"
								? "Current values are coming from environment variables until you save an override here."
								: summary.source === "database"
									? "Current values are already being served from Librarian's local SQLite database."
									: summary.source === "merged"
										? "Current values are being composed from both environment and saved database settings."
										: "No saved connection was found yet.",
						].map((line) => (
							<div
								key={line}
								className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3 text-sm text-ink-muted"
							>
								{line}
							</div>
						))}
					</div>
				</section>

				<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-8">
					<form className="space-y-5" onSubmit={handleSubmit}>
						<div>
							<label
								htmlFor="setup-url"
								className="mb-2 block text-sm font-medium text-ink"
							>
								Jellyfin URL
							</label>
							<input
								id="setup-url"
								className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								placeholder="http://localhost:8096"
							/>
						</div>

						<div>
							<label
								htmlFor="setup-api-key"
								className="mb-2 block text-sm font-medium text-ink"
							>
								API key
							</label>
							<input
								id="setup-api-key"
								className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
								value={apiKey}
								onChange={(event) => setApiKey(event.target.value)}
								placeholder="Paste a Jellyfin API key"
							/>
						</div>

						<div>
							<label
								htmlFor="setup-user-id"
								className="mb-2 block text-sm font-medium text-ink"
							>
								User ID
							</label>
							<input
								id="setup-user-id"
								className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
								value={userId}
								onChange={(event) => setUserId(event.target.value)}
								placeholder="Jellyfin user UUID"
							/>
						</div>

						<div className="grid gap-5 md:grid-cols-2">
							<div>
								<label
									htmlFor="setup-username"
									className="mb-2 block text-sm font-medium text-ink"
								>
									Username
								</label>
								<input
									id="setup-username"
									className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
									value={username}
									onChange={(event) => setUsername(event.target.value)}
									placeholder="Optional"
								/>
							</div>

							<div>
								<label
									htmlFor="setup-password"
									className="mb-2 block text-sm font-medium text-ink"
								>
									Password
								</label>
								<input
									id="setup-password"
									type="password"
									className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									placeholder="Optional"
								/>
							</div>
						</div>

						{error ? (
							<div className="rounded-2xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
								{error}
							</div>
						) : null}

						<div className="flex flex-wrap items-center gap-3 pt-3">
							<button
								type="submit"
								disabled={saving}
								className="rounded-full bg-coral px-6 py-3 text-sm font-semibold text-abyss transition hover:bg-[#ff8787] disabled:cursor-not-allowed disabled:opacity-60"
							>
								{saving ? "Connecting…" : "Connect Jellyfin"}
							</button>
							<span className="text-sm text-ink-faint">
								Librarian will validate the connection before saving it.
							</span>
						</div>
					</form>
				</section>
			</div>
		</main>
	);
}
