#!/usr/bin/env bash

set -euo pipefail

readonly TEST_FILES=(
  "tests-litesvm-ts/clock-tests.ts"
  "tests-litesvm-ts/encrypted-baseline-tests.ts"
  "tests-litesvm-ts/mint-receipt-tests.ts"
  "tests-litesvm-ts/reset-receipt-tests.ts"
  "tests-litesvm-ts/reset-tests.ts"
  "tests-litesvm-ts/test-coverage.ts"
  "tests-litesvm-ts/token2022-expansion.ts"
  "tests-litesvm-ts/transfer-sol.ts"
  "tests-litesvm-ts/wallet-migration.ts"
)

for test_file in "${TEST_FILES[@]}"; do
  node "$test_file"
done
