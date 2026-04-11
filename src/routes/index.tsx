import {
	createFileRoute,
	Link,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { useEffect, useState, useTransition } from "react";
import type {
	LibrarianDashboardData,
	LibrarianHealthMetric,
	LibrarianReviewDetail,
} from "#/lib/jellyfin";
import {
	dismissReviewItem,
	fetchDashboard,
	fetchReviewItemDetail,
	fetchSetupStatus,
	refreshLibraries,
	refreshReviewItem,
	renameReviewItem,
	restoreReviewItem,
	updateReviewItemMetadata,
} from "#/server/functions";

export const Route = createFileRoute("/")({
	loader: async () => {
		const setupStatus = await fetchSetupStatus();

		if (!setupStatus?.configured) {
			throw redirect({ to: "/setup" });
		}

		return fetchDashboard();
	},
	component: Home,
});

function formatDate(value?: string) {
	if (!value) return "No recent activity";

	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(value));
	} catch {
		return value;
	}
}

function formatCollectionType(value?: string) {
	return value || "Mixed";
}

function toneClasses(tone: LibrarianHealthMetric["tone"]) {
	if (tone === "teal") return "bg-teal/12 text-teal";
	if (tone === "gold") return "bg-gold/12 text-gold";
	return "bg-coral/12 text-coral";
}

function Home() {
	const router = useRouter();
	const initialDashboard = Route.useLoaderData();
	const [dashboard, setDashboard] =
		useState<LibrarianDashboardData>(initialDashboard);
	const [error, setError] = useState<string | null>(null);
	const [isRefreshing, startRefreshTransition] = useTransition();
	const [selectedReviewItemId, setSelectedReviewItemId] = useState<
		string | null
	>(initialDashboard.reviewQueue[0]?.id ?? null);
	const [selectedDetail, setSelectedDetail] =
		useState<LibrarianReviewDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [overviewValue, setOverviewValue] = useState("");
	const [yearValue, setYearValue] = useState("");
	const [genresValue, setGenresValue] = useState("");
	const [isActionPending, startActionTransition] = useTransition();

	useEffect(() => {
		const available = dashboard.reviewQueue.some(
			(item) => item.id === selectedReviewItemId,
		);
		if (!available) {
			setSelectedReviewItemId(dashboard.reviewQueue[0]?.id ?? null);
		}
	}, [dashboard.reviewQueue, selectedReviewItemId]);

	useEffect(() => {
		if (!selectedReviewItemId) {
			setSelectedDetail(null);
			setRenameValue("");
			return;
		}

		const itemId = selectedReviewItemId;
		let cancelled = false;

		async function loadDetail() {
			try {
				setDetailLoading(true);
				setDetailError(null);
				const detail = await fetchReviewItemDetail({ data: { itemId } });
				if (!cancelled) {
					setSelectedDetail(detail);
					setRenameValue(detail.title);
					setOverviewValue(detail.overview);
					setYearValue(detail.year ? String(detail.year) : "");
					setGenresValue(detail.genres.join(", "));
				}
			} catch (loadError) {
				if (!cancelled) {
					setDetailError(
						loadError instanceof Error
							? loadError.message
							: "Could not load the review item details.",
					);
				}
			} finally {
				if (!cancelled) {
					setDetailLoading(false);
				}
			}
		}

		void loadDetail();

		return () => {
			cancelled = true;
		};
	}, [selectedReviewItemId]);

	async function reloadDashboard() {
		const data = await fetchDashboard();
		setDashboard(data);
		await router.invalidate();
		return data;
	}

	function handleRefreshLibraries() {
		startRefreshTransition(async () => {
			try {
				setError(null);
				await refreshLibraries();
				await reloadDashboard();
			} catch (refreshError) {
				setError(
					refreshError instanceof Error
						? refreshError.message
						: "Could not trigger a library refresh.",
				);
			}
		});
	}

	function handleDismissReviewItem(itemId: string) {
		startActionTransition(async () => {
			try {
				setError(null);
				await dismissReviewItem({ data: { itemId } });
				await reloadDashboard();
			} catch (actionError) {
				setError(
					actionError instanceof Error
						? actionError.message
						: "Could not dismiss the review item.",
				);
			}
		});
	}

	function handleRestoreReviewItem(itemId: string) {
		startActionTransition(async () => {
			try {
				setError(null);
				await restoreReviewItem({ data: { itemId } });
				await reloadDashboard();
				setSelectedReviewItemId(itemId);
			} catch (actionError) {
				setError(
					actionError instanceof Error
						? actionError.message
						: "Could not restore the review item.",
				);
			}
		});
	}

	function handleRefreshReviewItem(itemId: string) {
		startActionTransition(async () => {
			try {
				setError(null);
				await refreshReviewItem({ data: { itemId } });
				await reloadDashboard();
			} catch (actionError) {
				setError(
					actionError instanceof Error
						? actionError.message
						: "Could not refresh the item.",
				);
			}
		});
	}

	function handleRenameReviewItem(itemId: string) {
		startActionTransition(async () => {
			try {
				setError(null);
				await renameReviewItem({
					data: {
						itemId,
						name: renameValue,
					},
				});
				await reloadDashboard();
				const detail = await fetchReviewItemDetail({ data: { itemId } });
				setSelectedDetail(detail);
				setRenameValue(detail.title);
			} catch (actionError) {
				setError(
					actionError instanceof Error
						? actionError.message
						: "Could not rename the item.",
				);
			}
		});
	}

	function handleSaveMetadata(itemId: string) {
		startActionTransition(async () => {
			try {
				setError(null);
				const parsedYear = yearValue.trim();
				const year = parsedYear ? Number(parsedYear) : undefined;

				if (
					parsedYear &&
					(year === undefined ||
						!Number.isInteger(year) ||
						year < 1800 ||
						year > 3000)
				) {
					throw new Error("Year must be a whole number between 1800 and 3000.");
				}

				const genres = genresValue
					.split(",")
					.map((genre) => genre.trim())
					.filter(Boolean);

				await updateReviewItemMetadata({
					data: {
						itemId,
						overview: overviewValue,
						year,
						genres,
					},
				});

				const data = await reloadDashboard();
				const stillFlagged = data.reviewQueue.some(
					(item) => item.id === itemId,
				);

				if (stillFlagged) {
					const detail = await fetchReviewItemDetail({ data: { itemId } });
					setSelectedDetail(detail);
					setOverviewValue(detail.overview);
					setYearValue(detail.year ? String(detail.year) : "");
					setGenresValue(detail.genres.join(", "));
				} else {
					setSelectedDetail(null);
				}
			} catch (actionError) {
				setError(
					actionError instanceof Error
						? actionError.message
						: "Could not save the metadata changes.",
				);
			}
		});
	}

	const counts = [
		{ label: "Movies", value: dashboard.itemCounts.MovieCount ?? 0 },
		{ label: "Series", value: dashboard.itemCounts.SeriesCount ?? 0 },
		{ label: "Episodes", value: dashboard.itemCounts.EpisodeCount ?? 0 },
		{ label: "Books", value: dashboard.itemCounts.BookCount ?? 0 },
	];

	return (
		<main className="min-h-screen bg-abyss px-6 py-8 text-ink sm:px-8 xl:px-12 2xl:px-16">
			<div className="mx-auto max-w-[96rem]">
				<div className="mb-10 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
					<div>
						<p className="text-xs font-semibold uppercase tracking-[0.35em] text-teal">
							Librarian
						</p>
						<h1 className="mt-3 font-display text-5xl leading-none text-ink sm:text-6xl">
							Library health
						</h1>
						<p className="mt-4 max-w-3xl text-lg leading-8 text-ink-muted">
							Connected to {dashboard.systemInfo.ServerName}. Librarian now
							tracks metadata gaps, scan history, and review-ready issues on top
							of the Jellyfin integration.
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

				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
					{counts.map((count) => (
						<section
							key={count.label}
							className="rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-6"
						>
							<p className="text-sm uppercase tracking-[0.25em] text-ink-faint">
								{count.label}
							</p>
							<p className="mt-4 font-display text-5xl text-ink">
								{count.value}
							</p>
						</section>
					))}
				</div>

				<div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
					{dashboard.health.map((metric) => (
						<section
							key={metric.id}
							className="rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-6"
						>
							<div className="flex items-start justify-between gap-4">
								<div>
									<p className="text-sm uppercase tracking-[0.25em] text-ink-faint">
										{metric.label}
									</p>
									<p className="mt-4 font-display text-5xl text-ink">
										{metric.count}
									</p>
								</div>
								<span
									className={`rounded-full px-3 py-1 text-xs ${toneClasses(metric.tone)}`}
								>
									Health
								</span>
							</div>
							<p className="mt-4 text-sm leading-6 text-ink-muted">
								{metric.description}
							</p>
						</section>
					))}
				</div>

				<section className="mt-6 rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 xl:p-7">
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

					<div className="mt-6 grid gap-5 xl:grid-cols-[minmax(20rem,0.78fr)_minmax(0,1.22fr)] 2xl:grid-cols-[minmax(22rem,0.74fr)_minmax(0,1.26fr)]">
						<div className="space-y-4">
							{dashboard.reviewQueue.length > 0 ? (
								dashboard.reviewQueue.map((item) => (
									<button
										key={item.id}
										type="button"
										onClick={() => setSelectedReviewItemId(item.id)}
										className={`w-full rounded-3xl border p-5 text-left transition ${
											selectedReviewItemId === item.id
												? "border-teal/40 bg-teal/10"
												: "border-white/10 bg-black/15 hover:border-white/20"
										}`}
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div>
												<h3 className="text-xl font-semibold text-ink">
													{item.title}
												</h3>
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
									</button>
								))
							) : (
								<div className="rounded-3xl border border-dashed border-white/10 bg-black/10 p-6 text-sm text-ink-muted">
									No review items were found in the sampled libraries.
								</div>
							)}
						</div>

						<div className="rounded-3xl border border-white/10 bg-black/15 p-6 xl:p-7">
							{selectedReviewItemId ? (
								detailLoading ? (
									<div className="space-y-4 animate-pulse">
										<div className="h-8 w-2/3 rounded-2xl bg-white/10" />
										<div className="h-20 rounded-3xl bg-white/5" />
									</div>
								) : detailError ? (
									<div className="rounded-2xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
										{detailError}
									</div>
								) : selectedDetail ? (
									<div>
										<div className="flex flex-wrap items-start justify-between gap-4">
											<div className="max-w-3xl">
												<p className="text-xs uppercase tracking-[0.3em] text-ink-faint">
													Review detail
												</p>
												<h3 className="mt-2 font-display text-3xl text-ink xl:text-4xl">
													{selectedDetail.title}
												</h3>
												<p className="mt-2 text-sm uppercase tracking-[0.25em] text-ink-faint">
													{selectedDetail.type}
													{selectedDetail.year
														? ` · ${selectedDetail.year}`
														: ""}
												</p>
											</div>
											<div className="flex flex-wrap gap-2">
												<button
													type="button"
													onClick={() =>
														handleRefreshReviewItem(selectedDetail.id)
													}
													disabled={isActionPending}
													className="rounded-full bg-teal/12 px-3 py-2 text-xs font-semibold text-teal disabled:opacity-60"
												>
													Refresh item
												</button>
												<button
													type="button"
													onClick={() =>
														handleDismissReviewItem(selectedDetail.id)
													}
													disabled={isActionPending}
													className="rounded-full bg-coral/12 px-3 py-2 text-xs font-semibold text-coral disabled:opacity-60"
												>
													Dismiss
												</button>
											</div>
										</div>

										<div className="mt-5 flex flex-wrap gap-2">
											{selectedDetail.reasons.map((reason) => (
												<span
													key={reason}
													className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-ink-muted"
												>
													{reason}
												</span>
											))}
										</div>

										<div className="mt-7">
											<label
												htmlFor="review-title"
												className="mb-2 block text-sm font-medium text-ink"
											>
												Title
											</label>
											<div className="flex flex-col gap-3 sm:flex-row">
												<input
													id="review-title"
													value={renameValue}
													onChange={(event) =>
														setRenameValue(event.target.value)
													}
													className="flex-1 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-ink outline-none transition focus:border-teal/40"
												/>
												<button
													type="button"
													onClick={() =>
														handleRenameReviewItem(selectedDetail.id)
													}
													disabled={
														isActionPending || renameValue.trim().length === 0
													}
													className="rounded-full bg-coral px-5 py-3 text-sm font-semibold text-abyss disabled:opacity-60"
												>
													Rename
												</button>
											</div>
										</div>

										<div className="mt-7 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
											<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
												<label
													htmlFor="review-overview"
													className="text-xs uppercase tracking-[0.25em] text-ink-faint"
												>
													Overview
												</label>
												<textarea
													id="review-overview"
													value={overviewValue}
													onChange={(event) =>
														setOverviewValue(event.target.value)
													}
													rows={8}
													className="mt-3 min-h-52 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-7 text-ink outline-none transition focus:border-teal/40"
												/>
											</div>
											<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
												<label
													htmlFor="review-year"
													className="text-xs uppercase tracking-[0.25em] text-ink-faint"
												>
													Release year
												</label>
												<input
													id="review-year"
													value={yearValue}
													onChange={(event) => setYearValue(event.target.value)}
													placeholder="e.g. 2025"
													className="mt-3 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-ink outline-none transition focus:border-teal/40"
												/>
												<label
													htmlFor="review-genres"
													className="mt-5 block text-xs uppercase tracking-[0.25em] text-ink-faint"
												>
													Genres
												</label>
												<textarea
													id="review-genres"
													value={genresValue}
													onChange={(event) =>
														setGenresValue(event.target.value)
													}
													rows={5}
													placeholder="Drama, Crime, Thriller"
													className="mt-3 min-h-36 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-7 text-ink outline-none transition focus:border-teal/40"
												/>
												<p className="mt-3 text-xs text-ink-faint">
													Separate genres with commas.
												</p>
												<button
													type="button"
													onClick={() => handleSaveMetadata(selectedDetail.id)}
													disabled={isActionPending}
													className="mt-5 rounded-full bg-teal px-5 py-3 text-sm font-semibold text-abyss disabled:opacity-60"
												>
													Save metadata
												</button>
											</div>
										</div>

										<div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
											<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
												<p className="text-xs uppercase tracking-[0.25em] text-ink-faint">
													Studios
												</p>
												<div className="mt-3 flex flex-wrap gap-2">
													{selectedDetail.studios.length > 0 ? (
														selectedDetail.studios.map((studio) => (
															<span
																key={studio}
																className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-ink-muted"
															>
																{studio}
															</span>
														))
													) : (
														<span className="text-sm text-ink-muted">
															No studios assigned.
														</span>
													)}
												</div>
											</div>
											<div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
												<div className="flex items-center justify-between gap-3">
													<p className="text-xs uppercase tracking-[0.25em] text-ink-faint">
														People
													</p>
													<button
														type="button"
														onClick={() =>
															handleRestoreReviewItem(selectedDetail.id)
														}
														disabled={isActionPending}
														className="text-xs text-teal disabled:opacity-60"
													>
														Restore item
													</button>
												</div>
												<div className="mt-3 space-y-2">
													{selectedDetail.people.length > 0 ? (
														selectedDetail.people.slice(0, 6).map((person) => (
															<div
																key={person.id}
																className="flex items-center justify-between gap-3 text-sm text-ink-muted"
															>
																<span className="text-ink">{person.name}</span>
																<span>
																	{person.role || person.type || "Contributor"}
																</span>
															</div>
														))
													) : (
														<span className="text-sm text-ink-muted">
															No people metadata available.
														</span>
													)}
												</div>
											</div>
										</div>
									</div>
								) : null
							) : (
								<div className="rounded-3xl border border-dashed border-white/10 bg-black/10 p-6 text-sm text-ink-muted">
									Select a review item to inspect it and run actions.
								</div>
							)}
						</div>
					</div>
				</section>

				<div className="mt-6 grid gap-6 xl:grid-cols-[0.86fr_1.14fr]">
					<div className="space-y-6">
						<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 xl:p-7">
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
													<h3 className="text-base font-semibold text-ink">
														{job.label}
													</h3>
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

						<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 xl:p-7">
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

						<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 xl:p-7">
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

					<section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 xl:p-7">
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
											<h3 className="text-xl font-semibold text-ink">
												{folder.Name}
											</h3>
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
				</div>
			</div>
		</main>
	);
}
