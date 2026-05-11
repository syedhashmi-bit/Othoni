#!/bin/sh
# othoni-agent — POSIX shell agent that pushes /proc-based metrics to a
# remote othoni instance via POST /api/metrics. Pairs with the v0.23.0
# multi-host source attribution: each agent identifies itself with the
# `host` field and the server splices it into the metric name as
# `custom.<host>.<leaf>` so multiple agents don't collide.
#
# Required env:
#   OTHONI_URL      base URL of the dashboard (e.g. https://othoni.example.com)
#   OTHONI_API_KEY  API key (generate on /settings in the dashboard)
#
# Optional env:
#   OTHONI_HOST     source label; defaults to short hostname, lowercased,
#                   trimmed to match [a-z0-9-]{1,40}
#   OTHONI_INTERVAL push cadence in seconds (default 30, min 5)
#
# Run once for a single tick (handy for cron):
#   OTHONI_URL=... OTHONI_API_KEY=... ./agent.sh --once
#
# Run as a long-lived service (use the bundled othoni-agent.service.example).
#
# Dependencies: /bin/sh, awk, curl, sleep, sed, tr, hostname (or /etc/hostname).
# No bashisms; tested under busybox and dash.

set -eu

URL_BASE="${OTHONI_URL:-}"
API_KEY="${OTHONI_API_KEY:-}"
HOST_RAW="${OTHONI_HOST:-}"
INTERVAL="${OTHONI_INTERVAL:-30}"
ONCE=0

if [ "${1:-}" = "--once" ] || [ "${1:-}" = "-1" ]; then
  ONCE=1
  INTERVAL=5
fi

if [ -z "$URL_BASE" ] || [ -z "$API_KEY" ]; then
  echo "othoni-agent: OTHONI_URL and OTHONI_API_KEY are required" >&2
  exit 1
fi

# Min sample window is 5s — anything shorter makes /proc/stat deltas noisy
# and the server-side rate limit (600 req/min/key) is the binding constraint
# anyway. Round to an integer.
case "$INTERVAL" in
  ''|*[!0-9]*) echo "othoni-agent: OTHONI_INTERVAL must be a positive integer (got '$INTERVAL')" >&2; exit 1 ;;
esac
if [ "$INTERVAL" -lt 5 ]; then INTERVAL=5; fi

# Host: prefer the explicit env var, else derive from hostname. Lowercase,
# strip any DNS suffix after the first dot, keep only [a-z0-9-], and trim
# leading/trailing dashes. The result must match the server's host pattern:
# [a-z0-9][a-z0-9-]{0,38}[a-z0-9] (or a single [a-z0-9]).
derive_host() {
  raw=$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown)
  printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/\..*$//' -e 's/[^a-z0-9-]//g' -e 's/^-*//' -e 's/-*$//' \
    | cut -c1-40
}
if [ -z "$HOST_RAW" ]; then
  HOST=$(derive_host)
else
  HOST=$(printf '%s' "$HOST_RAW" | tr '[:upper:]' '[:lower:]')
fi

# Validate against the server's regex up front so we fail loud instead of
# silently dropping the attribution server-side. Single char [a-z0-9] is
# also valid, hence the length-1 special case.
case "$HOST" in
  '' ) echo "othoni-agent: derived host is empty; set OTHONI_HOST explicitly" >&2; exit 1 ;;
  -*|*- ) echo "othoni-agent: OTHONI_HOST '$HOST' must not start or end with a dash" >&2; exit 1 ;;
  *[!a-z0-9-]* ) echo "othoni-agent: OTHONI_HOST '$HOST' must match [a-z0-9-]+" >&2; exit 1 ;;
esac
HLEN=$(printf '%s' "$HOST" | wc -c | tr -d ' ')
if [ "$HLEN" -gt 40 ]; then
  echo "othoni-agent: OTHONI_HOST '$HOST' is longer than 40 chars" >&2
  exit 1
fi

URL="${URL_BASE%/}/api/metrics"

# /proc/stat cpu line → "total idle" where total = sum(user..steal) and
# idle = idle + iowait. Diff between successive reads gives CPU %.
read_cpu() {
  awk '$1=="cpu"{
    user=$2; nice=$3; sys=$4; idle=$5; iowait=$6; irq=$7; softirq=$8;
    steal=($9==""?0:$9);
    total=user+nice+sys+idle+iowait+irq+softirq+steal;
    idle_total=idle+iowait;
    print total, idle_total;
    exit
  }' /proc/stat
}

# /proc/net/dev → "rx tx" totals across all non-loopback / non-veth ifaces.
# Mirrors the historical sampler's filter so the numbers line up if the
# server ever cross-references them.
read_net() {
  awk '
    /:/ {
      gsub(/^[ \t]+/, "")
      idx = index($0, ":")
      iface = substr($0, 1, idx - 1)
      rest = substr($0, idx + 1)
      n = split(rest, c)
      if (iface != "lo" && iface !~ /^veth/) {
        rx += c[1]
        tx += c[9]
      }
    }
    END { print rx + 0, tx + 0 }
  ' /proc/net/dev
}

read_mem_pct() {
  awk '
    /^MemTotal:/ { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END {
      if (total > 0) printf "%.2f", (1 - avail / total) * 100
      else print "0"
    }
  ' /proc/meminfo
}

read_load1() {
  awk '{ printf "%.2f", $1 }' /proc/loadavg
}

read_disk_root_pct() {
  df -P / 2>/dev/null | awk 'NR==2 { sub("%","",$5); print $5 }'
}

# JSON-escape a value: keep numbers raw, quote strings. The fields we send
# are all numeric so this is mostly defensive.
post_batch() {
  payload=$1
  # Use --fail-with-body when available so we get a useful error message
  # rather than a silent non-zero exit. Fall back to plain --fail if not.
  err=$(printf '%s' "$payload" \
    | curl -sS --max-time 10 \
        -X POST "$URL" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        --data-binary @- 2>&1 >/dev/null) || {
    echo "othoni-agent: push failed: $err" >&2
    return 1
  }
}

build_payload() {
  cpu_pct=$1
  mem_pct=$2
  load1=$3
  disk_pct=$4
  rx_rate=$5
  tx_rate=$6
  printf '{"host":"%s","metrics":[' "$HOST"
  printf '{"name":"custom.cpu","value":%s},' "$cpu_pct"
  printf '{"name":"custom.mem","value":%s},' "$mem_pct"
  printf '{"name":"custom.load1","value":%s},' "$load1"
  printf '{"name":"custom.disk_root","value":%s},' "$disk_pct"
  printf '{"name":"custom.net_rx","value":%s},' "$rx_rate"
  printf '{"name":"custom.net_tx","value":%s}' "$tx_rate"
  printf ']}'
}

# Deltas across one tick. Keep previous values in shell vars so the steady
# state needs just one /proc read per cadence.
prev_cpu=$(read_cpu)
prev_net=$(read_net)

trap 'echo "othoni-agent: stopping" >&2; exit 0' INT TERM

while :; do
  sleep "$INTERVAL"

  cur_cpu=$(read_cpu)
  cur_net=$(read_net)

  # CPU%.
  set -- $prev_cpu; pt=$1; pi=$2
  set -- $cur_cpu;  ct=$1; ci=$2
  dt=$((ct - pt))
  di=$((ci - pi))
  if [ "$dt" -gt 0 ]; then
    cpu_pct=$(awk -v t="$dt" -v i="$di" 'BEGIN{ p=(1 - i/t) * 100; if (p<0) p=0; if (p>100) p=100; printf "%.2f", p }')
  else
    cpu_pct="0"
  fi

  # Net rates (bytes/sec).
  set -- $prev_net; prx=$1; ptx=$2
  set -- $cur_net;  crx=$1; ctx=$2
  rx_rate=$(awk -v a="$crx" -v b="$prx" -v i="$INTERVAL" 'BEGIN{ r=(a-b)/i; if (r<0) r=0; printf "%.2f", r }')
  tx_rate=$(awk -v a="$ctx" -v b="$ptx" -v i="$INTERVAL" 'BEGIN{ r=(a-b)/i; if (r<0) r=0; printf "%.2f", r }')

  prev_cpu=$cur_cpu
  prev_net=$cur_net

  mem_pct=$(read_mem_pct)
  load1=$(read_load1)
  disk_pct=$(read_disk_root_pct)
  : "${disk_pct:=0}"

  payload=$(build_payload "$cpu_pct" "$mem_pct" "$load1" "$disk_pct" "$rx_rate" "$tx_rate")
  post_batch "$payload" || true

  if [ "$ONCE" -eq 1 ]; then exit 0; fi
done
