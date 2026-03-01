import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { createProxyMiddleware } from "./proxy/middleware.js";
import { runTestRunner } from "./proxy/runner.js";

console.log('Starting proxy server...');

dotenv.config();

const rawBodyMiddleware = (req: Request, res: Response, next: NextFunction) => {
  let data: Buffer[] = [];
  req.on("data", (chunk) => {
    data.push(chunk);
  });
  req.on("end", () => {
    req.body = Buffer.concat(data);
    next();
  });
};

async function main() {
  const args = process.argv.slice(2);
  let mode: "record" | "replay" | "continue" | "verify" | null = null;
  let recordingId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode" && args[i + 1]) mode = args[i + 1] as any;
    if (args[i] === "--id" && args[i + 1]) recordingId = args[i + 1];
  }

  if (!mode || !["record", "replay", "continue", "verify"].includes(mode)) {
    console.error(
      "Usage: ts-node proxy.ts --mode <record|replay|continue|verify> --id <recording_id>"
    );
    process.exit(1);
  }

  if (!recordingId) {
    console.error("Error: --id <recording_id> is required.");
    process.exit(1);
  }

  const port = process.env.PORT || 9090;
  const primaryBackend = process.env.PRIMARY_BACKEND;
  const testingBackend = process.env.TESTING_BACKEND;

  if (mode === "verify") {
    if (!primaryBackend || !testingBackend) {
      console.error(
        "Error: PRIMARY_BACKEND and TESTING_BACKEND env vars are required for verify mode."
      );
      process.exit(1);
    }
    await runTestRunner({ recordingId, primaryBackend, testingBackend });
    process.exit(0);
  } else {
    if (!primaryBackend) {
      console.error("Error: PRIMARY_BACKEND env var is required.");
      process.exit(1);
    }

    // Extract SECONDARY_BACKENDS (BACKEND_1, BACKEND_2, etc.)
    const secondaryBackends: string[] = [];
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("BACKEND_") && process.env[key]) {
        secondaryBackends.push(process.env[key] as string);
      }
    }

    const app = express();

    // Parse all incoming bodies as raw buffer
    app.use(rawBodyMiddleware);

    // Apply the proxy middleware
    app.use(
      createProxyMiddleware({
        mode,
        recordingId,
        primaryBackend,
        secondaryBackends,
      })
    );

    app.listen(port, () => {
      console.log(`🚀 Proxy running on http://localhost:${port}`);
      console.log(`📡 Mode: ${mode}`);
      console.log(`📁 Recording ID: ${recordingId}`);
      console.log(`🎯 Primary Backend: ${primaryBackend}`);
      console.log(
        `🔄 Secondary Backends: ${secondaryBackends.join(", ") || "None"}`
      );
    });
  }
}

main().catch(console.error);
