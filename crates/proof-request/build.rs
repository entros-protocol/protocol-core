use serde::Deserialize;
use std::{env, error::Error, fs, path::PathBuf};

const ANCHOR: &str = "GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2";
const VERIFIER: &str = "4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV";
const REGISTRY: &str = "6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IsolatedPrograms {
    schema_version: u8,
    cluster: String,
    consumer_program: String,
    verifier_program: String,
    registry_program: String,
}

fn validate_address(address: &str) -> Result<(), Box<dyn Error>> {
    let bytes = bs58::decode(address).into_vec()?;
    if bytes.len() != 32 || bs58::encode(&bytes).into_string() != address {
        return Err("Isolated program addresses must use canonical 32-byte base58".into());
    }
    let reserved = [
        ANCHOR,
        VERIFIER,
        REGISTRY,
        "11111111111111111111111111111111",
        "BPFLoaderUpgradeab1e11111111111111111111111",
        "BPFLoader2111111111111111111111111111111111",
        "BPFLoader1111111111111111111111111111111111",
        "LoaderV411111111111111111111111111111111111",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "ComputeBudget111111111111111111111111111111",
        "Ed25519SigVerify111111111111111111111111111",
    ];
    if reserved.contains(&address) {
        return Err(
            "Isolated program addresses must differ from existing protocol and runtime programs"
                .into(),
        );
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-env-changed=ENTROS_ISOLATED_PROGRAM_IDS");
    let (anchor, verifier) = match env::var_os("ENTROS_ISOLATED_PROGRAM_IDS") {
        None => (ANCHOR.to_owned(), VERIFIER.to_owned()),
        Some(path) => {
            if env::var_os("CARGO_FEATURE_REQUEST_BOUND_V1").is_none() {
                return Err("Isolated program configuration requires request-bound-v1".into());
            }
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("ENTROS_ISOLATED_PROGRAM_IDS must name an absolute JSON path".into());
            }
            println!("cargo:rerun-if-changed={}", path.display());
            let config: IsolatedPrograms = serde_json::from_slice(&fs::read(path)?)?;
            if config.schema_version != 1 || config.cluster != "devnet" {
                return Err(
                    "Isolated program configuration requires schemaVersion 1 and devnet".into(),
                );
            }
            if config.registry_program != REGISTRY {
                return Err("Isolated programs must retain the existing Registry".into());
            }
            validate_address(&config.consumer_program)?;
            validate_address(&config.verifier_program)?;
            if config.consumer_program == config.verifier_program {
                return Err("Isolated Anchor and verifier addresses must differ".into());
            }
            (config.consumer_program, config.verifier_program)
        }
    };
    // Literal macro arguments preserve Anchor's generated IDL address metadata.
    let source = format!(
        r#"anchor_lang::declare_id!("{verifier}");
pub const ANCHOR_ID: anchor_lang::prelude::Pubkey = anchor_lang::pubkey!("{anchor}");
#[macro_export]
macro_rules! declare_anchor_program_id {{
    () => {{ anchor_lang::declare_id!("{anchor}"); }};
}}
#[macro_export]
macro_rules! declare_verifier_program_id {{
    () => {{ anchor_lang::declare_id!("{verifier}"); }};
}}
"#
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").ok_or("Cargo OUT_DIR is missing")?);
    fs::write(output.join("program_ids.rs"), source)?;
    Ok(())
}
