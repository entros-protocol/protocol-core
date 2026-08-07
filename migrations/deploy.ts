import type { AnchorProvider } from "@coral-xyz/anchor";

const anchor = require("@coral-xyz/anchor");

module.exports = async function (provider: AnchorProvider) {
  anchor.setProvider(provider);
};
