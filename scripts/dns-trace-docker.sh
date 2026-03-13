#!/usr/bin/env bash
set -euo pipefail

# Trace Docker DNS requests and map source container IPs back to container names.
# Captures both:
# - container -> host DNS (INPUT on br+), e.g. AdGuard Home on the host
# - container -> external DNS (DOCKER-USER)
#
# Usage:
#   sudo ./scripts/dns-trace-docker.sh [duration_seconds] [--cleanup]
#
# Example:
#   sudo ./scripts/dns-trace-docker.sh 60
#   sudo ./scripts/dns-trace-docker.sh 60 --cleanup

DURATION="${1:-60}"
TAG="docker-dns-trace"
PREFIX_HOST_UDP="DHU:"
PREFIX_HOST_TCP="DHT:"
PREFIX_EXT_UDP="DEU:"
PREFIX_EXT_TCP="DET:"
KEEP_TMP=1

if [[ "${2:-}" == "--cleanup" ]]; then
  KEEP_TMP=0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 [duration_seconds]"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found"
  exit 1
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "iptables command not found"
  exit 1
fi

if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [[ "$DURATION" -lt 1 ]]; then
  echo "duration must be a positive integer"
  exit 1
fi

TMPDIR="$(mktemp -d)"
LOGFILE="$TMPDIR/dns.log"
PAIRFILE="$TMPDIR/pairs.txt"
IPMAP="$TMPDIR/ipmap.txt"
WATCH_PID=""
HAS_DOCKER_USER=0

remove_input_rule() {
  local proto="$1"
  local prefix="$2"
  while iptables -D INPUT -i br+ -p "$proto" --dport 53 -m conntrack --ctstate NEW -m comment --comment "$TAG" -j LOG --log-prefix "$prefix" 2>/dev/null; do
    :
  done
}

remove_docker_user_rule() {
  local proto="$1"
  local prefix="$2"
  while iptables -D DOCKER-USER -p "$proto" --dport 53 -m conntrack --ctstate NEW -m comment --comment "$TAG" -j LOG --log-prefix "$prefix" 2>/dev/null; do
    :
  done
}

cleanup() {
  if [[ -n "$WATCH_PID" ]]; then
    kill "$WATCH_PID" 2>/dev/null || true
  fi
  remove_input_rule udp "$PREFIX_HOST_UDP"
  remove_input_rule tcp "$PREFIX_HOST_TCP"
  if [[ "$HAS_DOCKER_USER" -eq 1 ]]; then
    remove_docker_user_rule udp "$PREFIX_EXT_UDP"
    remove_docker_user_rule tcp "$PREFIX_EXT_TCP"
  fi
  if [[ "$KEEP_TMP" -eq 1 ]]; then
    echo "Saved debug files in: $TMPDIR"
    echo "  - $LOGFILE"
    echo "  - $PAIRFILE"
    echo "  - $IPMAP"
  else
    rm -rf "$TMPDIR"
  fi
}
trap cleanup EXIT

echo "[1/4] Adding temporary iptables DNS log rules..."
iptables -I INPUT 1 -i br+ -p udp --dport 53 -m conntrack --ctstate NEW -m comment --comment "$TAG" -j LOG --log-prefix "$PREFIX_HOST_UDP"
iptables -I INPUT 2 -i br+ -p tcp --dport 53 -m conntrack --ctstate NEW -m comment --comment "$TAG" -j LOG --log-prefix "$PREFIX_HOST_TCP"

if iptables -S DOCKER-USER >/dev/null 2>&1; then
  HAS_DOCKER_USER=1
  iptables -I DOCKER-USER 1 -p udp --dport 53 -m conntrack --ctstate NEW -m comment --comment "$TAG" -j LOG --log-prefix "$PREFIX_EXT_UDP"
  iptables -I DOCKER-USER 2 -p tcp --dport 53 -m conntrack --ctstate NEW -m comment --comment "$TAG" -j LOG --log-prefix "$PREFIX_EXT_TCP"
else
  echo "Note: DOCKER-USER chain not found, external DNS path logging disabled."
fi

echo "[2/4] Capturing DNS events for ${DURATION}s..."
PATTERN="${PREFIX_HOST_UDP}|${PREFIX_HOST_TCP}|${PREFIX_EXT_UDP}|${PREFIX_EXT_TCP}"
if [[ -r /var/log/syslog ]]; then
  bash -c "tail -n0 -F /var/log/syslog | stdbuf -oL grep -E '$PATTERN'" > "$LOGFILE" &
  WATCH_PID=$!
elif command -v dmesg >/dev/null 2>&1 && dmesg >/dev/null 2>&1; then
  bash -c "dmesg -w | stdbuf -oL grep -E '$PATTERN'" > "$LOGFILE" &
  WATCH_PID=$!
elif command -v journalctl >/dev/null 2>&1; then
  bash -c "journalctl -kf -o cat | stdbuf -oL grep -E '$PATTERN'" > "$LOGFILE" &
  WATCH_PID=$!
else
  echo "No supported log source found (/var/log/syslog, dmesg, or journalctl)."
  exit 1
fi

sleep "$DURATION"
if [[ -n "$WATCH_PID" ]]; then
  kill "$WATCH_PID" 2>/dev/null || true
fi
sleep 1

echo "[3/4] Building container IP map..."
for n in $(docker network ls --format '{{.Name}}'); do
  docker network inspect "$n" -f '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{println}}{{end}}' 2>/dev/null || true
done \
  | awk 'NF==2 {gsub("^/","",$1); split($2,a,"/"); print a[1],$1}' \
  | sort -u > "$IPMAP"

echo "[4/4] Summary: container -> DNS destination"
awk '
  function get_route(line) {
    if (index(line, hu) || index(line, ht)) return "to-host-dns";
    if (index(line, eu) || index(line, et)) return "to-external-dns";
    return "";
  }
  {
    src="";
    dst="";
    route=get_route($0);
    if (match($0,/SRC=[0-9.]+/)) {
      src=substr($0,RSTART+4,RLENGTH-4);
    }
    if (match($0,/DST=[0-9.]+/)) {
      dst=substr($0,RSTART+4,RLENGTH-4);
    }
    if (src != "" && dst != "" && route != "") {
      print src, dst, route;
    }
  }
' hu="$PREFIX_HOST_UDP" ht="$PREFIX_HOST_TCP" eu="$PREFIX_EXT_UDP" et="$PREFIX_EXT_TCP" "$LOGFILE" | sort | uniq -c > "$PAIRFILE"

awk '
  NR==FNR {ip2name[$1]=$2; next}
  {
    cnt=$1; src=$2; dst=$3; route=$4;
    name=(src in ip2name ? ip2name[src] : "UNKNOWN(" src ")");
    key=route "|" name "|" dst;
    sum[key]+=cnt;
    total+=cnt;
  }
  END {
    printf "%-8s %-17s %-30s %s\n", "COUNT", "PATH", "CONTAINER", "DNS_SERVER";
    for (k in sum) {
      split(k,a,"|");
      printf "%-8d %-17s %-30s %s\n", sum[k], a[1], a[2], a[3];
    }
    if (total == 0) {
      print "No DNS events were captured in the selected window.";
    }
  }
' "$IPMAP" "$PAIRFILE" | sort -nr
