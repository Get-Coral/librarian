import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { ImportPlan, ReleaseOverrides } from "#/lib/files/import";
import type { MappingSuggestion, PathMapping } from "#/lib/files/mappings";
import type { FsRoot } from "#/lib/files/roots";
import type { Job } from "#/lib/jobs";
import type { VerificationOutcome } from "#/lib/mapping-service";
import {
	dismissDownload,
	fetchWaitingDownloads,
	type WaitingDownload,
} from "#/server/coral-functions";
import {
	type BrowseEntry,
	browseFilesRoot,
	cancelJob,
	createFilesRoot,
	createMappingFn,
	deleteMappingFn,
	fetchFilesOverview,
	fetchJobs,
	fetchMappings,
	previewImport,
	startImport,
	updateFilesRoot,
	verifyMappingsFn,
} from "#/server/files-functions";

export const Route = createFileRoute("/organize")({
	loader: async () => fetchFilesOverview(),
	component: OrganizePage,
});

function formatBytes(bytes: number): string {
	if (bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

const STRATEGY_BLURB: Record<string, string> = {
	hardlink: "Hardlink — no extra disk used, and the download keeps seeding.",
	rename: "Move — the download will no longer be where it was.",
	copy: "Copy — a second copy on disk, because the two are on different filesystems.",
};

function OrganizePage() {
	const initial = Route.useLoaderData();
	const [roots, setRoots] = useState<FsRoot[]>(initial.roots);
	const [jobs, setJobs] = useState<Job[]>(initial.jobs);
	const [error, setError] = useState<string | null>(null);

	const downloadRoots = roots.filter((root) => root.kind === "downloads" && root.enabled);
	const mediaRoots = roots.filter((root) => root.kind === "media" && root.enabled);

	const [sourceRootId, setSourceRootId] = useState(downloadRoots[0]?.id ?? "");
	const [destinationRootId, setDestinationRootId] = useState(mediaRoots[0]?.id ?? "");
	const [browsePath, setBrowsePath] = useState("");
	const [entries, setEntries] = useState<BrowseEntry[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [plan, setPlan] = useState<ImportPlan | null>(null);
	const [overrides, setOverrides] = useState<Record<string, ReleaseOverrides>>({});
	const [busy, setBusy] = useState(false);
	const [waiting, setWaiting] = useState<WaitingDownload[]>([]);
	const [waitingErrors, setWaitingErrors] = useState<string[]>([]);
	/** Set when the selection came from a linked module rather than the browser. */
	const [source, setSource] = useState<{ linkId: string; downloadId: string } | null>(null);

	const refreshWaiting = useCallback(async () => {
		try {
			const result = await fetchWaitingDownloads();
			setWaiting(result.waiting);
			setWaitingErrors(result.errors);
		} catch {
			// A connected module being unreachable is not worth a page-level error.
		}
	}, []);

	// The producer re-sends the same completed downloads forever, so asking
	// again is harmless; the ledger is what stops anything being offered twice.
	useEffect(() => {
		void refreshWaiting();
		const interval = setInterval(refreshWaiting, 60000);
		return () => clearInterval(interval);
	}, [refreshWaiting]);

	const refreshJobs = useCallback(async () => {
		try {
			setJobs(await fetchJobs());
		} catch {
			// The panel is informational; a failed poll is not worth shouting about.
		}
	}, []);

	// Jobs are short and the queue is one deep, so polling beats a stream here.
	useEffect(() => {
		const active = jobs.some((job) => job.status === "running" || job.status === "queued");
		const interval = setInterval(refreshJobs, active ? 1000 : 5000);
		return () => clearInterval(interval);
	}, [jobs, refreshJobs]);

	const browse = useCallback(async (rootId: string, next: string) => {
		if (!rootId) return;
		try {
			setError(null);
			const result = await browseFilesRoot({ data: { rootId, path: next } });
			setBrowsePath(result.path);
			setEntries(result.entries);
		} catch (browseError) {
			setError(browseError instanceof Error ? browseError.message : "Could not read that folder.");
		}
	}, []);

	// Roots can be switched on after this page loaded, and the selection is
	// seeded from whatever was enabled at the time — which may be nothing.
	useEffect(() => {
		if (!downloadRoots.some((root) => root.id === sourceRootId)) {
			setSourceRootId(downloadRoots[0]?.id ?? "");
		}
	}, [downloadRoots, sourceRootId]);

	useEffect(() => {
		if (!mediaRoots.some((root) => root.id === destinationRootId)) {
			setDestinationRootId(mediaRoots[0]?.id ?? "");
		}
	}, [mediaRoots, destinationRootId]);

	useEffect(() => {
		if (sourceRootId) void browse(sourceRootId, "");
	}, [sourceRootId, browse]);

	/**
	 * One effect over every input the plan depends on.
	 *
	 * This used to be a callback invoked from each handler, which meant the
	 * destination dropdown re-planned against the *previous* root — the
	 * dropdown's onChange fired before its setState had applied, so the plan
	 * on screen was not the plan Import would run. A preview that disagrees
	 * with the action is worse than no preview.
	 */
	useEffect(() => {
		if (!selected || !sourceRootId || !destinationRootId) {
			setPlan(null);
			return;
		}

		let cancelled = false;
		setBusy(true);

		previewImport({
			data: {
				sourceRootId,
				destinationRootId,
				path: selected,
				overrides: overrides as Record<string, Record<string, unknown>>,
			},
		})
			.then((result) => {
				if (cancelled) return;
				setPlan(result);
				setError(null);
			})
			.catch((previewError: unknown) => {
				if (cancelled) return;
				setPlan(null);
				setError(previewError instanceof Error ? previewError.message : "Could not plan that.");
			})
			.finally(() => {
				if (!cancelled) setBusy(false);
			});

		return () => {
			cancelled = true;
		};
	}, [selected, sourceRootId, destinationRootId, overrides]);

	function handleSelect(entry: BrowseEntry) {
		setSelected(entry.path);
		setSource(null);
		setOverrides({});
	}

	function handleSelectWaiting(download: WaitingDownload) {
		setSelected(download.rootRelativePath);
		setSource({ linkId: download.linkId, downloadId: download.downloadId });
		setOverrides({});
	}

	function handleOverride(videoPath: string, patch: ReleaseOverrides) {
		setOverrides((current) => ({
			...current,
			[videoPath]: { ...current[videoPath], ...patch },
		}));
	}

	async function handleImport() {
		if (!selected) return;
		setBusy(true);
		try {
			setError(null);
			await startImport({
				data: {
					sourceRootId,
					destinationRootId,
					path: selected,
					overrides: overrides as Record<string, Record<string, unknown>>,
					source: source ?? undefined,
				},
			});
			// Clear the selection: the plan on screen has been acted on, and
			// leaving it there invites a second click at a destination that is
			// now occupied.
			setSelected(null);
			setSource(null);
			setOverrides({});
			await Promise.all([refreshJobs(), refreshWaiting()]);
		} catch (importError) {
			setError(importError instanceof Error ? importError.message : "Could not start the import.");
		} finally {
			setBusy(false);
		}
	}

	async function toggleRoot(root: FsRoot) {
		const updated = await updateFilesRoot({ data: { id: root.id, enabled: !root.enabled } });
		setRoots((current) => current.map((item) => (item.id === updated.id ? updated : item)));
	}

	const importable =
		plan !== null &&
		plan.entries.length > 0 &&
		plan.entries.every((entry) => entry.problem === null);

	return (
		<main className="min-h-screen bg-abyss px-6 py-10 text-ink sm:px-8 lg:px-12">
			<div className="mx-auto max-w-6xl">
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div>
						<p className="text-xs font-semibold uppercase tracking-[0.35em] text-teal">Librarian</p>
						<h1 className="mt-3 font-display text-4xl leading-none">Organize downloads</h1>
						<p className="mt-3 max-w-2xl text-sm leading-6 text-ink-muted">
							Pick a finished download, check what Librarian worked out, correct anything it got
							wrong, then import. Nothing moves until you say so.
						</p>
					</div>
					<Link
						to="/"
						className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-ink"
					>
						Back to dashboard
					</Link>
				</div>

				{error ? (
					<div className="mt-6 rounded-2xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
						{error}
					</div>
				) : null}

				<RootsPanel
					roots={roots}
					onToggle={toggleRoot}
					onAdded={(root) => setRoots((c) => [...c, root])}
				/>

				<MappingsPanel hasEnabledRoots={roots.some((root) => root.enabled)} />

				<WaitingPanel
					waiting={waiting}
					errors={waitingErrors}
					onSelect={handleSelectWaiting}
					onDismiss={async (download) => {
						await dismissDownload({
							data: { linkId: download.linkId, downloadId: download.downloadId },
						});
						await refreshWaiting();
					}}
				/>

				{downloadRoots.length === 0 || mediaRoots.length === 0 ? (
					<p className="mt-8 rounded-2xl border border-white/10 bg-white/5 px-5 py-4 text-sm text-ink-muted">
						Turn on one downloads root and one media root above to start importing.
					</p>
				) : (
					<div className="mt-8 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
						<section className="min-w-0 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
							<div className="flex items-center justify-between gap-3">
								<h2 className="font-display text-2xl">Downloads</h2>
								<select
									aria-label="Downloads root"
									className="rounded-full border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
									value={sourceRootId}
									onChange={(event) => setSourceRootId(event.target.value)}
								>
									{downloadRoots.map((root) => (
										<option key={root.id} value={root.id}>
											{root.label}
										</option>
									))}
								</select>
							</div>

							<p className="mt-3 truncate text-xs text-ink-muted">/{browsePath}</p>

							<div className="mt-4 grid gap-2">
								{browsePath ? (
									<button
										type="button"
										className="rounded-xl border border-white/10 px-4 py-2 text-left text-sm text-ink-muted"
										onClick={() => void browse(sourceRootId, parentOf(browsePath))}
									>
										↑ Up a level
									</button>
								) : null}

								{entries.length === 0 ? (
									<p className="px-1 py-2 text-sm text-ink-muted">Nothing here.</p>
								) : null}

								{entries.map((entry) => (
									<div key={entry.path} className="flex items-center gap-2">
										<button
											type="button"
											className={`flex-1 truncate rounded-xl border px-4 py-2 text-left text-sm ${
												selected === entry.path
													? "border-teal/50 bg-teal/10 text-ink"
													: "border-white/10 bg-black/20 text-ink"
											}`}
											onClick={() => handleSelect(entry)}
										>
											{entry.kind === "directory" ? "📁" : entry.isVideo ? "🎬" : "📄"} {entry.name}
											{entry.bytes > 0 ? (
												<span className="ml-2 text-xs text-ink-muted">
													{formatBytes(entry.bytes)}
												</span>
											) : null}
										</button>
										{entry.kind === "directory" ? (
											<button
												type="button"
												aria-label={`Open ${entry.name}`}
												className="rounded-xl border border-white/10 px-3 py-2 text-sm text-ink-muted"
												onClick={() => void browse(sourceRootId, entry.path)}
											>
												→
											</button>
										) : null}
									</div>
								))}
							</div>
						</section>

						<section className="min-w-0 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
							<div className="flex items-center justify-between gap-3">
								<h2 className="font-display text-2xl">Import plan</h2>
								<select
									aria-label="Destination library"
									className="rounded-full border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
									value={destinationRootId}
									onChange={(event) => setDestinationRootId(event.target.value)}
								>
									{mediaRoots.map((root) => (
										<option key={root.id} value={root.id}>
											{root.label}
										</option>
									))}
								</select>
							</div>

							{plan === null ? (
								<p className="mt-4 text-sm text-ink-muted">
									Select a download on the left to see what would happen.
								</p>
							) : (
								<PlanView
									plan={plan}
									overrides={overrides}
									onOverride={handleOverride}
									busy={busy}
									importable={importable}
									onImport={handleImport}
								/>
							)}
						</section>
					</div>
				)}

				<JobsPanel
					jobs={jobs}
					onCancel={async (id) => {
						await cancelJob({ data: { id } });
						await refreshJobs();
					}}
				/>
			</div>
		</main>
	);
}

/**
 * SQLite's CURRENT_TIMESTAMP is UTC with no zone marker, which every JS engine
 * would otherwise read as local time.
 */
function formatTimestamp(value: string): string {
	const parsed = new Date(`${value.replace(" ", "T")}Z`);
	if (Number.isNaN(parsed.getTime())) return value;

	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
		parsed,
	);
}

function parentOf(value: string): string {
	const index = value.lastIndexOf("/");
	return index === -1 ? "" : value.slice(0, index);
}

function RootsPanel({
	roots,
	onToggle,
	onAdded,
}: {
	roots: FsRoot[];
	onToggle: (root: FsRoot) => Promise<void>;
	onAdded: (root: FsRoot) => void;
}) {
	const [adding, setAdding] = useState(false);
	const [path, setPath] = useState("");
	const [kind, setKind] = useState<"downloads" | "media">("downloads");
	const [label, setLabel] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function handleAdd(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		try {
			setError(null);
			onAdded(await createFilesRoot({ data: { label, kind, path } }));
			setAdding(false);
			setPath("");
			setLabel("");
		} catch (addError) {
			setError(addError instanceof Error ? addError.message : "Could not add that root.");
		}
	}

	return (
		<section className="mt-8 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
			<div className="flex items-center justify-between gap-3">
				<h2 className="font-display text-2xl">Roots</h2>
				<button
					type="button"
					className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-ink"
					onClick={() => setAdding((value) => !value)}
				>
					{adding ? "Cancel" : "Add a root"}
				</button>
			</div>

			<p className="mt-2 text-sm text-ink-muted">
				Directories Librarian may touch. A root does nothing until you turn it on.
			</p>

			{adding ? (
				<form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]" onSubmit={handleAdd}>
					<input
						aria-label="Root path"
						className="rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-ink"
						placeholder="/library/downloads/complete"
						value={path}
						onChange={(event) => setPath(event.target.value)}
					/>
					<input
						aria-label="Root label"
						className="rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-ink"
						placeholder="Label"
						value={label}
						onChange={(event) => setLabel(event.target.value)}
					/>
					<select
						aria-label="Root kind"
						className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
						value={kind}
						onChange={(event) => setKind(event.target.value as "downloads" | "media")}
					>
						<option value="downloads">Downloads</option>
						<option value="media">Media</option>
					</select>
					<button
						type="submit"
						className="rounded-xl bg-teal px-4 py-2 text-sm font-semibold text-abyss"
					>
						Add
					</button>
				</form>
			) : null}

			{error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}

			<div className="mt-4 grid gap-2">
				{roots.length === 0 ? (
					<p className="text-sm text-ink-muted">
						No roots yet. Set LIBRARIAN_DOWNLOADS_DIR and LIBRARIAN_MEDIA_DIR, or add one above.
					</p>
				) : null}

				{roots.map((root) => (
					<div
						key={root.id}
						className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3"
					>
						<div className="min-w-0">
							<p className="truncate text-sm font-semibold">
								{root.label}{" "}
								<span className="text-xs font-normal uppercase tracking-widest text-ink-muted">
									{root.kind}
								</span>
							</p>
							<p className="truncate text-xs text-ink-muted">{root.path}</p>
						</div>
						<div className="flex items-center gap-3">
							{!root.writable ? (
								<span className="rounded-full bg-coral/10 px-3 py-1 text-xs text-coral">
									read-only
								</span>
							) : null}
							<button
								type="button"
								onClick={() => void onToggle(root)}
								className={`rounded-full px-4 py-2 text-sm font-semibold ${
									root.enabled ? "bg-teal text-abyss" : "border border-white/10 bg-white/5 text-ink"
								}`}
							>
								{root.enabled ? "On" : "Off"}
							</button>
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function PlanView({
	plan,
	overrides,
	onOverride,
	busy,
	importable,
	onImport,
}: {
	plan: ImportPlan;
	overrides: Record<string, ReleaseOverrides>;
	onOverride: (videoPath: string, patch: ReleaseOverrides) => void;
	busy: boolean;
	importable: boolean;
	onImport: () => Promise<void>;
}) {
	return (
		<div className="mt-4">
			<div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm">
				<p className="font-semibold">{STRATEGY_BLURB[plan.strategy] ?? plan.strategy}</p>
				<p className="mt-1 text-xs text-ink-muted">
					{plan.entries.length} item{plan.entries.length === 1 ? "" : "s"} ·{" "}
					{formatBytes(plan.totalBytes)} · needs {formatBytes(plan.bytesNeeded)} ·{" "}
					{plan.availableBytes === null
						? "free space unknown"
						: `${formatBytes(plan.availableBytes)} free`}
				</p>
			</div>

			{plan.warnings.length > 0 ? (
				<ul className="mt-3 grid gap-2">
					{plan.warnings.map((warning) => (
						<li
							key={`${warning.code}-${warning.path ?? ""}`}
							className="rounded-xl border border-coral/20 bg-coral/5 px-4 py-2 text-xs text-coral"
						>
							{warning.path ? <span className="font-mono">{warning.path}: </span> : null}
							{warning.message}
						</li>
					))}
				</ul>
			) : null}

			<div className="mt-4 grid gap-3">
				{plan.entries.map((entry) => {
					const current = { ...entry.release, ...overrides[entry.video.from] };

					return (
						<div
							key={entry.video.from}
							className="min-w-0 rounded-2xl border border-white/10 bg-black/20 px-4 py-4"
						>
							<p className="truncate font-mono text-xs text-ink-muted">{entry.video.from}</p>
							<p className="mt-1 truncate font-mono text-xs text-teal">
								→ {entry.video.to ?? "— needs a title before it can be placed —"}
							</p>

							<div className="mt-3 grid gap-2 sm:grid-cols-4">
								<input
									aria-label="Title"
									className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink sm:col-span-2"
									placeholder="Title"
									defaultValue={current.title}
									onBlur={(event) => onOverride(entry.video.from, { title: event.target.value })}
								/>
								<input
									aria-label="Year"
									className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
									placeholder="Year"
									defaultValue={current.year ?? ""}
									onBlur={(event) =>
										onOverride(entry.video.from, {
											year: event.target.value ? Number(event.target.value) : null,
										})
									}
								/>
								<select
									aria-label="Kind"
									className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
									value={current.kind}
									onChange={(event) =>
										onOverride(entry.video.from, {
											kind: event.target.value as "movie" | "episode" | "unknown",
										})
									}
								>
									<option value="movie">Movie</option>
									<option value="episode">Episode</option>
									<option value="unknown">Unknown</option>
								</select>

								{current.kind === "episode" ? (
									<>
										<input
											aria-label="Season"
											className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
											placeholder="Season"
											defaultValue={current.season ?? ""}
											onBlur={(event) =>
												onOverride(entry.video.from, {
													season: event.target.value ? Number(event.target.value) : null,
												})
											}
										/>
										<input
											aria-label="Episode"
											className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink"
											placeholder="Episode"
											defaultValue={current.episode ?? ""}
											onBlur={(event) =>
												onOverride(entry.video.from, {
													episode: event.target.value ? Number(event.target.value) : null,
												})
											}
										/>
									</>
								) : null}
							</div>

							{entry.sidecars.length > 0 ? (
								<ul className="mt-3 grid gap-1">
									{entry.sidecars.map((sidecar) => (
										<li
											key={sidecar.from}
											className="truncate font-mono text-[11px] text-ink-muted"
										>
											+ {sidecar.to ?? sidecar.from}
										</li>
									))}
								</ul>
							) : null}
						</div>
					);
				})}
			</div>

			<button
				type="button"
				disabled={!importable || busy}
				onClick={() => void onImport()}
				className="mt-5 w-full rounded-2xl bg-coral px-5 py-3 text-base font-semibold text-abyss transition hover:bg-[#ff8787] disabled:cursor-not-allowed disabled:opacity-50"
			>
				{busy ? "Working…" : "Import"}
			</button>
		</div>
	);
}

function JobsPanel({ jobs, onCancel }: { jobs: Job[]; onCancel: (id: string) => Promise<void> }) {
	return (
		<section className="mt-8 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
			<h2 className="font-display text-2xl">Jobs</h2>

			{jobs.length === 0 ? (
				<p className="mt-3 text-sm text-ink-muted">Nothing has run yet.</p>
			) : (
				<div className="mt-4 grid gap-2">
					{jobs.map((job) => (
						<div
							key={job.id}
							className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3"
						>
							<div className="min-w-0">
								<p className="truncate text-sm font-semibold">{job.label}</p>
								<p className="truncate text-xs text-ink-muted">
									{job.error ?? job.details ?? job.status}
									{job.totalBytes > 0
										? ` · ${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}`
										: ""}
								</p>
							</div>
							<div className="flex items-center gap-3">
								<span
									className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-widest ${
										job.status === "failed"
											? "bg-coral/15 text-coral"
											: job.status === "completed"
												? "bg-teal/15 text-teal"
												: "bg-white/10 text-ink-muted"
									}`}
								>
									{job.status}
								</span>
								{job.status === "queued" || job.status === "running" ? (
									<button
										type="button"
										className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-muted"
										onClick={() => void onCancel(job.id)}
									>
										Cancel
									</button>
								) : null}
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

/**
 * Path mappings only matter when Jellyfin and Librarian disagree about where
 * a directory is, so the panel leads with whether they agree at all.
 */
function MappingsPanel({ hasEnabledRoots }: { hasEnabledRoots: boolean }) {
	const [mappings, setMappings] = useState<PathMapping[]>([]);
	const [suggestions, setSuggestions] = useState<MappingSuggestion[]>([]);
	const [outcomes, setOutcomes] = useState<Record<string, VerificationOutcome>>({});
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const result = await fetchMappings();
			setMappings(result.mappings);
			setSuggestions(result.suggestions);
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : "Could not read path mappings.");
		}
	}, []);

	useEffect(() => {
		if (hasEnabledRoots) void load();
	}, [hasEnabledRoots, load]);

	// A suggestion that has been taken up is no longer a suggestion.
	const needed = suggestions.filter(
		(suggestion) =>
			!suggestion.aligned &&
			!mappings.some((mapping) => mapping.remotePrefix === suggestion.remotePrefix),
	);
	const aligned = suggestions.length > 0 && needed.length === 0;

	async function addSuggestion(suggestion: MappingSuggestion) {
		setBusy(true);
		try {
			setError(null);
			await createMappingFn({
				data: { remotePrefix: suggestion.remotePrefix, localPrefix: suggestion.localPrefix },
			});
			await load();
		} catch (addError) {
			setError(addError instanceof Error ? addError.message : "Could not add that mapping.");
		} finally {
			setBusy(false);
		}
	}

	async function verify() {
		setBusy(true);
		try {
			setError(null);
			const result = await verifyMappingsFn();
			setOutcomes(result.outcomes);
			setMappings(result.mappings);
		} catch (verifyError) {
			setError(verifyError instanceof Error ? verifyError.message : "Could not verify.");
		} finally {
			setBusy(false);
		}
	}

	if (!hasEnabledRoots) return null;

	return (
		<section className="mt-6 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="font-display text-2xl">Jellyfin paths</h2>
				<div className="flex items-center gap-2">
					{mappings.length > 0 ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => void verify()}
							className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
						>
							Verify
						</button>
					) : null}
					<button
						type="button"
						onClick={() => setOpen((value) => !value)}
						className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-ink"
					>
						{open ? "Hide" : "Details"}
					</button>
				</div>
			</div>

			{aligned && mappings.length === 0 ? (
				<p className="mt-2 text-sm text-teal">
					Jellyfin and Librarian see the same paths. No mapping needed.
				</p>
			) : (
				<p className="mt-2 text-sm text-ink-muted">
					{needed.length > 0
						? `${needed.length} Jellyfin ${needed.length === 1 ? "location sits" : "locations sit"} somewhere else on this machine.`
						: "Where Jellyfin's paths differ from Librarian's."}
				</p>
			)}

			{error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}

			{open ? (
				<div className="mt-4 grid gap-4">
					{needed.length > 0 ? (
						<div className="grid gap-2">
							<p className="text-xs font-semibold uppercase tracking-widest text-ink-muted">
								Suggested
							</p>
							{needed.map((suggestion) => (
								<div
									key={suggestion.remotePrefix}
									className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3"
								>
									<div className="min-w-0">
										<p className="truncate font-mono text-xs text-ink-muted">
											{suggestion.remotePrefix}
										</p>
										<p className="truncate font-mono text-xs text-teal">
											→ {suggestion.localPrefix}
										</p>
									</div>
									<button
										type="button"
										disabled={busy}
										onClick={() => void addSuggestion(suggestion)}
										className="rounded-full bg-teal px-4 py-2 text-sm font-semibold text-abyss disabled:opacity-50"
									>
										Add
									</button>
								</div>
							))}
						</div>
					) : null}

					<div className="grid gap-2">
						<p className="text-xs font-semibold uppercase tracking-widest text-ink-muted">In use</p>
						{mappings.length === 0 ? (
							<p className="text-sm text-ink-muted">None, which is the ideal.</p>
						) : null}
						{mappings.map((mapping) => {
							const outcome = outcomes[mapping.id];

							return (
								<div
									key={mapping.id}
									className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3"
								>
									<div className="min-w-0">
										<p className="truncate font-mono text-xs text-ink-muted">
											{mapping.remotePrefix} → {mapping.localPrefix}
										</p>
										<p
											className={`truncate text-xs ${
												outcome?.status === "unverified" ? "text-coral" : "text-ink-muted"
											}`}
										>
											{outcome?.status === "unverified"
												? outcome.reason
												: mapping.verifiedAt
													? `Verified ${formatTimestamp(mapping.verifiedAt)}`
													: "Not verified yet."}
										</p>
									</div>
									<button
										type="button"
										disabled={busy}
										onClick={async () => {
											await deleteMappingFn({ data: { id: mapping.id } });
											await load();
										}}
										className="rounded-full border border-white/10 px-3 py-1 text-xs text-ink-muted disabled:opacity-50"
									>
										Remove
									</button>
								</div>
							);
						})}
					</div>
				</div>
			) : null}
		</section>
	);
}

/**
 * Finished downloads a connected module is holding that have not been
 * imported yet.
 *
 * Hidden entirely when there is nothing waiting, so a Librarian with no
 * connections looks exactly as it did before. Nothing here imports on its
 * own: selecting one fills in the plan on the right, which still has to be
 * read and confirmed.
 */
function WaitingPanel({
	waiting,
	errors,
	onSelect,
	onDismiss,
}: {
	waiting: WaitingDownload[];
	errors: string[];
	onSelect: (download: WaitingDownload) => void;
	onDismiss: (download: WaitingDownload) => Promise<void>;
}) {
	if (waiting.length === 0 && errors.length === 0) return null;

	return (
		<section className="mt-6 rounded-[2rem] border border-teal/20 bg-teal/[0.04] p-6">
			<h2 className="font-display text-2xl">
				{waiting.length > 0
					? `${waiting.length} finished download${waiting.length === 1 ? "" : "s"} waiting`
					: "Connected downloads"}
			</h2>

			{errors.map((message) => (
				<p key={message} className="mt-2 text-sm text-coral">
					{message}
				</p>
			))}

			<div className="mt-4 grid gap-2">
				{waiting.map((download) => (
					<div
						key={`${download.linkId}:${download.downloadId}`}
						className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3"
					>
						<div className="min-w-0">
							<p className="truncate text-sm font-semibold">{download.name}</p>
							<p className="truncate text-xs text-ink-muted">
								{download.moduleName} · {formatBytes(download.bytes)} ·{" "}
								<span className="font-mono">{download.rootRelativePath}</span>
							</p>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => onSelect(download)}
								className="rounded-full bg-teal px-4 py-2 text-sm font-semibold text-abyss"
							>
								Plan import
							</button>
							<button
								type="button"
								onClick={() => void onDismiss(download)}
								className="rounded-full border border-white/10 px-3 py-2 text-xs text-ink-muted"
							>
								Not this one
							</button>
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
