import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
	component: Home,
})

function Home() {
	return (
		<main className="min-h-screen bg-abyss text-ink flex items-center justify-center">
			<div className="text-center">
				<div className="text-6xl mb-4">🪸</div>
				<h1 className="text-4xl font-bold mb-2">Coral Module</h1>
				<p className="text-ink-muted">Ready to build.</p>
			</div>
		</main>
	)
}
