import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { fetchAuthStatus, signIn } from "#/server/functions";

export const Route = createFileRoute("/login")({
	loader: async () => {
		const status = await fetchAuthStatus();

		// Nothing to sign in against yet — finish setup first.
		if (!status.configured) throw redirect({ to: "/setup" });
		if (status.userId) throw redirect({ to: "/" });

		return status;
	},
	component: LoginPage,
});

function LoginPage() {
	const navigate = useNavigate();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [signingIn, setSigningIn] = useState(false);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSigningIn(true);
		setError(null);

		try {
			await signIn({ data: { username, password } });
			await navigate({ to: "/" });
		} catch (submitError) {
			setError(submitError instanceof Error ? submitError.message : "Could not sign you in.");
		} finally {
			setSigningIn(false);
		}
	}

	return (
		<main className="grid min-h-screen place-items-center bg-abyss px-6 text-ink">
			<div className="w-full max-w-md rounded-[2rem] border border-white/10 bg-gradient-to-br from-teal/10 via-white/[0.04] to-coral/10 p-8">
				<p className="text-xs font-semibold uppercase tracking-[0.35em] text-teal">Librarian</p>
				<h1 className="mt-4 font-display text-4xl leading-none">Sign in</h1>
				<p className="mt-4 text-sm leading-6 text-ink-muted">
					Use your Jellyfin account. Librarian keeps no accounts of its own, and organising files is
					limited to Jellyfin administrators.
				</p>

				<form className="mt-8 grid gap-5" onSubmit={handleSubmit}>
					<div>
						<label htmlFor="login-username" className="mb-2 block text-sm font-medium text-ink">
							Username
						</label>
						<input
							id="login-username"
							className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
							autoComplete="username"
						/>
					</div>

					<div>
						<label htmlFor="login-password" className="mb-2 block text-sm font-medium text-ink">
							Password
						</label>
						<input
							id="login-password"
							type="password"
							className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete="current-password"
						/>
					</div>

					{error ? (
						<div className="rounded-2xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
							{error}
						</div>
					) : null}

					<button
						type="submit"
						disabled={signingIn}
						className="rounded-2xl bg-teal px-5 py-3 text-base font-semibold text-abyss transition hover:bg-teal/90 disabled:opacity-60"
					>
						{signingIn ? "Signing in…" : "Sign in"}
					</button>
				</form>
			</div>
		</main>
	);
}
