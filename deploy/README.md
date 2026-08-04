# VPS deployment

The deployment has two containers: Caddy serves `app/dist` and terminates TLS,
while the Node service handles `/sync` and `/api/*`. Persistent Yjs documents,
token hashes, blob references, and blob files live in the `server_data` Docker
volume.

## 1. Prepare DNS and the VPS

Create an `A` record (and an `AAAA` record if the VPS has working IPv6) for the
inventory hostname, pointing to the VPS. Allow inbound TCP ports 80 and 443 in
the VPS firewall/security group. Install Docker Engine with the Compose plugin.

## 2. Build the PWA locally

From the repository:

```sh
cd app
npm ci
npm run build
cd ..
```

This must produce `app/dist/index.html`.

## 3. Copy the deployment to the VPS

Replace the example user, host, and local path:

```sh
ssh deploy@example.com 'sudo mkdir -p /opt/inventory-app && sudo chown "$USER" /opt/inventory-app'
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'server/data' \
  /path/to/inventory-app/ deploy@example.com:/opt/inventory-app/
```

The upload must include `server/`, `deploy/`, and `app/dist/`.

## 4. Configure and start

On the VPS:

```sh
ssh deploy@example.com
cd /opt/inventory-app
cat > .env <<'EOF'
INVENTORY_HOST=inventory.example.com
ANTHROPIC_API_KEY=replace-with-your-api-key
# Optional; defaults to claude-sonnet-4-5
ANTHROPIC_MODEL=claude-sonnet-4-5
EOF
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
docker compose --env-file .env -f deploy/docker-compose.yml ps
curl https://inventory.example.com/api/health
```

`ANTHROPIC_API_KEY` enables `POST /api/ai/analyze`. If it is omitted or empty,
the rest of the sync server continues to work and that endpoint returns
`503 { "error": "ai-not-configured" }`.

For subsequent releases, rebuild `app/dist`, repeat the `rsync`, and run the
same `docker compose ... up -d --build` command.

Caddy obtains and renews a Let's Encrypt certificate automatically, then serves
HTTPS on 443. WebSocket upgrades require no extra Caddy directives. Using normal
HTTPS/WSS on 443 makes this deployment look like ordinary web traffic, so it
keeps working on restrictive networks that block unusual ports or protocols.

The server image uses Debian Bookworm Slim rather than Alpine because
`better-sqlite3` is a native dependency and its glibc builds are the more
predictable production option.
