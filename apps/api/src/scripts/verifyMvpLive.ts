import * as dotenv from "dotenv";

dotenv.config();

const { readKletiaMvpReadiness } = await import("../release/mvpReadiness.js");
const report = await readKletiaMvpReadiness(true);

console.log(JSON.stringify(report, null, 2));
if (!report.ready) {
  const blockers = report.checks
    .filter((check) => check.required && check.status !== "ready")
    .map((check) => check.id)
    .join(", ");
  throw new Error(`Live MVP preflight failed: ${blockers || "unknown blocker"}.`);
}
console.log("Kletia live MVP preflight passed without mock data. User-funded wallet smokes are still required.");
