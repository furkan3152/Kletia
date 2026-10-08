import { spawn } from "node:child_process";

const releaseEnvironment = {
  ARBITRUM_SEPOLIA_MVP_ENABLED: "true",
};

const child = spawn(
  process.execPath,
  ["--import", "tsx", "src/index.ts"],
  {
    cwd: process.cwd(),
    env: { ...process.env, ...releaseEnvironment },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
