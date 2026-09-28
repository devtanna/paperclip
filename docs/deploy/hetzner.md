---
title: Hetzner (single server)
summary: Run Paperclip for a small team on one Hetzner Cloud server with Caddy TLS, invite-only sign-up, and nightly backups
---

This guide runs Paperclip for a small team on one Hetzner Cloud server. It uses the files in `docker/hetzner/`:

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Postgres 17 with pgvector, the Paperclip server, and Caddy |
| `Caddyfile` | Automatic HTTPS for your domain, proxying to the server |
| `initdb/01-extensions.sql` | Enables `vector` when the database is first created |
| `.env.example` | Every value you set (copy to `.env`) |
| `backup.sh` | Nightly Postgres dump plus data volume, sent through restic |

The result:

- Your domain serves Paperclip over HTTPS.
- Everyone must sign in.
- **New accounts are invite-only**: only people holding an invite link from **Settings → Members** can create an account.
- Only Caddy is reachable from the internet; Postgres and the server are internal.

Models run remotely (for example through an OpenRouter API key), so a **CX32 or CPX31** (4 vCPU, 8 GB RAM) is enough.

## 1. Publish an image from your fork

The repository's Docker workflow (`.github/workflows/docker.yml`) publishes to `ghcr.io/<owner>/<repo>` for whichever repository runs it.

1. In your fork on GitHub, open **Actions** and enable workflows.
2. Run **Docker** manually (**Run workflow**) on the branch you want to deploy, or push to `master`.
3. When it finishes, note the `sha-<short>` tag under **Packages**, for example `ghcr.io/you/paperclip:sha-abc1234`.

Deploy that immutable tag, never a moving one. If the package is private, create a GitHub token with `read:packages` for the server to pull with.

## 2. Create the server

1. In Hetzner Cloud, create an Ubuntu 24.04 server and add your SSH key.
2. Point your domain's DNS `A` (and `AAAA`) record at the server's IP.
3. Allow only SSH and web traffic:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw enable
```

4. Install Docker and restic:

```bash
curl -fsSL https://get.docker.com | sh
apt-get install -y restic git
```

Docker publishes ports through its own iptables rules, so a port published in compose bypasses ufw. The Hetzner compose file publishes only Caddy's 80 and 443; keep it that way.

## 3. Configure

```bash
git clone https://github.com/<you>/paperclip.git /opt/paperclip
cd /opt/paperclip/docker/hetzner
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

- `PAPERCLIP_DOMAIN`: the hostname from step 2, with no scheme
- `ACME_EMAIL`: your address for Let's Encrypt
- `PAPERCLIP_IMAGE`: the tag from step 1
- `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET`: generate each with `openssl rand -base64 32 | tr -d '/+=' | head -c 40`
- `RESTIC_REPOSITORY` and `RESTIC_PASSWORD`: see step 6

Keep a copy of `BETTER_AUTH_SECRET` and `RESTIC_PASSWORD` somewhere safe. Without `RESTIC_PASSWORD` the backups cannot be read.

## 4. Start

```bash
# Only if the image is private:
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <you> --password-stdin

docker compose up -d
docker compose logs -f server
```

Caddy obtains the certificate on the first request to `https://<your domain>`.

## 5. Create the first admin and invite your team

Public deployments do not offer "Claim this instance" in the browser. Mint a one-time admin invite inside the server container:

```bash
docker compose exec server sh -lc \
  'cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth bootstrap-ceo --data-dir /paperclip --base-url "$PAPERCLIP_PUBLIC_URL"'
```

1. Open the printed URL, create your account, and accept. You are now the instance admin.
2. Create your company through onboarding. At the **Connect a model** step, paste your OpenRouter (or other provider) API key. Subscription sign-in is not offered on public deployments.
3. Set a monthly company budget so the budget hard-stop caps spend on that key.
4. In **Settings → Members**, create an invite for each teammate with the right role (Viewer, Operator, Admin or Owner) and send them the link. Each link is single-use and expires after 72 hours.

Invitees create their account from the invite link. Anyone opening your domain without an invite sees sign-in only.

## 6. Backups

`backup.sh` writes a `pg_dump` of the database and a tarball of the `paperclip-data` volume (uploads, agent homes, memory files), then sends both through restic. It keeps 7 daily, 4 weekly and 6 monthly snapshots.

A Hetzner **Storage Box** works as the restic target over SFTP. Set `RESTIC_REPOSITORY=sftp:<user>@<user>.your-storagebox.de:paperclip-backups` and add the server's SSH key to the Storage Box. Run the script once by hand, then schedule it:

```bash
/opt/paperclip/docker/hetzner/backup.sh
echo '30 3 * * * root /opt/paperclip/docker/hetzner/backup.sh >> /var/log/paperclip-backup.log 2>&1' > /etc/cron.d/paperclip-backup
```

**Test a restore** before relying on it:

```bash
set -a; . ./.env; set +a
restic snapshots --tag paperclip
restic restore latest --tag paperclip --target /tmp/restore-check
ls /tmp/restore-check/var/tmp/paperclip-backup.*
```

To restore the database into a fresh stack, start only `db`, then:

```bash
docker compose exec -T db pg_restore -U paperclip -d paperclip --clean --if-exists < paperclip-<stamp>.dump
```

## 7. Upgrade

1. Take a backup: `./backup.sh`
2. Set `PAPERCLIP_IMAGE` in `.env` to the new tag.
3. `docker compose pull server && docker compose up -d server`

The server applies database migrations on start. To roll back, restore the backup taken in step 1 and set the previous tag.

## Check the deployment

- `https://<your domain>` loads over HTTPS and shows sign-in, with no "Create one" link.
- From another machine, `nc -vz <server ip> 5432` and `nc -vz <server ip> 3100` both fail.
- `docker compose exec db psql -U paperclip -c "select extname from pg_extension where extname = 'vector'"` returns `vector`.
- An invite link lets a teammate create an account and land in the company with the chosen role.
- An agent run using your API key completes.
