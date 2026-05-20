#!/bin/bash

# Parse flags
USE_API=false
JSON_OUT=false
SLOTS_ONLY=false
LOG_LINES=10
SERVICE="llama"
FILTER_API_LOG=false
COMPACT=false
LLAMA=false
i=1
while [ "$i" -le "$#" ]; do
	case "${!i}" in
	--api) USE_API=true ;;
	--json) JSON_OUT=true ;;
	--slots-only) SLOTS_ONLY=true ;;
	--service)
		i=$((i + 1))
		SERVICE="${!i}"
		;;
	--lines)
		i=$((i + 1))
		LOG_LINES="${!i}"
		;;
	--no-api-log) FILTER_API_LOG=true ;;
	--compact) COMPACT=true ;;
	--llama) LLAMA=true ;;
	esac
	i=$((i + 1))
done

# ---- Animated llama companion ----
LLAMA_FRAME=/tmp/.llama_frame
LLAMA_PID=""
if $LLAMA; then
	# Llama frames (each frame is separated by a single blank line)
	FRAMES=(
		'    (\_/)
    ( •_•)
    /  🍃  \
   /   |   \
  /    |    \
 (__)  |  (__)
    \ | /
      V')
	FRAMES+=('    (\_/)
    (=_=-)
    /  🍃  \
   /   |   \
  /    |    \
 (__)  |  (__)
    \ | /
      V')
	FRAMES+=('    (\_/)
    ( ~_~)
    /  🍃  \
   /  / \  \
  /  /   \  \
 (__)     (__)
    \ | /
      V')
	FRAMES+=('    (\_/)
    (o_•)
    /  🍃  \
   /   |   \
  /    |    \
 (__)  |  (__)
    \ | /
      V')
	FRAMES+=('    (\_/)
    ( _• )
    /  🍃  \
   /   |   \
  /    |    \
 (__)  |  (__)
    \ | /
      V')

	# Background animation loop
	(
		idx=0
		while true; do
			printf '%s' "${FRAMES[$idx]}" >"$LLAMA_FRAME"
			idx=$(((idx + 1) % ${#FRAMES[@]}))
			sleep 0.2
		done
	) &
	LLAMA_PID=$!
	# Clean up on exit
	trap "kill $LLAMA_PID 2>/dev/null; rm -f $LLAMA_FRAME" EXIT
fi
# ---- End llama animation ----

# Gather RAM info
if ! $SLOTS_ONLY; then
	read -r rused_m rtotal_m ravail_m <<<$(free -m | awk '/^Mem:/{printf "%s %s %s", $3, $2, $7}')
	rused_g=$(awk -v v="$rused_m" 'BEGIN { printf "%.1f", v/1024 }')
	rtotal_g=$(awk -v v="$rtotal_m" 'BEGIN { printf "%.1f", v/1024 }')
	ravail_g=$(awk -v v="$ravail_m" 'BEGIN { printf "%.1f", v/1024 }')

	if ! $JSON_OUT; then
		echo "=== TIME: $(date '+%H:%M:%S.%3N') ==="
		if $COMPACT; then
			# Compact RAM: "RAM: 24G used / 31G total (7.5G avail)"
			echo "RAM: ${rused_g%.*}G used / ${rtotal_g%.*}G total (${ravail_g}G avail)"
		else
			echo '=== RAM ==='
			free -h
		fi
	fi
fi

# Gather GPU info
if ! $SLOTS_ONLY; then
	gpu_line=$(rocm-smi --showmeminfo vram 2>/dev/null |
		awk '/Total Memory/{gsub(/[^0-9]/,"",$NF); vals[++n]=$NF}
	    /Tot.*Used.*Memory/{gsub(/[^0-9]/,"",$NF); vals[++n]=$NF}
	    END{for(i=2;i<=n;i+=2){if(i>2)printf" | ";printf"%.2f/%.2f",vals[i]/1073741824,vals[i-1]/1073741824}}')

	if ! $JSON_OUT; then
		if $COMPACT; then
			# Compact GPU VRAM: "GPU: 7.45/8.00 GiB | 7.45/8.00 GiB" (used/total per device)
			echo "GPU: ${gpu_line:-N/A}"
		else
			echo '=== GPU VRAM (GiB) ==='
			rocm-smi --showmeminfo vram 2>/dev/null |
				awk '/Total/ {
	        for(i=1; i<=NF; i++) if($i ~ /^[0-9]+$/) {
	            printf "%.2f GiB\n", $i / 1073741824
	        }
	    }'
		fi
	fi
fi



# Show animated llama if requested
if $LLAMA; then
	echo ''
	if [ -f "$LLAMA_FRAME" ]; then
		cat "$LLAMA_FRAME"
	else
		# First run — show frame 0
		printf '%s' "${FRAMES[0]}"
	fi
	echo ''
fi

if ! $JSON_OUT; then
	echo '=== SLOT PROGRESS ==='
fi

JSON_SLOTS=""

# Fetch logs early (needed for progress parsing); display later

# Always fetch a fixed window, then filter and tail to the requested count
if $FILTER_API_LOG; then
	LOG=$(journalctl -u "$SERVICE" -n 100 --no-pager | grep -v 'GET /slots ')
else
	LOG=$(journalctl -u "$SERVICE" -n 100 --no-pager)
fi

NOW_S=$(date +%s)
STATE_FILE=/tmp/slot_eta_state.txt

# Load persisted per-slot state
# Format: proc <slot> <first_ts> <first_prog> <epoch>  |  gen <slot> <ts> <decoded>
declare -A FIRST_TS FIRST_PROG SLOT_EPOCH
declare -A GEN_DECODED GEN_TS
if [ -f "$STATE_FILE" ]; then
	while read -r type s rest; do
		if [ "$type" = "proc" ]; then
			read -r ts fp ep <<<"$rest"
			FIRST_TS[$s]=$ts
			FIRST_PROG[$s]=$fp
			SLOT_EPOCH[$s]=${ep:-0}
		elif [ "$type" = "gen" ]; then
			read -r ts decoded <<<"$rest"
			GEN_TS[$s]=$ts
			GEN_DECODED[$s]=${decoded:-0}
		fi
	done <"$STATE_FILE"
fi

# Parse prompt processing slots from logs only.
# Generation is tracked via the /slots API (no log output during gen).
ACTIVE_DATA=$(echo "$LOG" | awk '
{
    ts_str = $1 " " $2 " " $3
}
/slot update_slots.*prompt processing done/ {
    match($0, /id +([0-9]+)/, sid)
    if (sid[1] != "") done[sid[1]] = 1
}
/slot update_slots.*prompt processing progress.*progress =/ {
    match($0, /id +([0-9]+)/, sid)
    match($0, /progress = ([0-9.]+)/, prog)
    if (sid[1] != "" && prog[1] != "") {
        s = sid[1]; p = prog[1] + 0
        if (p > last[s]) {
            last[s] = p
            last_ts[s] = ts_str
        }
    }
}
END { for (s in last) if (!done[s]) print s, last[s], last_ts[s] }
')

# Generation tracking via /slots API (only when --api flag is set)
GEN_SLOTS=""
if $USE_API; then
	LLAMA_PORT=${LLAMA_PORT:-8080}
	GEN_SLOTS=$(curl -s --max-time 2 "http://127.0.0.1:${LLAMA_PORT}/slots" 2>/dev/null | python3 -c "
import json, sys
try:
    slots = json.load(sys.stdin)
except:
    sys.exit(0)
for s in slots:
    if s.get('is_processing') or s.get('next_token', [{}])[0].get('n_decoded', 0) > 0:
        nt = (s.get('next_token') or [{}])[0]
        decoded = nt.get('n_decoded', 0)
        remain = nt.get('n_remain', 0)
        n_predict = s.get('params', {}).get('n_predict', 0)
        total = decoded + remain
        print(s['id'], decoded, remain, total, n_predict)
" 2>/dev/null)

	# Remove generation slots that are still in prompt processing
	# (API says processing but log shows progress — that's prompt, not generation)
	if [ -n "$ACTIVE_DATA" ] && [ -n "$GEN_SLOTS" ]; then
		PROC_SLOT_IDS=$(echo "$ACTIVE_DATA" | awk '{print $1}' | tr '\n' '|')
		GEN_SLOTS=$(echo "$GEN_SLOTS" | awk -v ids="$PROC_SLOT_IDS" 'BEGIN{n=split(ids,a,"|"); for(i=1;i<=n;i++) skip[a[i]]=1} !skip[$1]')
	fi
fi

if [ -z "$ACTIVE_DATA" ] && [ -z "$GEN_SLOTS" ]; then
	if ! $JSON_OUT; then
		echo "No active slots."
	fi
	# Clean up stale state file
	>"$STATE_FILE"
else
	NEW_STATE=""

	# --- Actively processing slots ---
	if [ -n "$ACTIVE_DATA" ]; then
		while IFS= read -r line; do
			[ -z "$line" ] && continue
			slot=$(echo "$line" | awk '{print $1}')
			prog=$(echo "$line" | awk '{print $2}')

			# Cap progress at 1.0
			prog=$(awk -v p="$prog" 'BEGIN { printf "%.6f", (p > 1.0 ? 1.0 : (p < 0 ? 0 : p)) }')

			# Detect prompt reset: progress dropped below persisted baseline
			if [ -n "${FIRST_PROG[$slot]+x}" ]; then
				reset=$(awk -v p="$prog" -v fp="${FIRST_PROG[$slot]}" 'BEGIN { print (p < fp - 0.05) ? 1 : 0 }')
				if [ "$reset" -eq 1 ]; then
					FIRST_TS[$slot]=$NOW_S
					FIRST_PROG[$slot]=$prog
					SLOT_EPOCH[$slot]=$((${SLOT_EPOCH[$slot]:-0} + 1))
				fi
			fi

			# First time seeing this slot
			if [ -z "${FIRST_TS[$slot]+x}" ]; then
				FIRST_TS[$slot]=$NOW_S
				FIRST_PROG[$slot]=$prog
				SLOT_EPOCH[$slot]=0
			fi

			elapsed=$((NOW_S - FIRST_TS[$slot]))
			delta=$(awk -v p="$prog" -v fp="${FIRST_PROG[$slot]}" 'BEGIN { d = p - fp; printf "%.6f", d < 0 ? 0 : d }')

			if [ "$(awk -v d="$delta" 'BEGIN { print (d > 0.001) ? 1 : 0 }')" -eq 1 ] && [ "$elapsed" -gt 1 ]; then
				rate=$(awk -v d="$delta" -v e="$elapsed" 'BEGIN { r = d / e; printf "%.6f", r }')
				rem=$(awk -v p="$prog" -v r="$rate" 'BEGIN {
					r = (r < 0.0001) ? 0.0001 : r
					rem = (1.0 - p) / r
					if (rem < 0) rem = 0
					printf "%.0f", rem
				}')
				mins=$((rem / 60))
				secs=$((rem % 60))
				eta=$(printf "~%dm%02ds" "$mins" "$secs")
			else
				eta="~--"
			fi

			w=40
			filled=$(awk -v p="$prog" 'BEGIN { f = int(p * 40 + 0.5); print (f < 0 ? 0 : (f > 40 ? 40 : f)) }')
			bar=""
			for ((i = 0; i < filled; i++)); do bar+="█"; done
			for ((i = filled; i < w; i++)); do bar+="░"; done
			pct=$(awk -v p="$prog" 'BEGIN { printf "%.1f", p * 100 }')
			if ! $JSON_OUT; then
				echo "Slot $slot [processing] [$bar] $pct%  ETA $eta"
			fi
			JSON_SLOTS+="$(printf '{"id":%d,"type":"processing","progress":%.4f,"eta":"%s"},' "$slot" "$prog" "$eta")"
			NEW_STATE+="proc $slot ${FIRST_TS[$slot]} ${FIRST_PROG[$slot]} ${SLOT_EPOCH[$slot]:-0}"$'\n'

		done <<<"$ACTIVE_DATA"
	fi

	# --- Generating slots (from /slots API) ---
	if [ -n "$GEN_SLOTS" ]; then
		while IFS= read -r line; do
			[ -z "$line" ] && continue
			slot=$(echo "$line" | awk '{print $1}')
			decoded=$(echo "$line" | awk '{print $2}')
			remain=$(echo "$line" | awk '{print $3}')
			total=$(echo "$line" | awk '{print $4}')
			n_predict=$(echo "$line" | awk '{print $5}')

			# ETA via persisted token rate
			unset tps
			eta="~--"
			if [ -n "${GEN_DECODED[$slot]+x}" ]; then
				delta_t=$((NOW_S - GEN_TS[$slot]))
				delta_tok=$((decoded - GEN_DECODED[$slot]))
				if [ "$delta_t" -gt 0 ] && [ "$delta_tok" -gt 0 ]; then
					tps=$(awk -v dt="$delta_tok" -v tt="$delta_t" 'BEGIN { printf "%.2f", dt / tt }')
					rem_s=$(awk -v r="$remain" -v t="$tps" 'BEGIN { r2=(t<0.1)?0.1:t; printf "%.0f", r/r2 }')
					m=$((rem_s / 60))
					s=$((rem_s % 60))
					eta=$(printf "~%dm%02ds" "$m" "$s")
				fi
			fi
			GEN_DECODED[$slot]=$decoded
			GEN_TS[$slot]=$NOW_S

			# Progress bar for generation
			if [ "$total" -gt 0 ] 2>/dev/null; then
				prog=$(awk -v d="$decoded" -v t="$total" 'BEGIN { printf "%.6f", d/t }')
			else
				prog=$(awk -v d="$decoded" -v n="$n_predict" 'BEGIN { total=d+n; printf "%.6f", (total>0)?d/total:0 }')
			fi
			pct=$(awk -v p="$prog" 'BEGIN { printf "%.1f", p * 100 }')
			w=40
			filled=$(awk -v p="$prog" 'BEGIN { f = int(p * 40 + 0.5); print (f < 0 ? 0 : (f > 40 ? 40 : f)) }')
			bar=""
			for ((i = 0; i < filled; i++)); do bar+="█"; done
			for ((i = filled; i < w; i++)); do bar+="░"; done
			if ! $JSON_OUT; then
				if [ -n "$tps" ]; then
					echo "Slot $slot [generating] [$bar] $pct%  $decoded/$total tokens  $tps tok/s  ETA $eta"
				else
					echo "Slot $slot [generating] [$bar] $pct%  $decoded/$total tokens  ETA $eta"
				fi
			fi
			JSON_SLOTS+="$(printf '{"id":%d,"type":"generating","progress":%.4f,"decoded":%d,"total":%d,"tps":%s,"eta":"%s"},' "$slot" "$prog" "$decoded" "$total" "${tps:-0}" "$eta")"
			NEW_STATE+="gen $slot $NOW_S ${decoded:-0}"$'\n'
		done <<<"$GEN_SLOTS"
	fi

	printf '%s' "$NEW_STATE" >"$STATE_FILE"
fi

if $JSON_OUT; then
	# Remove trailing comma from JSON_SLOTS
	JSON_SLOTS="${JSON_SLOTS%,}"
	if $SLOTS_ONLY; then
		printf '{"slots":[%s]}\n' "$JSON_SLOTS"
	else
		printf '{"ram":{"used":"%s","total":"%s","avail":"%s"},"gpu":"%s","slots":[%s]}\n' \
			"$rused_g" "$rtotal_g" "$ravail_g" "$gpu_line" "$JSON_SLOTS"
	fi
	exit 0
fi

echo ''
echo "=== LLAMA SERVER LOG (last $LOG_LINES) ==="
echo "$LOG" | tail -n "$LOG_LINES"
