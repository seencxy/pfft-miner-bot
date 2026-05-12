#!/usr/bin/env bash
set -euo pipefail

: "${PFFT_RPC_URL:?Set PFFT_RPC_URL first}"
: "${PFFT_PRIVATE_KEY:?Set PFFT_PRIVATE_KEY first}"

LOG_FILE="${PFFT_LOG_FILE:-/root/pfft-miner.log}"
COUNT="${PFFT_COUNT:-0}"   # 0 = infinite loop

cd "$(dirname "$0")"

if [ ! -x ./build/pfft-cuda-miner ]; then
  echo "CUDA binary not found. Building..."
  make cuda
fi

echo "Starting PFFT GPU miner loop..."
echo "count=$COUNT log=$LOG_FILE"

exec node pfft-miner.mjs mine --gpu --count "$COUNT" 2>&1 | tee -a "$LOG_FILE"
