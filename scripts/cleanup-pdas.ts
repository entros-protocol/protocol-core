import * as anchor from "@coral-xyz/anchor";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const IAM_VERIFIER_PROGRAM_ID = new anchor.web3.PublicKey(
  "4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV",
);

const CHALLENGER_OFFSET = 8;
const EXPIRES_AT_OFFSET = 80;
const USED_OFFSET = 88;
const VERIFIER_OFFSET = 8;

function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function readI64LE(data: Buffer, offset: number): bigint {
  return data.readBigInt64LE(offset);
}

function readBool(data: Buffer, offset: number): boolean {
  return data.readUInt8(offset) !== 0;
}

async function main(): Promise<void> {
  const walletArg = process.argv[2];
  if (!walletArg) {
    console.error("Usage: npx tsx scripts/cleanup-pdas.ts <wallet-address>");
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

  const idlPath = path.resolve(__dirname, "../target/idl/iam_verifier.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as anchor.Idl;
  const program = new anchor.Program(idl, provider);

  const challengeDisc = accountDiscriminator("Challenge");
  const verificationResultDisc = accountDiscriminator("VerificationResult");

  const challengeAccounts = await provider.connection.getProgramAccounts(
    IAM_VERIFIER_PROGRAM_ID,
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

  const nowTs = BigInt(Math.floor(Date.now() / 1000));
  const closeableChallenges = challengeAccounts.filter(({ account }) => {
    const expiresAt = readI64LE(account.data, EXPIRES_AT_OFFSET);
    const used = readBool(account.data, USED_OFFSET);
    return used || expiresAt <= nowTs;
  });

  const verificationAccounts = await provider.connection.getProgramAccounts(
    IAM_VERIFIER_PROGRAM_ID,
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
  console.log(`Challenge PDAs eligible: ${closeableChallenges.length}`);
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
