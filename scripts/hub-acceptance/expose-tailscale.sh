#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
yes=false; undo=false
for arg in "$@"; do
  case "$arg" in --yes) yes=true;; --undo) undo=true;; *) fail 'Usage: expose-tailscale.sh [--undo] [--yes]';; esac
done
if [[ -z "${HUB_HOST:-}" ]]; then
  HUB_HOST=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.BackendState!=="Running"||!j.Self?.DNSName)process.exit(1);process.stdout.write(j.Self.DNSName.replace(/\.$/,""))})') || fail 'Start Tailscale; if discovery fails, export HUB_HOST=<Mac MagicDNS name> and retry'
fi
[[ "$HUB_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail 'HUB_HOST must be a DNS hostname (no scheme or port)'
cmd=(tailscale serve --bg --https=8443 http://127.0.0.1:8787)
if "$undo"; then cmd+=(off); fi
printf 'Hub URL: https://%s:8443\n' "$HUB_HOST"
printf 'Command:'; printf ' %q' "${cmd[@]}"; printf '\n'
echo 'Tailnet only; port 443 is not changed. Never use Funnel or serve reset.'
if ! "$yes"; then echo 'Dry run only. Add --yes to apply.'; exit 0; fi
# Fail closed on malformed status; refuse existing ports and pre-existing public Funnel rules.
tailscale serve status --json | node -e '
let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
 const j=JSON.parse(s), undo=process.argv[1]==="true";
 if(!j||typeof j!=="object"||Array.isArray(j))throw Error("Invalid serve status");
 const web=Object.entries(j.Web||{}).filter(([k])=>k.endsWith(":8443"));
 const occupied=!!j.TCP?.["8443"]||web.length>0;
 if(!undo){if(occupied)throw Error("8443 occupied; refusing overwrite");
 if(Object.entries(j.AllowFunnel||{}).some(([k,v])=>k.endsWith(":8443")&&v))throw Error("8443 Funnel rule exists; refusing public exposure");}
 else if(!j.TCP?.["8443"]?.HTTPS||web.length!==1||Object.keys(web[0][1].Handlers||{}).length!==1||web[0][1].Handlers?.["/"]?.Proxy!=="http://127.0.0.1:8787")throw Error("8443 is not the expected Hub mapping; refusing undo");
})' "$undo"
"${cmd[@]}"
