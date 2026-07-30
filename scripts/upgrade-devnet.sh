#!/bin/bash
set -e

# Change directory to protocol-core root if running from elsewhere
cd "$(dirname "$0")/.."

echo "Building programs..."
anchor build

echo "Upgrading entros-anchor program..."
solana program deploy -u devnet --program-id GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2 target/deploy/entros_anchor.so

echo "Upgrading entros-verifier program..."
solana program deploy -u devnet --program-id 4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV target/deploy/entros_verifier.so

echo "Upgrading entros-registry program..."
solana program deploy -u devnet --program-id 6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW target/deploy/entros_registry.so

echo "Deployment and upgrades complete!"
