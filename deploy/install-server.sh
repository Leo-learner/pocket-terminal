#!/usr/bin/env bash
set -euo pipefail
release=${1:?release directory required}
public_key=${2:?public key file required}
[[ "$release" =~ ^/opt/apps/pocket-terminal/releases/[a-f0-9]{40}$ ]] || exit 2
[[ -f "$release/dist/index.html" && -f "$release/deploy/nginx.conf" ]] || exit 2
[[ -f "$public_key" ]] || exit 2
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/opt/apps/pocket-terminal/backups/$stamp"
install -d -m 700 "$backup"
if [[ -e /etc/nginx/sites-available/terminal.dkz12345.com ]]; then cp -a /etc/nginx/sites-available/terminal.dkz12345.com "$backup/nginx.conf"; fi
if [[ -L /opt/apps/pocket-terminal/current ]]; then readlink /opt/apps/pocket-terminal/current > "$backup/previous-release"; fi
if ! id pocket-tunnel >/dev/null 2>&1; then useradd --system --create-home --shell /usr/sbin/nologin pocket-tunnel; fi
install -d -o pocket-tunnel -g pocket-tunnel -m 700 /home/pocket-tunnel/.ssh
if [[ -f /home/pocket-tunnel/.ssh/authorized_keys ]]; then cp -a /home/pocket-tunnel/.ssh/authorized_keys "$backup/authorized_keys"; fi
key=$(cat "$public_key")
[[ "$key" == ssh-ed25519\ * ]] || exit 2
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:43210",permitopen="127.0.0.1:1",command="/bin/false" %s\n' "$key" > /home/pocket-tunnel/.ssh/authorized_keys
chown pocket-tunnel:pocket-tunnel /home/pocket-tunnel/.ssh/authorized_keys
chmod 600 /home/pocket-tunnel/.ssh/authorized_keys
# No global SSH settings or other users are changed. Public forwards remain loopback-only.
sshd -t
install -d -m 755 /var/www/letsencrypt
if [[ ! -f /etc/letsencrypt/live/terminal.dkz12345.com/fullchain.pem ]]; then
 install -m 644 "$release/deploy/nginx-http.conf" /etc/nginx/sites-available/terminal.dkz12345.com
 ln -sfn /etc/nginx/sites-available/terminal.dkz12345.com /etc/nginx/sites-enabled/terminal.dkz12345.com
 nginx -t
 systemctl reload nginx
 certbot certonly --webroot -w /var/www/letsencrypt -d terminal.dkz12345.com --non-interactive --agree-tos --register-unsafely-without-email
fi
ln -sfn "$release" /opt/apps/pocket-terminal/current
install -m 644 "$release/deploy/nginx.conf" /etc/nginx/sites-available/terminal.dkz12345.com
ln -sfn /etc/nginx/sites-available/terminal.dkz12345.com /etc/nginx/sites-enabled/terminal.dkz12345.com
if nginx -t; then systemctl reload nginx; else
 if [[ -f "$backup/nginx.conf" ]]; then cp "$backup/nginx.conf" /etc/nginx/sites-available/terminal.dkz12345.com; fi
 if [[ -f "$backup/previous-release" ]]; then ln -sfn "$(cat "$backup/previous-release")" /opt/apps/pocket-terminal/current; fi
 exit 1
fi
printf 'Deployed %s\nBackup: %s\n' "$release" "$backup"
