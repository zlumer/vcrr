import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import {
  getDirectoryPath,
  getFilename,
  getBackendName,
  saveHurlRequest,
  appendHurlResponse,
  parseHurl,
  generateDiff,
  getQueryHash,
  parseCookies,
} from "./utils.js";
import { processHandlers, validateResponse } from "./handlers.js";

const requestCounters: Record<string, number> = {};
let sessionStartTime = Date.now();

export interface ProxyOptions {
  mode: "record" | "replay" | "continue";
  recordingId: string;
  primaryBackend: string;
  secondaryBackends: string[];
}

export function createProxyMiddleware(options: ProxyOptions) {
  const baseDir = path.join(process.cwd(), "recordings");

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const method = req.method;
      const urlPath = req.path;
      const query = req.query;
      const queryHash = getQueryHash(query);
      const fullUrl = req.originalUrl;

      const primaryBackendName = getBackendName(options.primaryBackend);
      const secondaryBackendNames = options.secondaryBackends.map((url) =>
        getBackendName(url)
      );

      const cacheKey = `${method}:${urlPath}:${queryHash}`;
      requestCounters[cacheKey] = (requestCounters[cacheKey] || 0) + 1;
      const sequenceIndex = requestCounters[cacheKey];

      const metadata = {
        recordingId: options.recordingId,
        backendName: primaryBackendName,
        method,
        urlPath,
        query,
        sequenceIndex,
      };

      const primaryDir = getDirectoryPath(baseDir, metadata);
      const hurlFilename = getFilename(metadata, "hurl");
      const primaryHurlPath = path.join(primaryDir, hurlFilename);

      // 1. Process custom TS handlers first
      const handlerResult = await processHandlers(req, res, metadata, baseDir);
      if (handlerResult.handled) {
        return;
      }

      const hasExactRecording = fs.existsSync(primaryHurlPath);

      if (
        options.mode === "replay" ||
        (options.mode === "continue" && hasExactRecording)
      ) {
        if (!hasExactRecording) {
            // Fallback logic could be added here if needed, but for now we follow the exact sequence
            res.status(502).json({
                error: "Sequence exhausted, no recording found",
                cacheKey,
                sequenceIndex,
            });
            return;
        }

        const content = fs.readFileSync(primaryHurlPath, "utf8");
        const interaction = parseHurl(content, primaryHurlPath);

        if (interaction.response) {
            Object.entries(interaction.response.headers).forEach(([k, v]) => {
                if (k.toLowerCase() !== "transfer-encoding") {
                    res.setHeader(k, v);
                }
            });
            res.status(interaction.response.status).send(interaction.response.body);
            return;
        }
      }

      const timeSinceStartMs = Date.now() - sessionStartTime;
      const reqHeaders = { ...req.headers };
      delete reqHeaders["host"];

      const cookieHeader = req.headers.cookie;
      const cookies = typeof cookieHeader === "string" ? parseCookies(cookieHeader) : {};

      // Start recording the request immediately
      const interaction = {
        metadata: { 
            timeSinceStartMs: String(timeSinceStartMs), 
            fullUrl: String(fullUrl), 
            method: String(method), 
            sequenceIndex: String(sequenceIndex) 
        },
        request: {
          method,
          url: `${req.protocol}://${req.get("host")}${urlPath}`,
          headers: reqHeaders as Record<string, string>, // This cast is still needed because fetch headers are stricter, but I'll see if I can clean up
          query: query as Record<string, unknown>,
          cookies,
          body: req.body,
        },
      };

      saveHurlRequest(primaryHurlPath, interaction);

      const fetchPromises = [
        options.primaryBackend,
        ...options.secondaryBackends,
      ].map(async (backendUrl) => {
        const start = Date.now();
        const url = new URL(urlPath, backendUrl);
        Object.entries(query).forEach(([k, v]) =>
          url.searchParams.append(k, String(v))
        );

        try {
          const proxyRes = await fetch(url.toString(), {
            method,
            headers: reqHeaders as Record<string, string>,
            body: ["GET", "HEAD"].includes(method)
              ? undefined
              : req.body && req.body.length
                ? req.body
                : undefined,
          });

          const timeTakenMs = Date.now() - start;
          const arrayBuffer = await proxyRes.arrayBuffer();
          const proxyResBody = Buffer.from(arrayBuffer);

          const resHeaders: Record<string, string> = {};
          proxyRes.headers.forEach((v, k) => {
            resHeaders[k] = v;
          });

          return {
            url: backendUrl,
            status: proxyRes.status,
            headers: resHeaders,
            body: proxyResBody,
            timeTakenMs,
            error: null,
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            url: backendUrl,
            status: 502, // Bad Gateway as it failed to connect to backend
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ error: "Backend failure", details: errMsg })),
            timeTakenMs: Date.now() - start,
            error: err,
          };
        }
      });

      const primaryPromise = fetchPromises[0];
      const secondaryPromises = fetchPromises.slice(1);

      primaryPromise
        .then((primaryResult) => {
          appendHurlResponse(primaryHurlPath, {
            status: primaryResult.status,
            headers: primaryResult.headers,
            body: primaryResult.body,
          });

          // Validate response schema for primary backend
          validateResponse(
            handlerResult.responseSchema,
            primaryResult.headers,
            primaryResult.body.toString("utf8"),
            primaryResult.status
          );

          Object.entries(primaryResult.headers).forEach(([k, v]) => {
            if (k.toLowerCase() !== "transfer-encoding") {
              res.setHeader(k, v);
            }
          });
          res.status(primaryResult.status).send(primaryResult.body);

          Promise.all(secondaryPromises).then((secondaryResults) => {
            secondaryResults.forEach((secResult, idx) => {
              const secBackendName = secondaryBackendNames[idx];
              const secDir = getDirectoryPath(baseDir, {
                ...metadata,
                backendName: secBackendName,
              });
              const secHurlPath = path.join(secDir, hurlFilename);

              saveHurlRequest(secHurlPath, {
                ...interaction,
                metadata: { ...interaction.metadata, backend: secBackendName }
              });

              appendHurlResponse(secHurlPath, {
                status: secResult.status,
                headers: secResult.headers,
                body: secResult.body,
              });

              let primaryBodyStr = primaryResult.body.toString("utf8");
              let secBodyStr = secResult.body.toString("utf8");
              let primaryBodyJson = primaryBodyStr;
              let secBodyJson = secBodyStr;
              try {
                primaryBodyJson = JSON.parse(primaryBodyStr);
              } catch (e) {}
              try {
                secBodyJson = JSON.parse(secBodyStr);
              } catch (e) {}

              const diffOutput = generateDiff(primaryBodyJson, secBodyJson, false);
              if (diffOutput && diffOutput.trim() !== "") {
                const secDiffPath = path.join(secDir, getFilename(metadata, "diff"));
                fs.writeFileSync(secDiffPath, diffOutput, "utf8");
              }
            });
          });
        })
        .catch((err) => {
          if (!res.headersSent) {
            res
              .status(502)
              .json({ error: "Primary backend failed", details: err.message });
          }
        });
    } catch (err) {
      if (!res.headersSent) {
        next(err);
      } else {
        console.error("Error after headers sent:", err);
      }
    }
  };
}
