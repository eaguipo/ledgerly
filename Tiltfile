# -*- mode: Python -*-
# Ledgerly local dev loop.
#   tilt up        → build images, deploy the umbrella chart, live-reload source
#   tilt down      → tear the release down
#
# Runs the web app in DEV mode (next dev) inside the cluster with HMR: source is
# synced into the container instead of rebuilt. Supabase creds are read from
# apps/web/.env.local so there's a single source of truth.

allow_k8s_contexts('k3d-ledgerly')

# ── read Supabase creds from apps/web/.env.local ─────────────────────────────
def load_dotenv(path):
    env = {}
    if not os.path.exists(path):
        warn('%s not found — Supabase calls will fail until you create it (cp apps/web/.env.example apps/web/.env.local)' % path)
        return env
    for line in str(read_file(path)).splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env

creds = load_dotenv('apps/web/.env.local')
supa_url = creds.get('NEXT_PUBLIC_SUPABASE_URL', '')
supa_anon = creds.get('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
supa_service = creds.get('SUPABASE_SERVICE_ROLE_KEY', '')
if not supa_url or not supa_anon:
    warn('NEXT_PUBLIC_SUPABASE_URL / ANON_KEY missing from apps/web/.env.local')

# ── namespace ────────────────────────────────────────────────────────────────
k8s_yaml(blob("""
apiVersion: v1
kind: Namespace
metadata:
  name: ledgerly
"""))

# ── images pushed to the k3d-managed local registry ──────────────────────────
default_registry('k3d-registry.localhost:5000')

# Web (dev image, live_update). next dev reads NEXT_PUBLIC_* from container env
# at runtime, so we pass them through the chart rather than as build args here.
docker_build(
    'ledgerly-web',
    context='apps/web',
    dockerfile='apps/web/Dockerfile.dev',
    live_update=[
        sync('apps/web/src', '/app/src'),
        sync('apps/web/public', '/app/public'),
        run('cd /app && npm ci',
            trigger=['apps/web/package.json', 'apps/web/package-lock.json']),
    ],
)

# ── deploy the umbrella chart ────────────────────────────────────────────────
k8s_yaml(helm(
    'deploy/helm/ledgerly',
    name='ledgerly',
    namespace='ledgerly',
    values=['deploy/helm/ledgerly/values.yaml'],
    set=[
        'web.image.repository=ledgerly-web',
        'web.image.tag=dev',
        'web.env.NEXT_PUBLIC_SUPABASE_URL=' + supa_url,
        'web.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=' + supa_anon,
        'web.secretEnv.SUPABASE_SERVICE_ROLE_KEY=' + supa_service,
    ],
))

k8s_resource('web', port_forwards=['3000:3000'], labels=['frontend'])

print('Ledgerly: open http://ledgerly.local:8080 (ingress) or http://localhost:3000 (port-forward)')
