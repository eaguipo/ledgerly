# services/

Backend microservices (TypeScript + Fastify), added from **Phase B** onward.
Each is an independent HTTP service, containerized, and deployed as an aliased
instance of `deploy/helm/charts/service`.

Planned (see [../docs/INFRA.md](../docs/INFRA.md)):

| Service | Owns (Supabase schema) | Responsibility |
|---------|------------------------|----------------|
| `api-gateway` | — | validates Supabase JWT, routes to services, rate-limits |
| `ledger` | `ledger` | income + daily expenses |
| `portfolio` | `portfolio` | accounts, balances, transfers |
| `debt` | `debt` | debts / repayments |
| `goal` | `goal` | savings goals |
| `reporting` | (read views) | date-range reports & analytics |
| `currency` | `currency` | FX rates (external API + cache) |
| `notification` | — | worker; consumes NATS events (budget alerts, reminders) |
