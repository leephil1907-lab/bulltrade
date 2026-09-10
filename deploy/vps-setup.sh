#!/usr/bin/env bash
# ============================================================
# Blockchain Bullhorn — one-shot VPS setup
# For any fresh Ubuntu 22.04/24.04 server (Oracle Cloud Always
# Free, Hetzner, DigitalOcean, …). Run as root.
#
#   bash vps-setup.sh [your-domain.com]
#
# Installs Node.js 20 + pm2 + Caddy (automatic HTTPS if a domain
# is given), clones the repo, and starts the app on :3000.
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/leephil1907-lab/bulltrade.git"
APP_DIR=/opt/bullhorn
DOMAIN="${1:-}"

echo '==> Installing prerequisites…'
apt-get update -y
apt-get install -y curl git ca-certificates ufw

echo '==> Installing Node.js 20…'
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pm2 --silent

echo "==> Cloning $REPO_URL …"
rm -rf "$APP_DIR"
git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

echo '==> Writing .env (edit the secrets!) …'
if [ ! -f .env ]; then
  cat > .env <<EOF
ADMIN_EMAIL=admin@blockchainbullhorn.com
ADMIN_PASSWORD=CHANGE-ME-STRONG-PASSWORD
JWT_SECRET=CHANGE-ME-$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )
EOF
fi

echo '==> Starting with pm2…'
pm2 start server.js --name bullhorn
pm2 save
pm2 startup systemd -u "$(logname 2>/dev/null || echo root)" --hp "/home/$(logname 2>/dev/null || echo root)" 2>/dev/null | tail -n 1 | bash || true

echo '==> Firewall…'
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo '==> Installing Caddy reverse proxy…'
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy
if [ -n "$DOMAIN" ]; then
  printf '%s {\n  reverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
else
  printf ':80 {\n  reverse_proxy 127.0.0.1:3000\n}\n' > /etc/caddy/Caddyfile
fi
systemctl restart caddy

IP=$(curl -s https://api.ipify.org || echo your-server-ip)
echo ""
echo "============================================================"
echo " DONE — Blockchain Bullhorn is running."
echo "   http://${DOMAIN:-$IP}/  (admin: /admin)"
echo ""
echo " NEXT STEPS:"
echo "   1. nano $APP_DIR/.env   (set ADMIN_PASSWORD / JWT_SECRET)"
echo "   2. pm2 restart bullhorn"
echo "   3. Log in at /admin → Settings → paste deposit wallet addresses"
echo "   Useful: pm2 logs bullhorn | pm2 status | pm2 restart bullhorn"
echo "============================================================"
