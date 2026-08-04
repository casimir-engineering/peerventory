# Deployment behind an existing reverse proxy (Nginx Proxy Manager etc.)

Use this variant when the VPS already runs a reverse proxy that owns ports
80/443 (e.g. Nginx Proxy Manager). The container exposes no public ports; the
proxy forwards `inventory.example.com` to the `inventory` container on port
8787 over a shared Docker network (websocket support must be enabled on the
proxy host).

Install the stack at `/opt/stacks/inventory`, then create its environment file:

```sh
cd /opt/stacks/inventory
cat > .env <<'EOF'
ANTHROPIC_API_KEY=replace-with-your-api-key
# Optional; defaults to claude-sonnet-4-5
ANTHROPIC_MODEL=claude-sonnet-4-5
EOF
docker compose up -d
```

Leaving `ANTHROPIC_API_KEY` unset keeps sync and blob storage available, but the
AI analysis endpoint returns `503 { "error": "ai-not-configured" }`.

Build the PWA with the public origin baked in (share links and the APK use it):

```sh
cd app && VITE_SERVER_ORIGIN=https://inventory.example.com npm run build
```
