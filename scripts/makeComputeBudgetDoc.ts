import fs from "node:fs";
import { maxComputeBudgets } from "../tests-litesvm-ts/cu-budgets.ts";
import { toHumanInt } from "../tests-litesvm-ts/encodeDecode.ts";

//To run this script: node ./scripts/makeComputeBudgetDoc.ts

const computeBudgetDocPath = "docs/compute-budget-template.md";
const computeBudgetOutput = "docs/compute-budget.md";
//const computeBudgetOutput = "docs/compute-budget-output.md";

const content = fs.readFileSync(computeBudgetDocPath).toString(); //"utf-8"

const isFound = (str: string, target: string) => {
  return str.indexOf(target) > -1 ? "Found" : "NotFound";
};
console.log("\nfnName, maxComputeUnit");
let computeUnitHeadroom = 0;
let newContent = content;
for (const [fnName, maxComputeUnit] of Object.entries(maxComputeBudgets)) {
  console.log(
    fnName,
    maxComputeUnit,
    isFound(content, `@${fnName}`),
    isFound(content, `@${fnName}H`),
  );
  newContent = newContent.replace(`@${fnName}`, toHumanInt(maxComputeUnit));

  computeUnitHeadroom = 200000 - maxComputeUnit;
  newContent = newContent.replace(
    `@${fnName}H`,
    toHumanInt(computeUnitHeadroom),
  );
}
//console.log("content:", newContent.substring(328, 375));
fs.writeFileSync(computeBudgetOutput, newContent);

console.log(
  `Compute Budget doc has been generated successfully in ${computeBudgetOutput}`,
);
