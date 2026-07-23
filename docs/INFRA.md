# Infrastructure — Docker + Kubernetes (local microservice mesh)

This document describes the container/Kubernetes setup for running Ledgerly as a
local microservice mesh. It's a **learning-focused** architecture: it runs on a
local k3d cluster on your Mac at zero cloud cost, and keeps **managed Supabase**
as the database + auth so we don't rebuild those.

> Reality check: for the product itself, Vercel + Supabase is the better way to
> ship. This mesh exists to practice Docker, Kubernetes, Helm, and microservice
> patterns — not because a finance MVP needs a cluster. `main` stays
> Vercel-deployable; this lives on the `infra/docker-k8s-microservices` branch.

## Repo layout (monorepo)

```
personal-finance-tracker/
├── apps/
│   └── web/                 ← Next.js 16 frontend / BFF (was finance-app/)
│       ├── Dockerfile       ← prod image (Next standalone output)
│       └── Dockerfile.dev   ← dev image (next dev + Tilt live_update)
├── services/                ← backend microservices (Phase B onward)
├── libs/                    ← shared TS libraries (Phase C onward)
├── deploy/
│   ├── k3d/cluster.yaml     ← local cluster definition
│   └── helm/
│       ├── charts/service/  ← reusable generic HTTP-service chart
│       └── ledgerly/        ← umbrella chart (one aliased instance per service)
├── db/                      ← Supabase SQL (schema / policies / seed)
├── Tiltfile                 ← live-reload dev loop
└── Makefile                 ← workflow shortcuts (run `make`)
```

## Target architecture

```
Browser → ingress-nginx (:8080) → web (Next.js BFF)
                                     └→ api-gateway (validates Supabase JWT)
                                          ├→ ledger      (schema: ledger)
                                          ├→ portfolio   (schema: portfolio)
                                          ├→ debt        (schema: debt)
                                          ├→ goal        (schema: goal)
                                          ├→ reporting   (read views)
                                          ├→ currency    (external FX + cache)
                                          └→ notification (worker, consumes events)
                                     events ↔ NATS      cache ↔ Redis
All services share ONE managed Supabase Postgres, but each OWNS its own schema
(database-per-service, pragmatically). Auth stays with Supabase (GoTrue JWT).
```

**Key patterns**
- **Schema-per-service** on the single managed Supabase Postgres — bounded
  contexts without paying for N databases. No cross-schema joins; cross-service
  data goes through APIs or events.
- **Auth**: Supabase issues the JWT; the api-gateway validates it (JWKS) and
  passes `user_id` downstream. Services trust the gateway (NetworkPolicy).
- **RLS caveat**: services using the service-role key bypass Row Level Security,
  so each service must enforce its own `user_id` filter.
- **Async**: NATS event bus (e.g. `expense.created` → reporting + notification).

## Prerequisites

Installed via Homebrew (`make prereqs`):

| Tool | Role |
|------|------|
| colima + docker | container runtime (free Docker Desktop alternative) |
| k3d | k3s-in-Docker local cluster |
| kubectl | cluster CLI |
| helm | package/deploy manifests (v4) |
| tilt | live-reload dev loop |

Node 20+ is required for the web app (`nvm use 20`; shell defaults to 18).

## Quickstart

```bash
make prereqs                 # one-time: install the toolchain
make hosts                   # one-time: add ledgerly.local + registry to /etc/hosts (sudo)
make cluster-up              # start colima, create k3d cluster, install ingress-nginx
make dev                     # Tilt: build image, deploy chart, live-reload

# open the app
open http://ledgerly.local:8080
```

`make dev` (Tilt) reads your Supabase creds from `apps/web/.env.local` — the same
file the app already uses — so there's a single source of truth. Without Tilt,
copy `deploy/helm/ledgerly/values.local.yaml.example` → `values.local.yaml`, fill
it in, and run `make deploy`.

### Useful targets

```bash
make status        # pods / services / ingress
make logs          # tail web logs
make template      # render manifests (no cluster needed)
make lint          # helm lint
make cluster-down  # delete the cluster
```

## How images reach the cluster

The k3d cluster creates a registry at `k3d-registry.localhost:5000` reachable by
the **same name** from both your Mac and inside the cluster (that's why `make
hosts` adds it to `/etc/hosts`). Tilt builds `ledgerly-web` and pushes it there;
the Deployment pulls from the same ref.

- **Dev** (`Dockerfile.dev`): runs `next dev`; Tilt syncs `apps/web/src` into the
  running container for HMR. `NEXT_PUBLIC_*` come from container env at runtime.
- **Prod** (`Dockerfile`): multi-stage build of Next's `standalone` output.
  `NEXT_PUBLIC_*` are **inlined at build time**, so they're passed as
  `--build-arg`, while `SUPABASE_SERVICE_ROLE_KEY` stays a runtime Secret.

## The reusable `service` chart

Every service is an instance of `deploy/helm/charts/service` (Deployment +
Service + optional Ingress/HPA/ConfigMap/Secret). To add a service:

1. Add an aliased dependency in `deploy/helm/ledgerly/Chart.yaml`:
   ```yaml
   - name: service
     alias: ledger
     version: "0.1.0"
     repository: "file://../charts/service"
   ```
2. Add a `ledger:` block in `values.yaml` (image, env, ingress…).
3. `make helm-deps && make deploy` (or `make dev`).

When duplication across service values grows, refactor the shared bits into a
Helm **library chart** — a good future exercise.

## Troubleshooting

- **`ledgerly.local` won't resolve** → run `make hosts`.
- **ImagePullBackOff for `k3d-registry.localhost:5000/...`** → the registry host
  isn't in `/etc/hosts` (`make hosts`) or the cluster wasn't created from
  `deploy/k3d/cluster.yaml`.
- **App 500s on Supabase** → `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` weren't
  provided; check `apps/web/.env.local` (Tilt) or `values.local.yaml` (Helm).
- **colima slow/OOM** → `colima stop && colima start --cpu 4 --memory 8`.

## Roadmap

- **A — Foundation** ✅ monorepo, Dockerized web, k3d + ingress, Helm umbrella, Tilt.
- **B — Gateway + first service** — api-gateway (JWT validation) + ledger-service.
- **C — Fan out** — portfolio / debt / goal / currency services + shared libs.
- **D — Async** — NATS event bus, reporting + notification workers.
- **E — Ops** — probes/HPA, Prometheus + Grafana + Loki, GitHub Actions CI.
