import crypto from "crypto";
import fs from "fs";
import path from "path";
import { diffString } from "json-diff";

export function getBackendName(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol.replace(":", "")}-${parsed.hostname}${parsed.port ? "-" + parsed.port : ""}`;
  } catch (err) {
    return "unknown-backend";
  }
}

export function getQueryHash(queryObj: Record<string, any>): string {
  if (!queryObj || Object.keys(queryObj).length === 0) {
    return "";
  }
  // Sort keys to ensure stable hashing
  const sortedKeys = Object.keys(queryObj).sort();
  const sortedQuery = sortedKeys.map((k) => `${k}=${queryObj[k]}`).join("&");
  return crypto
    .createHash("md5")
    .update(sortedQuery)
    .digest("hex")
    .substring(0, 8);
}

export interface FileMetadata {
  recordingId: string;
  backendName: string;
  method: string;
  urlPath: string;
  query: Record<string, any>;
  sequenceIndex: number;
}

export function getDirectoryPath(
  baseDir: string,
  metadata: FileMetadata
): string {
  const { recordingId, backendName, urlPath } = metadata;
  // Remove leading and trailing slashes
  const cleanPath = urlPath.replace(/^\/|\/$/g, "");
  const pathSegments = cleanPath ? cleanPath.split("/") : ["index"];

  // The directory uses all segments except the last one (leaf)
  const dirSegments = pathSegments.length > 1 ? pathSegments.slice(0, -1) : [];
  return path.join(baseDir, recordingId, backendName, ...dirSegments);
}

export function getFilename(metadata: FileMetadata, ext: string): string {
  const cleanPath = metadata.urlPath.replace(/^\/|\/$/g, "");
  const pathSegments = cleanPath ? cleanPath.split("/") : ["index"];
  const leaf = pathSegments[pathSegments.length - 1];

  const queryHash = getQueryHash(metadata.query);
  const hashPart = queryHash ? `.${queryHash}` : "";
  const seqPart = metadata.sequenceIndex ? `.${metadata.sequenceIndex}` : "";

  return `${leaf}.${metadata.method.toLowerCase()}${hashPart}${seqPart}.${ext}`;
}

export function getNextSequenceIndex(
  baseDir: string,
  metadata: Omit<FileMetadata, "sequenceIndex">
): number {
  const dirPath = getDirectoryPath(baseDir, { ...metadata, sequenceIndex: 1 });
  if (!fs.existsSync(dirPath)) {
    return 1;
  }

  const files = fs.readdirSync(dirPath);
  const cleanPath = metadata.urlPath.replace(/^\/|\/$/g, "");
  const pathSegments = cleanPath ? cleanPath.split("/") : ["index"];
  const leaf = pathSegments[pathSegments.length - 1];
  const queryHash = getQueryHash(metadata.query);
  const hashPart = queryHash ? `.${queryHash}` : "";

  const prefix = `${leaf}.${metadata.method.toLowerCase()}${hashPart}.`;

  let maxIndex = 0;
  for (const file of files) {
    if (file.startsWith(prefix) && file.endsWith(".req")) {
      const parts = file.replace(prefix, "").split(".");
      if (parts.length > 0) {
        const index = parseInt(parts[0], 10);
        if (!isNaN(index) && index > maxIndex) {
          maxIndex = index;
        }
      }
    }
  }
  return maxIndex + 1;
}

export interface ParsedFile {
  frontmatter: Record<string, any>;
  headers: Record<string, string>;
  body: string;
}

export function parseFile(content: string): ParsedFile {
  const delimiterIndex = content.indexOf("\n---\n");
  if (delimiterIndex === -1) {
    throw new Error("Invalid file format: missing --- delimiter");
  }

  const frontmatterStr = content.substring(0, delimiterIndex).trim();
  const rest = content.substring(delimiterIndex + 5);

  let frontmatter = {};
  try {
    frontmatter = JSON.parse(frontmatterStr);
  } catch (e) {
    console.error("Failed to parse frontmatter JSON");
  }

  // Extract headers and body
  // HTTP format: headers followed by empty line, then body
  const parts = rest.split("\n\n");
  let headers: Record<string, string> = {};
  let body = "";

  if (parts.length > 1) {
    const headersStr = parts[0];
    body = parts.slice(1).join("\n\n");

    headersStr.split("\n").forEach((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        const key = line.substring(0, colonIdx).trim().toLowerCase();
        const value = line.substring(colonIdx + 1).trim();
        headers[key] = value;
      }
    });
  } else {
    // No empty line found, could be all body or all headers
    // Assuming it's body if it doesn't look like headers
    body = rest;
  }

  return { frontmatter, headers, body };
}

export function stringifyFile(
  frontmatter: Record<string, any>,
  headers: Record<string, string>,
  body: string
): string {
  const frontmatterStr = JSON.stringify(frontmatter, null, 2);
  const headersStr = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return `${frontmatterStr}\n---\n${headersStr}\n\n${body}`;
}

export function saveFile(
  filePath: string,
  frontmatter: Record<string, any>,
  headers: Record<string, string>,
  body: string
) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = stringifyFile(frontmatter, headers, body);
  fs.writeFileSync(filePath, content, "utf8");
}

export function generateDiff(obj1: any, obj2: any): string {
  // Use json-diff to generate semantic difference
  let diffStr = diffString(obj1, obj2);
  return diffStr || "";
}
