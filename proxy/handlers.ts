import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { getDirectoryPath, getQueryHash, FileMetadata } from "./utils";
import { z } from "zod";

interface HandlerResult {
  handled: boolean;
  requestSchema?: z.ZodSchema;
  responseSchema?: z.ZodSchema;
}

export async function processHandlers(
  req: Request,
  res: Response,
  metadata: FileMetadata,
  baseDir: string
): Promise<HandlerResult> {
  const dirPath = getDirectoryPath(baseDir, metadata);
  const leaf =
    metadata.urlPath
      .replace(/^\/|\/$/g, "")
      .split("/")
      .pop() || "index";
  const method = metadata.method.toLowerCase();
  const hash = getQueryHash(metadata.query);
  const seq = metadata.sequenceIndex;

  // Paths from most specific to least specific
  const pathsToCheck = [
    path.join(dirPath, `${leaf}.${method}${hash ? "." + hash : ""}.${seq}.ts`),
    path.join(dirPath, `${leaf}.${method}${hash ? "." + hash : ""}.ts`),
    path.join(dirPath, `${leaf}.${method}.ts`),
    path.join(dirPath, `${leaf}.ts`),
  ];

  let requestSchema: z.ZodSchema | undefined;
  let responseSchema: z.ZodSchema | undefined;

  for (const handlerPath of pathsToCheck) {
    if (fs.existsSync(handlerPath)) {
      try {
        const mod = require(handlerPath);

        // Check for schemas
        if (mod.requestSchema) requestSchema = mod.requestSchema;
        if (mod.responseSchema) responseSchema = mod.responseSchema;

        // Execute Express handler if exported
        const handlerFunction = mod[method] || mod.default;
        if (typeof handlerFunction === "function") {
          // Wrap it to see if it sends a response
          await new Promise<void>((resolve, reject) => {
            const originalSend = res.send.bind(res);
            res.send = function (body) {
              originalSend(body);
              resolve();
              return this;
            };
            const originalJson = res.json.bind(res);
            res.json = function (body) {
              originalJson(body);
              resolve();
              return this;
            };

            try {
              handlerFunction(req, res, () => {
                resolve(); // Next was called, it didn't fully handle the response
              });
            } catch (err) {
              reject(err);
            }
          });

          if (res.headersSent) {
            return { handled: true, requestSchema, responseSchema };
          }
        }

        // If we found a matching file, we stop checking less specific ones
        break;
      } catch (err) {
        console.error(`Error loading TS handler ${handlerPath}:`, err);
      }
    }
  }

  // Validate request schema if exists
  if (requestSchema) {
    const bodyStr = req.body ? req.body.toString("utf8") : "";
    const target = {
      headers: req.headers,
      body: bodyStr,
      query: req.query,
    };

    // Attempt to parse body as JSON if possible
    let finalBody: unknown = bodyStr;
    try {
      finalBody = JSON.parse(bodyStr);
    } catch (e) {}
    target.body = finalBody as any; // Zod might expect any, but I'll try to be cleaner if I can

    const result = requestSchema.safeParse(target);
    if (!result.success) {
      console.error(
        `[WARN] Zod requestSchema validation failed for ${req.method} ${req.url}:`,
        result.error.message
      );
    }
  }

  return { handled: false, requestSchema, responseSchema };
}

export function validateResponse(
  schema: z.ZodSchema | undefined,
  headers: Record<string, string>,
  body: string,
  status: number
) {
  if (!schema) return;

  let bodyJson: unknown = body;
  try {
    bodyJson = JSON.parse(body);
  } catch (e) {}

  const target = {
    headers,
    body: bodyJson,
    status,
  };

  const result = schema.safeParse(target);
  if (!result.success) {
    console.error(`❌ Response validation failed:`, result.error.message);
  }
}
