import fs from "node:fs";
import { maxComputeBudgets } from "../tests-litesvm-ts/cu-budgets.ts";
import { toHumanInt } from "../tests-litesvm-ts/encodeDecode.ts";

//To run this script: node ./scripts/makeComputeBudgetDoc.ts

const computeBudgetDocPath = "docs/compute-budget-template.md";
const computeBudgetOutput = "docs/compute-budget.md";
//const computeBudgetOutput = "docs/compute-budget-output.md";

const content = fs.readFileSync(computeBudgetDocPath).toString(); //"utf-8"

const isFound = (str: string, target: string) => {
  return str.indexOf(target) > -1;
};
console.log("\nfnName, maxComputeUnit");
let headroom = 0;
let newContent = content;
for (const [fnName, maxComputeUnit] of Object.entries(maxComputeBudgets)) {
  console.log(fnName, maxComputeUnit);
  if (!isFound(content, `@${fnName}@`) || !isFound(content, `@${fnName}H@`))
    throw new Error("fnName or fnNameHeadroom not found");

  newContent = newContent.replace(`@${fnName}@`, toHumanInt(maxComputeUnit));
  newContent = newContent.replace(`@${fnName}@`, toHumanInt(maxComputeUnit));

  headroom = 200000 - maxComputeUnit;
  newContent = newContent.replace(`@${fnName}H@`, toHumanInt(headroom));
}

// Re-verification compute budgets
let maxComputeUnit =
  maxComputeBudgets.create_challenge +
  maxComputeBudgets.verify_proof +
  maxComputeBudgets.update_anchor;
headroom = 250000 - maxComputeUnit;

newContent = newContent.replace(
  `@Re-verification@`,
  toHumanInt(maxComputeUnit),
);
newContent = newContent.replace(`@Re-verificationH@`, toHumanInt(headroom));

// FirstVerification compute budgets
maxComputeUnit =
  maxComputeBudgets.create_challenge +
  maxComputeBudgets.verify_proof +
  maxComputeBudgets.mint_anchor;
headroom = 250000 - maxComputeUnit;

newContent = newContent.replace(
  `@First-verification@`,
  toHumanInt(maxComputeUnit),
);
newContent = newContent.replace(`@First-verificationH@`, toHumanInt(headroom));

fs.writeFileSync(computeBudgetOutput, newContent);

console.log(
  `Compute Budget doc has been generated successfully in ${computeBudgetOutput}`,
);
