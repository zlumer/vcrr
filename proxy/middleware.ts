import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import {
  getDirectoryPath,
  getFilename,
  getBackendName,
  saveFile,
  parseFile,
  generateDiff,
  getQueryHash,
} from "./utils";
import { processHandlers, validateResponse } from "./handlers";

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
      const resFilename = getFilename(metadata, "res");
      const reqFilename = getFilename(metadata, "req");

      const primaryResPath = path.join(primaryDir, resFilename);
      const fallbackResFilename = getFilename(
        { ...metadata, sequenceIndex: 0 },
        "res"
      ).replace(".0.res", ".res");
      const primaryFallbackPath = path.join(primaryDir, fallbackResFilename);

      // 1. Process custom TS handlers first
      // processHandlers logs requestSchema failures and handles the response if an Express handler is exported
      const handlerResult = await processHandlers(req, res, metadata, baseDir);
      if (handlerResult.handled) {
        // Express handler took over
        return;
      }

      const hasExactRecording = fs.existsSync(primaryResPath);

      if (
        options.mode === "replay" ||
        (options.mode === "continue" && hasExactRecording)
      ) {
        let pathToPlay = primaryResPath;
        if (!hasExactRecording) {
          if (options.mode === "replay" && fs.existsSync(primaryFallbackPath)) {
            pathToPlay = primaryFallbackPath;
          } else {
            res
              .status(502)
              .json({
                error: "Sequence exhausted, no fallback found",
                cacheKey,
                sequenceIndex,
              });
            return;
          }
        }

        const content = fs.readFileSync(pathToPlay, "utf8");
        const parsed = parseFile(content);

        Object.entries(parsed.headers).forEach(([k, v]) => {
          if (k.toLowerCase() !== "transfer-encoding") {
            res.setHeader(k, v);
          }
        });

        res.status(parsed.frontmatter.status || 200).send(parsed.body);
        return;
      }

      const timeSinceStartMs = Date.now() - sessionStartTime;
      const reqHeaders = { ...req.headers };
      delete reqHeaders["host"];

      const bodyStr = req.body ? req.body.toString("utf8") : "";

      saveFile(
        path.join(primaryDir, reqFilename),
        { timeSinceStartMs, fullUrl, method },
        reqHeaders as any,
        bodyStr
      );

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
          const proxyResBody = Buffer.from(arrayBuffer).toString("utf8");

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
        } catch (err: any) {
          return {
            url: backendUrl,
            status: 500,
            headers: {},
            body: err.message,
            timeTakenMs: Date.now() - start,
            error: err,
          };
        }
      });

      const primaryPromise = fetchPromises[0];
      const secondaryPromises = fetchPromises.slice(1);

      primaryPromise
        .then((primaryResult) => {
          saveFile(
            path.join(primaryDir, resFilename),
            {
              status: primaryResult.status,
              timeSinceStartMs,
              timeTakenMs: primaryResult.timeTakenMs,
            },
            primaryResult.headers,
            primaryResult.body
          );

          // Validate response schema for primary backend
          validateResponse(
            handlerResult.responseSchema,
            primaryResult.headers,
            primaryResult.body,
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
              const secReqPath = path.join(secDir, reqFilename);
              const secResPath = path.join(secDir, resFilename);
              const secDiffPath = path.join(
                secDir,
                getFilename(metadata, "diff")
              );

              saveFile(
                secReqPath,
                { timeSinceStartMs, fullUrl, method },
                reqHeaders as any,
                bodyStr
              );

              saveFile(
                secResPath,
                {
                  status: secResult.status,
                  timeSinceStartMs,
                  timeTakenMs: secResult.timeTakenMs,
                  error: secResult.error ? true : undefined,
                },
                secResult.headers,
                secResult.body
              );

              let primaryBodyJson = primaryResult.body;
              let secBodyJson = secResult.body;
              try {
                primaryBodyJson = JSON.parse(primaryResult.body);
              } catch (e) {}
              try {
                secBodyJson = JSON.parse(secResult.body);
              } catch (e) {}

              const diffOutput = generateDiff(primaryBodyJson, secBodyJson);
              if (diffOutput && diffOutput.trim() !== "") {
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
