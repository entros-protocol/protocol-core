#!/usr/bin/env bash

set -euo pipefail

readonly ANCHOR_PROGRAM_ID="GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2"
readonly VERIFIER_PROGRAM_ID="4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV"
readonly REGISTRY_PROGRAM_ID="6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW"
readonly RPC_URL="http://127.0.0.1:8899"

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIRECTORY/.." && pwd)"
readonly REPOSITORY_ROOT
readonly TEMPORARY_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

case "$TEMPORARY_BASE" in
  /*) ;;
  *)
    echo "Temporary directory base must be an absolute path." >&2
    exit 1
    ;;
esac

for command_name in anchor node solana-keygen solana-test-validator; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  fi
done

readonly ANCHOR_BINARY="$REPOSITORY_ROOT/target/deploy/entros_anchor.so"
readonly VERIFIER_BINARY="$REPOSITORY_ROOT/target/deploy/entros_verifier.so"
readonly REGISTRY_BINARY="$REPOSITORY_ROOT/target/deploy/entros_registry.so"

for program_binary in "$ANCHOR_BINARY" "$VERIFIER_BINARY" "$REGISTRY_BINARY"; do
  if [[ ! -f "$program_binary" ]]; then
    echo "Required program binary is unavailable: $program_binary" >&2
    exit 1
  fi
done

port_is_open() {
  node -e '
    const net = require("node:net");
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
    const timer = setTimeout(() => { socket.destroy(); process.exit(1); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(0); });
    socket.once("error", () => { clearTimeout(timer); process.exit(1); });
  ' "$1"
}

for port in 8899 8900 9900; do
  if port_is_open "$port"; then
    echo "Local test port $port is already in use. No process was changed." >&2
    exit 1
  fi
done

RUN_DIRECTORY="$(mktemp -d "$TEMPORARY_BASE/entros-protocol.XXXXXX")"
readonly RUN_DIRECTORY
readonly LEDGER_DIRECTORY="$RUN_DIRECTORY/ledger"
readonly VALIDATOR_LOG="$RUN_DIRECTORY/validator.log"
readonly PAYER_KEYPAIR="$RUN_DIRECTORY/payer.json"
VALIDATOR_PID=""

cleanup() {
  local status=$?
  local listener_open=false
  trap - EXIT

  if [[ "$VALIDATOR_PID" =~ ^[0-9]+$ ]] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi

  for _ in $(seq 1 50); do
    listener_open=false
    for port in 8899 8900 9900; do
      if port_is_open "$port"; then
        listener_open=true
        break
      fi
    done

    if [[ "$listener_open" == false ]]; then
      break
    fi
    sleep 0.1
  done

  if [[ "$listener_open" == true ]]; then
    echo "Local validator ports did not close." >&2
    status=1
  fi

  case "$RUN_DIRECTORY" in
    "$TEMPORARY_BASE"/entros-protocol.*)
      rm -r -- "$RUN_DIRECTORY"
      ;;
    *)
      echo "Refusing to remove an unexpected test directory." >&2
      status=1
      ;;
  esac

  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
if [[ -e "$PAYER_KEYPAIR" ]]; then
  echo "Temporary payer path already exists." >&2
  exit 1
fi
solana-keygen new \
  --no-bip39-passphrase \
  --silent \
  --outfile "$PAYER_KEYPAIR" \
  >/dev/null
PAYER_PUBLIC_KEY="$(solana-keygen pubkey "$PAYER_KEYPAIR")"
readonly PAYER_PUBLIC_KEY

solana-test-validator \
  --bind-address 127.0.0.1 \
  --rpc-port 8899 \
  --faucet-port 9900 \
  --mint "$PAYER_PUBLIC_KEY" \
  --ledger "$LEDGER_DIRECTORY" \
  --bpf-program "$ANCHOR_PROGRAM_ID" "$ANCHOR_BINARY" \
  --bpf-program "$VERIFIER_PROGRAM_ID" "$VERIFIER_BINARY" \
  --bpf-program "$REGISTRY_PROGRAM_ID" "$REGISTRY_BINARY" \
  >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!

validator_ready=false
for _ in $(seq 1 60); do
  if node -e '
    const { Connection } = require("@solana/web3.js");
    const connection = new Connection(process.argv[1], "confirmed");
    connection.getLatestBlockhash("confirmed")
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  ' "$RPC_URL"; then
    validator_ready=true
    break
  fi

  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    break
  fi

  sleep 1
done

if [[ "$validator_ready" != true ]]; then
  echo "Local validator did not become ready." >&2
  tail -n 80 "$VALIDATOR_LOG" >&2
  exit 1
fi

payer_funded=false
for _ in $(seq 1 30); do
  if node -e '
    const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
    const connection = new Connection(process.argv[1], "confirmed");
    connection.getBalance(new PublicKey(process.argv[2]))
      .then((balance) => process.exit(balance >= 100 * LAMPORTS_PER_SOL ? 0 : 1))
      .catch(() => process.exit(1));
  ' "$RPC_URL" "$PAYER_PUBLIC_KEY"; then
    payer_funded=true
    break
  fi
  sleep 1
done

if [[ "$payer_funded" != true ]]; then
  echo "Temporary payer was not funded." >&2
  tail -n 80 "$VALIDATOR_LOG" >&2
  exit 1
fi

cd "$REPOSITORY_ROOT"
if ! anchor test \
  --skip-build \
  --skip-deploy \
  --skip-local-validator \
  --provider.cluster localnet \
  --provider.wallet "$PAYER_KEYPAIR"; then
  echo "Local validator log tail:" >&2
  tail -n 120 "$VALIDATOR_LOG" >&2
  exit 1
fi

echo "Localnet test suite passed."
