#!/usr/bin/env bash
# One-shot EC2 setup for the USC seat notifier.
# Installs Node.js, clones this repo, wires up a systemd unit that runs
# check-usc-seats.mjs in loop mode (1-minute polling by default).
#
# Works on Amazon Linux 2023, Amazon Linux 2, Ubuntu 22.04, and Ubuntu 24.04.
# Idempotent — safe to re-run to update the service.
#
# Usage (SSH into your EC2 instance first, then paste ONE of these):
#
#   # If the repo is PUBLIC:
#   NTFY_TOPIC=lec-checker-b10115ed7680 \
#     bash <(curl -fsSL https://raw.githubusercontent.com/VRAJSPATEL10/lec-checker/main/scripts/setup-ec2.sh)
#
#   # If the repo is PRIVATE and you've placed a GitHub PAT in ~/.git-credentials:
#   NTFY_TOPIC=lec-checker-b10115ed7680 \
#   LEC_CHECKER_REPO=https://<TOKEN>@github.com/VRAJSPATEL10/lec-checker.git \
#     bash <(curl -fsSL https://raw.githubusercontent.com/VRAJSPATEL10/lec-checker/main/scripts/setup-ec2.sh)

set -euo pipefail

REPO_URL="${LEC_CHECKER_REPO:-https://github.com/VRAJSPATEL10/lec-checker.git}"
INSTALL_DIR="${LEC_CHECKER_DIR:-/opt/lec-checker}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-60}"
NTFY_TOPIC_VAL="${NTFY_TOPIC:-}"
NTFY_TOKEN_VAL="${NTFY_TOKEN:-}"
NTFY_SERVER_VAL="${NTFY_SERVER:-https://ntfy.sh}"
SERVICE_USER="${SERVICE_USER:-$(whoami)}"

if [ -z "$NTFY_TOPIC_VAL" ]; then
  echo "Error: NTFY_TOPIC env var is required."
  echo "Example:"
  echo "  NTFY_TOPIC=lec-checker-b10115ed7680 bash <(curl -fsSL ...)"
  exit 1
fi

echo "==> Installing Node.js 22 and git..."
if command -v apt-get >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs git
elif command -v dnf >/dev/null 2>&1; then
  # Amazon Linux 2023 ships with nodejs20; use it if available, else nodesource.
  if ! sudo dnf install -y nodejs20 git 2>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs git
  fi
elif command -v yum >/dev/null 2>&1; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo yum install -y nodejs git
else
  echo "Error: unsupported package manager. Install Node 20+ and git manually, then re-run."
  exit 1
fi

NODE_BIN="$(command -v node)"
echo "==> Node version: $(node --version)  path: $NODE_BIN"

echo "==> Cloning $REPO_URL into $INSTALL_DIR..."
PARENT_DIR="$(dirname "$INSTALL_DIR")"
sudo mkdir -p "$PARENT_DIR"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$PARENT_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> Installing systemd unit..."
UNIT_PATH="/etc/systemd/system/lec-checker.service"
{
  echo "[Unit]"
  echo "Description=USC Schedule of Classes seat notifier"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo ""
  echo "[Service]"
  echo "Type=simple"
  echo "User=$SERVICE_USER"
  echo "WorkingDirectory=$INSTALL_DIR"
  echo "Environment=POLL_INTERVAL_SEC=$POLL_INTERVAL_SEC"
  echo "Environment=NTFY_TOPIC=$NTFY_TOPIC_VAL"
  echo "Environment=NTFY_SERVER=$NTFY_SERVER_VAL"
  if [ -n "$NTFY_TOKEN_VAL" ]; then
    echo "Environment=NTFY_TOKEN=$NTFY_TOKEN_VAL"
  fi
  echo "ExecStart=$NODE_BIN $INSTALL_DIR/check-usc-seats.mjs"
  echo "Restart=on-failure"
  echo "RestartSec=10"
  echo "StandardOutput=journal"
  echo "StandardError=journal"
  echo ""
  echo "[Install]"
  echo "WantedBy=multi-user.target"
} | sudo tee "$UNIT_PATH" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable lec-checker
sudo systemctl restart lec-checker

echo "==> Waiting for service to warm up..."
sleep 5

echo
echo "==> Service status:"
sudo systemctl status lec-checker --no-pager || true

echo
echo "==> Recent logs:"
sudo journalctl -u lec-checker --no-pager -n 20 || true

echo
echo "==> Setup complete."
echo
echo "Common commands:"
echo "  Tail logs:      sudo journalctl -u lec-checker -f"
echo "  Restart:        sudo systemctl restart lec-checker"
echo "  Stop:           sudo systemctl stop lec-checker"
echo "  Update code:    cd $INSTALL_DIR && git pull && sudo systemctl restart lec-checker"
echo "  Change config:  \$EDITOR $INSTALL_DIR/usc-watch.json && sudo systemctl restart lec-checker"
