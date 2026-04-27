/**
 * One-time initialization of the entros-registry ProtocolConfig on devnet.
 * Run from protocol-core directory: npx ts-node scripts/init-registry.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const REGISTRY_PROGRAM_ID = new PublicKey("6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW");

async function main() {
  // Always use the admin keypair — never the relayer.
  // The admin key controls ProtocolConfig and treasury withdrawal.
  const keypairPath = process.env.ADMIN_KEYPAIR_PATH ||
    path.resolve(__dirname, "../../.config/admin-devnet.json");

  const raw = fs.readFileSync(keypairPath, "utf-8");
  const secretKey = new Uint8Array(JSON.parse(raw));
  const admin = Keypair.fromSecretKey(secretKey);

  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const idl = await anchor.Program.fetchIdl(REGISTRY_PROGRAM_ID, provider);
  if (!idl) throw new Error("Failed to fetch registry IDL");

  const program = new anchor.Program(idl, provider) as any;

  const [protocolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    REGISTRY_PROGRAM_ID
  );

  console.log(`ProtocolConfig PDA: ${protocolConfigPda.toBase58()}`);

  // Check if already initialized
  const existing = await connection.getAccountInfo(protocolConfigPda);
  if (existing) {
    console.log("ProtocolConfig already initialized.");
    return;
  }

  const MIN_STAKE = new anchor.BN(1_000_000_000); // 1 SOL
  const CHALLENGE_EXPIRY = new anchor.BN(300); // 5 minutes
  const MAX_TRUST_SCORE = 10000;
  const BASE_TRUST_INCREMENT = 100;

  const tx = await program.methods
    .initializeProtocol(
      MIN_STAKE,
      CHALLENGE_EXPIRY,
      MAX_TRUST_SCORE,
      BASE_TRUST_INCREMENT
    )
    .accounts({
      admin: admin.publicKey,
      protocolConfig: protocolConfigPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`ProtocolConfig initialized: ${tx}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
