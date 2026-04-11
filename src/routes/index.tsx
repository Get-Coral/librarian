import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router"
import { useState, useTransition } from "react"
import { fetchDashboard, fetchSetupStatus, refreshLibraries } from "#/server/functions"
import type { LibrarianDashboardData, LibrarianHealthMetric } from "#/lib/jellyfin"

export const Route = createFileRoute("/")({
	loader: async () => {
		const setupStatus = await fetchSetupStatus()

		if (!setupStatus?.configured) {
			throw redirect({ to: "/setup" })
		}

		return fetchDashboard()
	},
	component: Home,
})

function formatDate(value?: string) {
	if (!value) return "No recent activity"

	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(value))
	} catch {
		return value
	}
}

function formatCollectionType(value?: string) {
	return value || "Mixed"
}

function toneClasses(tone: LibrarianHealthMetric["tone"]) {
	if (tone === "teal") return "bg-teal/12 text-teal"
	if (tone === "gold") return "bg-gold/12 text-gold"
	return "bg-coral/12 text-coral"
}

function Home() {
	const router = useRouter()
	const initialDashboard = Route.useLoaderData()
	const [dashboard, setDashboard] = useState<LibrarianDashboardData>(initialDashboard)
	const [error, setError] = useState<string | null>(null)
	const [isRefreshing, startRefreshTransition] = useTransition()

	function handleRefreshLibraries() {
		startRefreshTransition(async () => {
			try {
				setError(null)
				await refreshLibraries()
				const data = await fetchDashboard()
				setDashboard(data)
				await router.invalidate()
			} catch (refreshError) {
				setError(
					refreshError instanceof Error
						? refreshError.message
						: "Could not trigger a library refresh.",
				)
			}
		})
	}

	const counts = [
		{ label: "Movies", value: dashboard.itemCounts.MovieCount ?? 0 },
		{ label: "Series", value: dashboard.itemCounts.SeriesCount ?? 0 },
		{ label: "Episodes", value: dashboard.itemCounts.EpisodeCount ?? 0 },
		{ label: "Books", value: dashboard.itemCounts.BookCount ?? 0 },
	]

	return (
		<main className="min-h-screen bg-abyss px-6 py-8 text-ink sm:px-8 lg:px-12">
			<div className="mx-auto max-w-7xl">
				<div className="mb-10 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
					<div>
						<p className="text-xs font-semibold uppercase tracking-[0.35em] text-teal">
							Librarian
						</p>
						<h1 className="mt-3 font-display text-5xl leading-none text-ink sm:text-6xl">
							Library health
						</h1>
						<p className="mt-4 max-w-3xl text-lg leading-8 text-ink-muted">
							Connected to {dashboard.systemInfo.ServerName}. Librarian now tracks
							metadata gaps, scan history, and review-ready issues on top of the
							Jellyfin integration.
						</p>
					</div>

					<div className="flex flex-wrap gap-3">
						<button
							type="button"
							onClick={handleRefreshLibraries}
							disabled={isRefreshing}
							className="rounded-full bg-coral px-5 py-3 text-sm font-semibold text-abyss transition hover:bg-[#ff8787] disabled:cursor-not-allowed disabled:opacity-60"
						>
							{isRefreshing ? "Refreshing…" : "Refresh all libraries"}
						</button>
						<Link
							to="/setup"
							className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-ink"
						>
							Edit connection
						</Link>
					</div>
				</div>

				{error ? (
					<div className="mb-6 rounded-2xl border border-coral/30 bg-coral/10 px-5 py-4 text-sm text-coral">
						{error}
					</div>
				) : null}

				<div className="grid gap-4 md:grid-cols-4">
					{counts.map((count) => (
						<section
							key={count.label}
							className="rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-5"
						>
							<p className="text-sm uppercase tracking-[0.25em] text-ink-faint">
								{count.label}
							</p>
							<p className="mt-4 font-display text-5xl text-ink">{count.value}</p>
						</section>
					))}
				</div>

				<div className="mt-6 grid gap-4 lg:grid-cols-4">
					{dashboard.health.map((metric) => (
						<section
							key={metric.id}
							className="rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-5"
						>
							<div className="flex items-start justify-between gap-4">
								<div>
									<p className="text-sm uppercase tracking-[0.25em] text-ink-faint">
										{metric.label}
									</p>
									<p className="mt-4 font-display text-5xl text-ink">{metric.count}</p>
								</div>
								<span className={`rounded-full px-3 py-1 text-xs ${toneClasses(metric.tone)}`}>
									Health
								</span>
							</div>
							<p className="mt-4 text-sm leading-6 text-ink-muted">
								{metric.description}
							</p>
						</section>
					))}
				</div>

				<div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
					<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="text-xs uppercase tracking-[0.3em] text-ink-faint">
									Review queue
								</p>
								<h2 className="mt-2 font-display text-3xl">Needs attention</h2>
							</div>
							<div className="rounded-full bg-coral/12 px-3 py-1 text-sm text-coral">
								{dashboard.reviewQueue.length} items
							</div>
						</div>

						<div className="mt-6 space-y-4">
							{dashboard.reviewQueue.length > 0 ? (
								dashboard.reviewQueue.map((item) => (
									<div
										key={item.id}
										className="rounded-3xl border border-white/10 bg-black/15 p-5"
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div>
												<h3 className="text-xl font-semibold text-ink">{item.title}</h3>
												<p className="mt-2 text-sm uppercase tracking-[0.25em] text-ink-faint">
													{item.library} · {item.type}
													{item.year ? ` · ${item.year}` : ""}
												</p>
											</div>
											<div className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-muted">
												{item.reasons.length} issue
												{item.reasons.length === 1 ? "" : "s"}
											</div>
										</div>
										<div className="mt-4 flex flex-wrap gap-2">
											{item.reasons.map((reason) => (
												<span
													key={reason}
													className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-ink-muted"
												>
													{reason}
												</span>
											))}
										</div>
									</div>
								))
							) : (
								<div className="rounded-3xl border border-dashed border-white/10 bg-black/10 p-6 text-sm text-ink-muted">
									No review items were found in the sampled libraries.
								</div>
							)}
						</div>
					</section>

					<div className="space-y-6">
						<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-xs uppercase tracking-[0.3em] text-ink-faint">
										Scan jobs
									</p>
									<h2 className="mt-2 font-display text-3xl">Recent jobs</h2>
								</div>
								<div className="rounded-full bg-teal/12 px-3 py-1 text-sm text-teal">
									{dashboard.scanJobs.length} logged
								</div>
							</div>

							<div className="mt-6 space-y-4">
								{dashboard.scanJobs.length > 0 ? (
									dashboard.scanJobs.map((job) => (
										<div
											key={job.id}
											className="rounded-3xl border border-white/10 bg-black/15 p-4"
										>
											<div className="flex items-start justify-between gap-3">
												<div>
													<h3 className="text-base font-semibold text-ink">{job.label}</h3>
													<p className="mt-1 text-sm text-ink-muted">
														{job.details ?? "No details recorded."}
													</p>
												</div>
												<span
													className={`rounded-full px-3 py-1 text-xs ${
														job.status === "completed"
															? "bg-teal/12 text-teal"
															: job.status === "failed"
																? "bg-coral/12 text-coral"
																: "bg-gold/12 text-gold"
													}`}
												>
													{job.status}
												</span>
											</div>
											<p className="mt-3 text-xs text-ink-faint">
												Updated {formatDate(job.updatedAt)}
											</p>
										</div>
									))
								) : (
									<div className="rounded-3xl border border-dashed border-white/10 bg-black/10 p-6 text-sm text-ink-muted">
										No scan jobs yet. Run a library refresh to seed the job log.
									</div>
								)}
							</div>
						</section>

						<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-xs uppercase tracking-[0.3em] text-ink-faint">
										Libraries
									</p>
									<h2 className="mt-2 font-display text-3xl">Virtual folders</h2>
								</div>
								<div className="rounded-full bg-teal/12 px-3 py-1 text-sm text-teal">
									{dashboard.virtualFolders.length} mounted
								</div>
							</div>

							<div className="mt-6 space-y-4">
								{dashboard.virtualFolders.map((folder) => (
									<div
										key={folder.ItemId}
										className="rounded-3xl border border-white/10 bg-black/15 p-5"
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div>
												<h3 className="text-xl font-semibold text-ink">{folder.Name}</h3>
												<p className="mt-2 text-sm uppercase tracking-[0.25em] text-ink-faint">
													{formatCollectionType(folder.CollectionType)}
												</p>
											</div>
											<div className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-muted">
												{folder.Locations?.length ?? 0} path
												{(folder.Locations?.length ?? 0) === 1 ? "" : "s"}
											</div>
										</div>
										<div className="mt-4 flex flex-wrap gap-2">
											{folder.Locations?.map((location) => (
												<span
													key={location}
													className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-ink-muted"
												>
													{location}
												</span>
											))}
										</div>
									</div>
								))}
							</div>
						</section>

						<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
							<p className="text-xs uppercase tracking-[0.3em] text-ink-faint">
								Server
							</p>
							<h2 className="mt-2 font-display text-3xl">Connection</h2>
							<dl className="mt-6 space-y-4 text-sm text-ink-muted">
								<div className="flex items-center justify-between gap-4">
									<dt>Version</dt>
									<dd className="text-ink">{dashboard.systemInfo.Version}</dd>
								</div>
								<div className="flex items-center justify-between gap-4">
									<dt>OS</dt>
									<dd className="text-ink">
										{dashboard.systemInfo.OperatingSystem || "Unknown"}
									</dd>
								</div>
								<div className="flex items-center justify-between gap-4">
									<dt>Current user</dt>
									<dd className="text-ink">{dashboard.currentUser.name}</dd>
								</div>
								<div className="flex items-center justify-between gap-4">
									<dt>Users</dt>
									<dd className="text-ink">{dashboard.users.length}</dd>
								</div>
							</dl>
						</section>

						<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-xs uppercase tracking-[0.3em] text-ink-faint">
										Live activity
									</p>
									<h2 className="mt-2 font-display text-3xl">Sessions</h2>
								</div>
								<div className="rounded-full bg-coral/12 px-3 py-1 text-sm text-coral">
									{dashboard.activeSessions.length} active
								</div>
							</div>

							<div className="mt-6 space-y-4">
								{dashboard.activeSessions.length > 0 ? (
									dashboard.activeSessions.map((session) => (
										<div
											key={session.Id}
											className="rounded-3xl border border-white/10 bg-black/15 p-4"
										>
											<div className="flex items-start justify-between gap-3">
												<div>
													<h3 className="text-base font-semibold text-ink">
														{session.UserName ?? "Unknown user"}
													</h3>
													<p className="mt-1 text-sm text-ink-muted">
														{session.Client ?? "Unknown client"} on{" "}
														{session.DeviceName ?? "Unknown device"}
													</p>
												</div>
												<span className="text-xs uppercase tracking-[0.2em] text-ink-faint">
													{session.PlayState?.IsPaused ? "Paused" : "Live"}
												</span>
											</div>
											<p className="mt-3 text-sm text-ink">
												{session.NowPlayingItem?.Name ?? "Nothing playing"}
											</p>
											<p className="mt-2 text-xs text-ink-faint">
												Last activity {formatDate(session.LastActivityDate)}
											</p>
										</div>
									))
								) : (
									<div className="rounded-3xl border border-dashed border-white/10 bg-black/10 p-6 text-sm text-ink-muted">
										No active sessions right now.
									</div>
								)}
							</div>
						</section>
					</div>
				</div>
			</div>
		</main>
	)
}
