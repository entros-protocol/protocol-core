import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Byte offsets into the raw account data (8-byte Anchor discriminator first).
// Challenge:           [disc 8][challenger 32][nonce 32][created_at 8][expires_at 8][used 1][bump 1]
// VerificationResult:  [disc 8][verifier 32][...]
const CHALLENGER_OFFSET = 8;
const USED_OFFSET = 88;
const VERIFIER_OFFSET = 8;

// Read the authoritative account discriminator straight from the loaded IDL
// rather than recomputing sha256("account:<Name>") — same bytes, one source.
function accountDiscriminator(idl: anchor.Idl, name: string): Buffer {
  const account = idl.accounts?.find((entry) => entry.name === name);
  if (!account) {
    throw new Error(`Account "${name}" not found in the verifier IDL.`);
  }
  return Buffer.from(account.discriminator);
}

function readBool(data: Buffer, offset: number): boolean {
  return data.readUInt8(offset) !== 0;
}

async function main(): Promise<void> {
  const walletArg = process.argv[2];
  if (!walletArg) {
    console.error("Usage: npm run cleanup-pdas -- <wallet-address>");
    process.exit(1);
  }

  const targetWallet = new anchor.web3.PublicKey(walletArg);
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const signerWallet = provider.wallet.publicKey;
  if (!signerWallet.equals(targetWallet)) {
    throw new Error(
      `Signer wallet (${signerWallet.toBase58()}) must match target wallet (${targetWallet.toBase58()}) to close PDA accounts.`,
    );
  }

  // Resolve the IDL relative to this file (ESM: no __dirname under `node`).
  const idlPath = fileURLToPath(
    new URL("../target/idl/entros_verifier.json", import.meta.url),
  );
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as anchor.Idl;
  const program = new anchor.Program(idl, provider);
  const verifierProgramId = program.programId;

  const challengeDisc = accountDiscriminator(idl, "Challenge");
  const verificationResultDisc = accountDiscriminator(idl, "VerificationResult");

  const challengeAccounts = await provider.connection.getProgramAccounts(
    verifierProgramId,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchor.utils.bytes.bs58.encode(challengeDisc),
          },
        },
        {
          memcmp: {
            offset: CHALLENGER_OFFSET,
            bytes: targetWallet.toBase58(),
          },
        },
      ],
    },
  );

  // Only `used` challenges are closeable: close_challenge enforces
  // `constraint = challenge.used`. Expired-but-unused challenges are rejected
  // on-chain, so attempting them would only burn failed transactions.
  const closeableChallenges = challengeAccounts.filter(({ account }) =>
    readBool(account.data, USED_OFFSET),
  );

  const verificationAccounts = await provider.connection.getProgramAccounts(
    verifierProgramId,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchor.utils.bytes.bs58.encode(verificationResultDisc),
          },
        },
        {
          memcmp: {
            offset: VERIFIER_OFFSET,
            bytes: targetWallet.toBase58(),
          },
        },
      ],
    },
  );

  const challengeLamports = closeableChallenges.reduce(
    (sum, { account }) => sum + account.lamports,
    0,
  );

  const verificationLamports = verificationAccounts.reduce(
    (sum, { account }) => sum + account.lamports,
    0,
  );

  let closedChallenges = 0;
  let closedVerificationResults = 0;
  let reclaimedLamports = 0;

  for (const { pubkey, account } of closeableChallenges) {
    try {
      await program.methods
        .closeChallenge()
        .accounts({
          challenger: targetWallet,
          challenge: pubkey,
        })
        .rpc();

      closedChallenges += 1;
      reclaimedLamports += account.lamports;
    } catch (error) {
      console.error(
        `Failed to close challenge ${pubkey.toBase58()}: ${(error as Error).message}`,
      );
    }
  }

  for (const { pubkey, account } of verificationAccounts) {
    try {
      await program.methods
        .closeVerificationResult()
        .accounts({
          verifier: targetWallet,
          verificationResult: pubkey,
        })
        .rpc();

      closedVerificationResults += 1;
      reclaimedLamports += account.lamports;
    } catch (error) {
      console.error(
        `Failed to close verification result ${pubkey.toBase58()}: ${(error as Error).message}`,
      );
    }
  }

  const totalCandidates =
    closeableChallenges.length + verificationAccounts.length;
  const totalClosed = closedChallenges + closedVerificationResults;

  console.log("\nCleanup Summary");
  console.log("---------------");
  console.log(`Target wallet: ${targetWallet.toBase58()}`);
  console.log(`Challenge PDAs found: ${challengeAccounts.length}`);
  console.log(`Challenge PDAs eligible (used): ${closeableChallenges.length}`);
  console.log(`Challenge PDAs closed: ${closedChallenges}`);
  console.log(`VerificationResult PDAs found: ${verificationAccounts.length}`);
  console.log(`VerificationResult PDAs closed: ${closedVerificationResults}`);
  console.log(`Total close attempts: ${totalCandidates}`);
  console.log(`Total closed: ${totalClosed}`);
  console.log(
    `Estimated reclaimable SOL before tx fees: ${(
      (challengeLamports + verificationLamports) /
      anchor.web3.LAMPORTS_PER_SOL
    ).toFixed(9)}`,
  );
  console.log(
    `SOL reclaimed (excluding tx fees): ${(
      reclaimedLamports / anchor.web3.LAMPORTS_PER_SOL
    ).toFixed(9)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
