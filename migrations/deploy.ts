import type { AnchorProvider } from "@anchor-lang/core";

const anchor = require("@anchor-lang/core");

module.exports = async function (provider: AnchorProvider) {
  anchor.setProvider(provider);
};
