import { CoralErrorState } from "@get-coral/ui";
import { createRootRoute, HeadContent, Outlet, Scripts, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import "@get-coral/ui/styles.css";
import "#/styles.css";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Librarian | Coral" },
			{
				name: "description",
				content: "Organize, enrich, and maintain your Jellyfin library with Coral Librarian.",
			},
		],
	}),
	component: RootComponent,
	errorComponent: RootErrorPage,
	notFoundComponent: RootNotFoundPage,
});

function RootComponent() {
	return (
		<RootDocument>
			<Outlet />
		</RootDocument>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}

function RootErrorPage({ error, reset }: { error: Error; reset: () => void }) {
	const router = useRouter();

	function handleRetry() {
		reset();
		void router.invalidate();
	}

	return (
		<RootStateLayout>
			<CoralErrorState
				eyebrow="Librarian"
				title="Something went wrong"
				description={error?.message ?? "An unexpected error happened while loading this route."}
				primaryAction={{ label: "Try again", onClick: handleRetry }}
				secondaryAction={{ label: "Back home", href: "/", variant: "neutral" }}
			/>
		</RootStateLayout>
	);
}

function RootNotFoundPage() {
	return (
		<RootStateLayout>
			<CoralErrorState
				code="404"
				title="Page not found"
				description="The page you are looking for does not exist or has moved."
				primaryAction={{ label: "Back home", href: "/" }}
			/>
		</RootStateLayout>
	);
}

function RootStateLayout({ children }: { children: ReactNode }) {
	return <main className="min-h-screen bg-abyss">{children}</main>;
}
