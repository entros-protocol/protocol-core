import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { IamRegistry } from "../target/types/iam_registry";
import type { IamAnchor } from "../target/types/iam_anchor";
import type { IamVerifier } from "../target/types/iam_verifier";
import { loadProofFixture } from "./utils";

const fixture = loadProofFixture();

describe("e2e: full IAM verification flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const registry = anchor.workspace.iamRegistry as Program<IamRegistry>;
  const iamAnchor = anchor.workspace.iamAnchor as Program<IamAnchor>;
  const verifier = anchor.workspace.iamVerifier as Program<IamVerifier>;

  // Use a fresh user for e2e to avoid conflicts with per-program tests
  const e2eUser = anchor.web3.Keypair.generate();

  const [protocolConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    registry.programId
  );
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    registry.programId
  );
  const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    iamAnchor.programId
  );

  const [treasuryPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_treasury")],
    registry.programId
  );

  // Commitments must match the fixture proof's public_inputs so that
  // update_anchor's cross-program binding check passes: the fixture proves
  // Hamming(ft_new, ft_prev) ∈ [3, 30) where the commitments are the Poseidon
  // hashes of those fingerprints. commitment_prev becomes the mint's initial
  // commitment; commitment_new becomes the updated value.
  const initialCommitment = Buffer.from(fixture.public_inputs[1]);
  const newCommitment = Buffer.from(fixture.public_inputs[0]);

  it("completes the full Phase 1 flow", async () => {
    // Fund the e2e user
    const sig = await provider.connection.requestAirdrop(
      e2eUser.publicKey,
      10_000_000_000
    );
    await provider.connection.confirmTransaction(sig);

    // 1. Protocol config (already initialized by iam-registry tests — just verify)
    const config = await registry.account.protocolConfig.fetch(protocolConfigPda);
    expect(config.maxTrustScore).to.equal(10000);

    // 2. Register a validator (fresh keypair)
    const validatorKeypair = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      validatorKeypair.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [validatorStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("validator"), validatorKeypair.publicKey.toBuffer()],
      registry.programId
    );

    await registry.methods
      .registerValidator(new anchor.BN(1_000_000_000))
      .accountsStrict({
        validator: validatorKeypair.publicKey,
        protocolConfig: protocolConfigPda,
        validatorState: validatorStatePda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([validatorKeypair])
      .rpc();

    const validatorState = await registry.account.validatorState.fetch(validatorStatePda);
    expect(validatorState.isActive).to.be.true;

    // 3. User mints identity anchor
    const [identityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("identity"), e2eUser.publicKey.toBuffer()],
      iamAnchor.programId
    );
    const [mintPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("mint"), e2eUser.publicKey.toBuffer()],
      iamAnchor.programId
    );
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      e2eUser.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    await iamAnchor.methods
      .mintAnchor(Array.from(initialCommitment))
      .accountsStrict({
        user: e2eUser.publicKey,
        identityState: identityPda,
        mint: mintPda,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ata,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
      })
      .signers([e2eUser])
      .rpc();

    let identity = await iamAnchor.account.identityState.fetch(identityPda);
    expect(identity.verificationCount).to.equal(0);

    // 4. Create verification challenge
    const nonce = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
    const [challengePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("challenge"),
        e2eUser.publicKey.toBuffer(),
        Buffer.from(nonce),
      ],
      verifier.programId
    );

    await verifier.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: e2eUser.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([e2eUser])
      .rpc();

    // 5. Submit valid mock proof
    const [verificationPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("verification"),
        e2eUser.publicKey.toBuffer(),
        Buffer.from(nonce),
      ],
      verifier.programId
    );

    const mockProof = Buffer.from(fixture.proof_bytes);
    const publicInputs: number[][] = fixture.public_inputs;

    await verifier.methods
      .verifyProof(Buffer.from(mockProof), publicInputs, nonce)
      .accountsStrict({
        verifier: e2eUser.publicKey,
        challenge: challengePda,
        verificationResult: verificationPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([e2eUser])
      .rpc();

    const result = await verifier.account.verificationResult.fetch(verificationPda);
    expect(result.isValid).to.be.true;

    // 6. Update anchor with new commitment (trust score auto-computed).
    // Now requires the VerificationResult PDA + nonce as binding evidence —
    // without it, the instruction rejects. This is the post-2026-04-20 patch.
    await iamAnchor.methods
      .updateAnchor(Array.from(newCommitment), nonce)
      .accountsStrict({
        authority: e2eUser.publicKey,
        identityState: identityPda,
        verificationResult: verificationPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([e2eUser])
      .rpc();

    // 7. Verify final state
    identity = await iamAnchor.account.identityState.fetch(identityPda);
    expect(identity.verificationCount).to.equal(1);
    // Trust score auto-computed: 1 verification at day 0 → recency 100, base 100, age ~0
    expect(identity.trustScore).to.be.greaterThanOrEqual(100);
    expect(Buffer.from(identity.currentCommitment)).to.deep.equal(newCommitment);
    expect(identity.lastVerificationTimestamp.toNumber()).to.be.greaterThan(0);
  });
});
