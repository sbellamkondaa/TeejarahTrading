# Production Branch Strategy

This document records how production was restored to the original TradeTally
fork baseline while preserving all Teejarah development work in Git.

## Branch / Tag Layout

| Reference | Type | Commit | Purpose |
|---|---|---|---|
| `feature/data-plane-foundation` | branch | `4bedbfa1` (and forward) | All Teejarah development (milestones 1-7h). Unchanged and still authoritative for Teejarah work. |
| `archive/teejarah-2026-09-09` | branch | `4bedbfa1` | Immutable snapshot of Teejarah state at the moment production was restored to TradeTally. |
| `teejarah-before-tradetally-production-restore-2026-09-09` | annotated tag | `4bedbfa1` | Annotated marker of the same snapshot. |
| `production/tradetally` | branch | `49c3e3d4` | Clean production branch forked directly from the original TradeTally fork baseline. Contains NO Teejarah commits. |

### Original TradeTally baseline

- Commit: `49c3e3d4` — "Add iOS universal link support" (GeneBO98, 2026-09-01)
- Determined via `git merge-base feature/data-plane-foundation main` and confirmed
  as a direct ancestor of the Teejarah dev branch. The 88 commits that follow it
  on `feature/data-plane-foundation` are all Teejarah-specific (rebranding, Schwab,
  Redis, scanner, trading automation, PAPER broker, MCP, etc.).

## Database safety

All Teejarah migrations (`258`-`271`) are additive (CREATE TABLE / ADD COLUMN).
The only non-`CREATE` statement is in migration `265`, which replaces a `CHECK`
constraint on the Teejarah-specific `trade_proposals` table (added in `261`) —
it does not touch any original TradeTally schema object.

The original TradeTally application ignores all Teejarah tables. No destructive
rollback is required or performed. PostgreSQL data and volumes are preserved.

## Minimal production stack (original TradeTally)

The baseline `docker-compose.yaml` defines only:

- `tradetally-db` (PostgreSQL) — keep existing volume
- `tradetally-app` (app) — built from `production/tradetally`

The baseline has NO Redis and NO worker. Teejarah-only services to stop (volumes
preserved):

- `teejarah-worker`
- `teejarah-redis`

`teejarah-cloudflared` is retained because it fronts `journal.teejarah.com`.

## Production switch procedure (already performed the Git portion)

1. Archive + tag + production branch were pushed to `origin` (non-destructive,
   no force push).
2. On the production host at `/opt/teejarah/app`:
   - `git status` (confirm clean)
   - `git fetch origin`
   - `git checkout production/tradetally` (track it)
3. Stop Teejarah-only containers (keep volumes):
   - `docker stop teejarah-worker teejarah-redis`
   - Do NOT `docker rm -v`, `docker volume prune`, or `docker system prune`.
4. Rebuild + deploy `tradetally-app` using the baseline `docker-compose.yaml`
   only (no Teejarah `production`/`redis` overlays):
   - `docker compose -f docker-compose.yaml up -d --build app postgres`
   - Keep `teejarah-cloudflared` running for HTTPS.
5. Validate `https://journal.teejarah.com` (login, dashboard, trades, import).

## How to restore Teejarah later

1. Back up the production database.
2. On the production host: `git fetch origin && git checkout feature/data-plane-foundation`
   (or a future Teejarah release branch).
3. Deploy the full Teejarah compose stack with overlays:
   `docker-compose.yaml`, `docker-compose.production.yaml`,
   `docker-compose.redis.yaml`.
4. Run any additive Teejarah migrations not yet applied (258-271 are idempotent
   and safe to re-run).
5. Start `teejarah-worker` and `teejarah-redis`:
   `docker start teejarah-redis teejarah-worker` (volumes intact).
6. Validate `https://journal.teejarah.com` and Teejarah features.

No Git history rewrite, force push, or data deletion is part of either
direction. All changes are reversible by switching branches and toggling
Teejarah-only containers.
