#!/usr/bin/env bash
# Préparation du serveur (Ubuntu 24.04 / Debian 12 / Debian 13). Idempotent. À lancer avec sudo.
# Usage : sudo ADMIN_SSH_CIDR="x.x.x.x/32 y.y.y.y/32" bash bootstrap-host.sh
# ADMIN_SSH_CIDR : IP/CIDR autorisées en SSH, séparées par des espaces (vide = SSH ouvert à tous, déconseillé).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# En cas de conflit sur un fichier de configuration, garder la version locale sans poser de question
APT_OPTS=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

echo "== Mises à jour et paquets de base"
apt-get update -y
apt-get "${APT_OPTS[@]}" upgrade -y
# cron : absent des images cloud Debian 13, nécessaire aux sauvegardes et à la tâche quotidienne du portail
apt-get "${APT_OPTS[@]}" install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades rsync jq cron

echo "== Mises à jour de sécurité automatiques"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== Swap 4 Go (si absent)"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

echo "== Docker CE (dépôt officiel)"
if ! command -v docker >/dev/null 2>&1; then
  . /etc/os-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get "${APT_OPTS[@]}" install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
systemctl enable --now docker
systemctl restart docker
[ -n "${SUDO_USER:-}" ] && usermod -aG docker "$SUDO_USER" || true

echo "== Pare-feu (SSH d'abord !)"
if [ -n "${ADMIN_SSH_CIDR:-}" ]; then
  for cidr in $ADMIN_SSH_CIDR; do ufw allow from "$cidr" to any port 22 proto tcp; done
else
  ufw allow 22/tcp
fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== fail2ban (sshd)"
systemctl enable --now fail2ban

echo "== Répertoire de déploiement"
mkdir -p /opt/linagora-ia /var/backups/linagora-ia
[ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER":"$SUDO_USER" /opt/linagora-ia || true

echo "OK — reconnectez-vous en SSH pour que le groupe docker soit pris en compte."
