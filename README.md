# Librarian

> A [Coral](https://getcoral.dev) module for organizing, enriching, and maintaining self-hosted media libraries.

---

## Getting started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start developing

```bash
pnpm dev
```

App runs at `http://localhost:3000`.

If `JELLYFIN_URL`, `JELLYFIN_API_KEY`, and `JELLYFIN_USER_ID` are present in your environment, Librarian skips setup and connects immediately. Otherwise it will open `/setup` and store the connection details in local SQLite under `./data/librarian.sqlite`.

---

## Product direction

Librarian is the Coral module focused on media hygiene and enrichment:

- Scan a library for missing or inconsistent metadata
- Flag duplicates, poster gaps, and low-quality assets
- Queue background jobs for renaming, tagging, and enrichment
- Prepare media for downstream Coral modules while keeping Jellyfin as the source of truth

The current repo contains the first product shell and landing experience for that workflow.

## Local storage

- Default database path: `./data/librarian.sqlite`
- Override with: `LIBRARIAN_DATA_DIR=/path/to/data`
- Main use today: persisted Jellyfin connection details when env vars are not provided

---

## Stack

| Tool | Purpose |
|------|---------|
| [TanStack Start](https://tanstack.com/start) | Full-stack React framework |
| [TanStack Router](https://tanstack.com/router) | Type-safe file-based routing |
| [TanStack Query](https://tanstack.com/query) | Server state management |
| [Tailwind v4](https://tailwindcss.com) | Styling |
| [Biome](https://biomejs.dev) | Linting & formatting |
| [@get-coral/jellyfin](https://github.com/Get-Coral/jellyfin) | Jellyfin API client |
| [Vitest](https://vitest.dev) | Testing |

---

## Scripts

```bash
pnpm dev        # Start dev server on :3000
pnpm build      # Production build
pnpm start      # Run production server
pnpm typecheck  # TypeScript check
pnpm check      # Biome lint + format check
pnpm lint       # Biome lint with auto-fix
pnpm test       # Run tests
```

---

## Docker

```bash
# Build
docker build -t librarian .

# Run
docker run -p 3000:3000 \
  -e JELLYFIN_URL=http://your-nas:8096 \
  -e JELLYFIN_API_KEY=your-key \
  -e JELLYFIN_USER_ID=your-user-id \
  librarian
```

Published automatically to `ghcr.io/get-coral/<module-name>` on every release via GitHub Actions.

---

## CI / CD

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | Every PR + push to main | Typecheck, lint, test, build, Docker build check |
| `docker-publish.yml` | Push to main + version tags | Publishes to GHCR |
| `release-please.yml` | Push to main | Opens release PR, publishes Docker on merge |

Releases are fully automated via [Release Please](https://github.com/googleapis/release-please). Use conventional commits:

| Commit prefix | Version bump |
|--------------|-------------|
| `feat:` | Minor |
| `fix:` | Patch |
| `feat!:` / `fix!:` | Major |
| `chore:`, `docs:` | No bump |

---

## Part of Coral

This module is part of the [Coral](https://getcoral.dev) ecosystem. See the [contributing guide](https://github.com/Get-Coral/.github/blob/main/CONTRIBUTING.md) before opening PRs.
