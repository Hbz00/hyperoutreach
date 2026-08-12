import { resolve } from "node:path";

import { runEvaluationFile } from "@/modules/evaluation/harness";

const fixturePath = resolve(process.argv[2] ?? "evals/fixtures/v1.json");

try {
  const execution = await runEvaluationFile(fixturePath);
  console.log(execution.output);
  process.exitCode = execution.exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Evaluation could not run: ${message}`);
  process.exitCode = 1;
}
