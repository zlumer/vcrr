import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { createProxyMiddleware } from "./proxy/middleware.js";
import { runTestRunner } from "./proxy/runner.js";
import { runDiffTool } from "./proxy/diff.js";

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
  let mode: string | undefined;
  let recordingId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode")
		mode = args[++i];
    if (args[i] === "--id")
		recordingId = args[++i];
  }

  const validModes = ["record", "replay", "continue", "verify", "diff"];
  if (!mode || !validModes.includes(mode)) {
    console.error(
      "Usage: ts-node proxy.ts --mode <record|replay|continue|verify|diff> --id <recording_id>"
    );
    process.exit(1);
  }

  if (!recordingId) {
    console.error("Error: --id <recording_id> is required.");
    process.exit(1);
  }

  // Sanitize recordingId to prevent path traversal
  if (recordingId.includes("..") || recordingId.includes("/") || recordingId.includes("\\")) {
    console.error("Error: Invalid recording ID. Path traversal characters not allowed.");
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
  } else if (mode === "diff") {
    await runDiffTool({ recordingId });
    process.exit(0);
  } else {
    if (!primaryBackend) {
      console.error("Error: PRIMARY_BACKEND env var is required.");
      process.exit(1);
    }

    // Extract SECONDARY_BACKENDS (BACKEND_1, BACKEND_2, etc.)
    const secondaryBackends: string[] = [];
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("BACKEND_")) {
        const val = process.env[key];
        if (val) {
          secondaryBackends.push(val);
        }
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
