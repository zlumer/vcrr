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

export function getQueryHash(queryObj: Record<string, unknown>): string {
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

export function getFilename(metadata: FileMetadata, ext: string = "hurl"): string {
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
    if (file.startsWith(prefix) && file.endsWith(".hurl")) {
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

export interface HurlInteraction {
  metadata: Record<string, string>;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    query: Record<string, unknown>;
    cookies: Record<string, string>;
    body: string | Buffer;
    bodyFile?: string;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    body: string | Buffer;
    bodyFile?: string;
  };
}


function isBinary(content: string | Buffer | unknown): boolean {
  if (Buffer.isBuffer(content)) {
    // Check if it contains null bytes or other non-text indicators
    for (let i = 0; i < Math.min(content.length, 1024); i++) {
      if (content[i] === 0) return true;
    }
    return false;
  }
  return false;
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([k]) => !["cookie"].includes(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((c) => {
    const parts = c.split("=");
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join("=").trim();
    }
  });
  return cookies;
}

function formatBody(body: string | Buffer, contentType?: string, sidecarPath?: string): string {
  if (!body || (Buffer.isBuffer(body) && body.length === 0)) return "";

  if (sidecarPath) {
    return `file, "${path.basename(sidecarPath)}";`;
  }

  const bodyStr = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  const lang = contentType?.includes("json") ? "json" : "";
  return `\n\`\`\`${lang}\n${bodyStr}\n\`\`\``;
}

export function stringifyHurlRequest(interaction: HurlInteraction, sidecarPath?: string): string {
  const { metadata, request } = interaction;
  let lines: string[] = [];

  // Metadata
  Object.entries(metadata).forEach(([k, v]) => {
    lines.push(`# ${k}: ${v}`);
  });

  // Request Line
  lines.push(`${request.method} ${request.url}`);

  // Headers
  const headersStr = formatHeaders(request.headers);
  if (headersStr) lines.push(headersStr);

  // Query
  if (Object.keys(request.query).length > 0) {
    lines.push("\n[Query]");
    Object.entries(request.query).forEach(([k, v]) => {
      lines.push(`${k}: "${v}"`);
    });
  }

  // Cookies
  if (Object.keys(request.cookies).length > 0) {
    lines.push("\n[Cookies]");
    Object.entries(request.cookies).forEach(([k, v]) => {
      lines.push(`${k}: "${v}"`);
    });
  }

  // Body
  const contentType = request.headers["content-type"] || request.headers["Content-Type"];
  const bodyStr = formatBody(request.body, contentType, sidecarPath);
  if (bodyStr) lines.push(bodyStr);

  return lines.join("\n") + "\n";
}

export function stringifyHurlResponse(response: NonNullable<HurlInteraction["response"]>, sidecarPath?: string): string {
  let lines: string[] = [""]; // Start with newline

  lines.push(`HTTP ${response.status}`);
  
  const headersStr = formatHeaders(response.headers);
  if (headersStr) lines.push(headersStr);

  const contentType = response.headers["content-type"] || response.headers["Content-Type"];
  const bodyStr = formatBody(response.body, contentType, sidecarPath);
  if (bodyStr) lines.push(bodyStr);

  return lines.join("\n") + "\n";
}

export function parseHurl(content: string, filePath?: string): HurlInteraction {
  const lines = content.split(/\r?\n/);
  const interaction: HurlInteraction = {
    metadata: {},
    request: {
      method: "",
      url: "",
      headers: {},
      query: {},
      cookies: {},
      body: "",
    },
  };

  let section: "metadata" | "request" | "response" | "query" | "cookies" | "body" = "metadata";
  let bodyLines: string[] = [];
  let isInsideMultiline = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Multiline body handling
    if (trimmed.startsWith("```")) {
      if (isInsideMultiline) {
        isInsideMultiline = false;
        if (section === "response" && interaction.response) {
          interaction.response.body = bodyLines.join("\n");
        } else {
          interaction.request.body = bodyLines.join("\n");
        }
        bodyLines = [];
      } else {
        isInsideMultiline = true;
      }
      continue;
    }

    if (isInsideMultiline) {
      bodyLines.push(line);
      continue;
    }

    // Metadata
    if (trimmed.startsWith("#") && section === "metadata") {
      const match = trimmed.match(/^#\s*([^:]+):\s*(.*)$/);
      if (match) {
        interaction.metadata[match[1].trim()] = match[2].trim();
      }
      continue;
    }

    // Request Line
    if (trimmed && section === "metadata" && !trimmed.startsWith("#")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        interaction.request.method = parts[0];
        interaction.request.url = parts[1];
        section = "request";
      }
      continue;
    }

    // Sections
    if (trimmed === "[Query]") {
      section = "query";
      continue;
    }
    if (trimmed === "[Cookies]") {
      section = "cookies";
      continue;
    }

    // Response Line
    if (trimmed.startsWith("HTTP ")) {
      section = "response";
      const parts = trimmed.split(/\s+/);
      interaction.response = {
        status: parseInt(parts[1], 10),
        headers: {},
        body: "",
      };
      continue;
    }

    // Headers / Query / Cookies
    if (trimmed && trimmed.includes(":") && !trimmed.startsWith("#")) {
      const colonIdx = line.indexOf(":");
      const key = line.substring(0, colonIdx).trim();
      let value = line.substring(colonIdx + 1).trim();
      
      // Remove quotes if present
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.substring(1, value.length - 1);
      }

      if (section === "request") {
        interaction.request.headers[key.toLowerCase()] = value;
      } else if (section === "query") {
        interaction.request.query[key] = value;
      } else if (section === "cookies") {
        interaction.request.cookies[key] = value;
      } else if (section === "response" && interaction.response) {
        interaction.response.headers[key.toLowerCase()] = value;
      }
      continue;
    }

    // File reference handling
    if (trimmed.startsWith("file,")) {
      const match = trimmed.match(/file,\s*"([^"]+)"/);
      if (match && filePath) {
        const sidecarFile = path.join(path.dirname(filePath), match[1]);
        if (fs.existsSync(sidecarFile)) {
          const buffer = fs.readFileSync(sidecarFile);
          if (section === "response" && interaction.response) {
            interaction.response.body = buffer;
            interaction.response.bodyFile = match[1];
          } else {
            interaction.request.body = buffer;
            interaction.request.bodyFile = match[1];
          }
        }
      }
      continue;
    }
  }

  return interaction;
}

export function saveHurlRequest(
  filePath: string,
  interaction: HurlInteraction
) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let sidecarPath: string | undefined;
  if (isBinary(interaction.request.body)) {
    sidecarPath = filePath + ".req.bin";
    fs.writeFileSync(sidecarPath, interaction.request.body as Buffer);
  }

  const content = stringifyHurlRequest(interaction, sidecarPath);
  fs.writeFileSync(filePath, content, "utf8");
}

export function appendHurlResponse(
  filePath: string,
  response: NonNullable<HurlInteraction["response"]>
) {
  let sidecarPath: string | undefined;
  if (isBinary(response.body)) {
    sidecarPath = filePath + ".res.bin";
    fs.writeFileSync(sidecarPath, response.body as Buffer);
  }

  const content = stringifyHurlResponse(response, sidecarPath);
  fs.appendFileSync(filePath, content, "utf8");
}

export function generateDiff(obj1: unknown, obj2: unknown, color: boolean = false): string {
  // Use json-diff to generate semantic difference
  let diffStr = diffString(obj1, obj2, { color });
  return diffStr || "";
}
