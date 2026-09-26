// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let tree: string;
let jobs: typeof import("./jobs");
let roots: typeof import("./files/roots");

beforeEach(async () => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-jobs-"));
	tree = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "librarian-jobtree-")));
	process.env.LIBRARIAN_DATA_DIR = dataDir;
	vi.resetModules();
	jobs = await import("./jobs");
	roots = await import("./files/roots");
});

afterEach(() => {
	delete process.env.LIBRARIAN_DATA_DIR;
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(tree, { recursive: true, force: true });
});

describe("the queue", () => {
	it("runs a job and records that it finished", async () => {
		const seen: string[] = [];
		jobs.registerJobHandler("test", async (context) => {
			seen.push(String(context.payload));
		});

		const job = jobs.enqueueJob({ kind: "test", label: "Test", payload: "hello" });
		await jobs.whenIdle();

		expect(seen).toEqual(["hello"]);
		expect(jobs.getJob(job.id)).toMatchObject({ status: "completed", error: null });
		expect(jobs.getJob(job.id)?.completedAt).not.toBeNull();
	});

	it("runs one at a time, in the order they arrived", async () => {
		const order: string[] = [];
		let inFlight = 0;

		jobs.registerJobHandler("serial", async (context) => {
			inFlight++;
			expect(inFlight).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push(String(context.payload));
			inFlight--;
		});

		jobs.enqueueJob({ kind: "serial", label: "A", payload: "a" });
		jobs.enqueueJob({ kind: "serial", label: "B", payload: "b" });
		jobs.enqueueJob({ kind: "serial", label: "C", payload: "c" });
		await jobs.whenIdle();

		expect(order).toEqual(["a", "b", "c"]);
	});

	it("records why a job failed without taking the queue down with it", async () => {
		jobs.registerJobHandler("boom", async () => {
			throw new Error("the disk went away");
		});
		jobs.registerJobHandler("fine", async () => {});

		const bad = jobs.enqueueJob({ kind: "boom", label: "Bad" });
		const good = jobs.enqueueJob({ kind: "fine", label: "Good" });
		await jobs.whenIdle();

		expect(jobs.getJob(bad.id)).toMatchObject({ status: "failed", error: "the disk went away" });
		expect(jobs.getJob(good.id)?.status).toBe("completed");
	});

	it("fails a job whose kind nobody handles", async () => {
		const job = jobs.enqueueJob({ kind: "unknown", label: "Orphan" });
		await jobs.whenIdle();

		expect(jobs.getJob(job.id)?.error).toMatch(/no handler/i);
	});

	it("reports progress as it goes", async () => {
		jobs.registerJobHandler("progress", async (context) => {
			context.report({ totalBytes: 100, doneBytes: 50, details: "Halfway" });
			expect(jobs.getJob(context.id)).toMatchObject({ doneBytes: 50, details: "Halfway" });
			context.report({ doneBytes: 100 });
		});

		const job = jobs.enqueueJob({ kind: "progress", label: "Progress" });
		await jobs.whenIdle();

		expect(jobs.getJob(job.id)).toMatchObject({ doneBytes: 100, totalBytes: 100 });
	});

	it("stops a running job at its next checkpoint", async () => {
		const steps: number[] = [];
		jobs.registerJobHandler("cancellable", async (context) => {
			for (let step = 0; step < 5; step++) {
				context.checkpoint();
				steps.push(step);
				if (step === 1) jobs.requestCancel(context.id);
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		});

		const job = jobs.enqueueJob({ kind: "cancellable", label: "Cancellable" });
		await jobs.whenIdle();

		expect(steps).toEqual([0, 1]);
		expect(jobs.getJob(job.id)?.status).toBe("cancelled");
	});

	it("cancels a job that never started outright", async () => {
		jobs.registerJobHandler("slow", async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		jobs.enqueueJob({ kind: "slow", label: "First" });
		const queued = jobs.enqueueJob({ kind: "slow", label: "Second" });
		jobs.requestCancel(queued.id);
		await jobs.whenIdle();

		expect(jobs.getJob(queued.id)?.status).toBe("cancelled");
	});
});

describe("recoverJobsAtBoot", () => {
	it("fails a job that was running when the process died", async () => {
		jobs.registerJobHandler("stall", async (context) => {
			// Leave it looking busy, as a crash would.
			expect(jobs.getJob(context.id)?.status).toBe("running");
		});
		const job = jobs.enqueueJob({ kind: "stall", label: "Stalled" });
		await jobs.whenIdle();

		// Put the row back the way a crash would have left it.
		jobs.enqueueJob({ kind: "stall", label: "Other" });
		await jobs.whenIdle();
		const handle = (await import("./config-store")).getAppDatabase();
		handle.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job.id);

		const result = jobs.recoverJobsAtBoot();

		expect(result.failed).toBe(1);
		expect(jobs.getJob(job.id)).toMatchObject({
			status: "failed",
			error: "Interrupted by a restart.",
		});
	});

	it("sweeps partial files left under an enabled root", () => {
		const root = roots.createRoot({ label: "Media", kind: "media", path: tree });
		roots.updateRoot(root.id, { enabled: true });

		fs.mkdirSync(path.join(tree, "Show/Season 01"), { recursive: true });
		const partial = path.join(tree, "Show/Season 01/episode.mkv.coral-partial");
		const real = path.join(tree, "Show/Season 01/episode.mkv");
		fs.writeFileSync(partial, "half");
		fs.writeFileSync(real, "whole");

		const result = jobs.recoverJobsAtBoot();

		expect(result.sweptPartials).toEqual([partial]);
		expect(fs.existsSync(partial)).toBe(false);
		expect(fs.existsSync(real)).toBe(true);
	});

	it("leaves roots nobody enabled alone", () => {
		roots.createRoot({ label: "Media", kind: "media", path: tree });
		const partial = path.join(tree, "x.mkv.coral-partial");
		fs.writeFileSync(partial, "half");

		jobs.recoverJobsAtBoot();

		expect(fs.existsSync(partial)).toBe(true);
	});

	it("keeps the handler's last word when the job finishes", async () => {
		jobs.registerJobHandler("chatty", async (context) => {
			context.report({ details: "Imported 3 files. Jellyfin scan requested." });
		});

		const job = jobs.enqueueJob({ kind: "chatty", label: "Chatty" });
		await jobs.whenIdle();

		// Completing must not erase the summary the operator needs to read.
		expect(jobs.getJob(job.id)?.details).toBe("Imported 3 files. Jellyfin scan requested.");
	});
});
