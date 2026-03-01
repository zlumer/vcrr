import fs from "fs";
import path from "path";
import prompts from "prompts";
import readline from "readline";
import { spawn } from "child_process";

import { getAllFiles } from "./utils.js";

/**
 * Mask sensitive values in the diff line
 */
function maskSensitiveLine(line: string): string {
  const sensitiveKeys = ["token", "password", "secret", "auth", "authorization", "key", "cookie", "set-cookie"];
  return line.replace(/"([^"]*)"\s*:\s*"([^"]*)"/gi, (match, key, value) => {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      return `"${key}": "[MASKED]"`;
    }
    return match;
  });
}

/**
 * Colorizes a single line of diff content
 */
function colorizeLine(line: string): string {
  const maskedLine = maskSensitiveLine(line);
  if (maskedLine.startsWith("+++") || maskedLine.startsWith("---")) return `\x1b[1;33m${maskedLine}\x1b[0m`; // Bold Yellow
  if (maskedLine.startsWith("+")) return `\x1b[32m${maskedLine}\x1b[0m`; // Green
  if (maskedLine.startsWith("-")) return `\x1b[31m${maskedLine}\x1b[0m`; // Red
  if (maskedLine.startsWith("@@")) return `\x1b[36m${maskedLine}\x1b[0m`; // Cyan
  if (maskedLine.startsWith("diff") || maskedLine.startsWith("index")) return `\x1b[1m${maskedLine}\x1b[0m`; // Bold
  return maskedLine;
}

async function viewDiff(diffPath: string) {
  // For very large files, streaming is much better for memory.
  // We use spawn and pipe to less -R.
  const less = spawn("less", ["-R"], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, LESSSECURE: "1" },
  });

  const rl = readline.createInterface({
    input: fs.createReadStream(diffPath),
    terminal: false,
  });

  for await (const line of rl) {
    const coloredLine = colorizeLine(line) + "\n";
    if (!less.stdin.write(coloredLine)) {
      await new Promise((resolve) => less.stdin.once("drain", resolve));
    }
  }

  less.stdin.end();

  return new Promise<void>((resolve) => {
    less.on("exit", () => resolve());
  });
}

interface TreeNode {
  name: string;
  path?: string;
  children: Map<string, TreeNode>;
}

function buildTree(files: string[], baseDir: string): TreeNode {
  const root: TreeNode = { name: "root", children: new Map() };
  for (const file of files) {
    const relPath = path.relative(baseDir, file);
    const segments = relPath.split(path.sep);
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!current.children.has(segment)) {
        current.children.set(segment, { name: segment, children: new Map() });
      }
      current = current.children.get(segment)!;
      if (i === segments.length - 1) {
        current.path = file;
      }
    }
  }
  return root;
}

function renderTree(
  node: TreeNode,
  prefix: string = "",
  isLast: boolean = true,
  depth: number = 0
): any[] {
  let choices: any[] = [];

  if (depth > 0) {
    const connector = isLast ? "└── " : "├── ";
    const label = node.path
      ? node.name
      : `\x1b[1;34m${node.name}\x1b[0m`; // Bold Blue for directories

    choices.push({
      title: `${prefix}${connector}${label}`,
      value: node.path || `dir-${node.name}`,
      disabled: !node.path,
    });
  }

  const newPrefix = depth === 0 ? "" : prefix + (isLast ? "    " : "│   ");
  const childrenKeys = Array.from(node.children.keys()).sort((a, b) => {
    const aNode = node.children.get(a)!;
    const bNode = node.children.get(b)!;
    // Directories first
    if (!!aNode.path !== !!bNode.path) {
      return aNode.path ? 1 : -1;
    }
    return a.localeCompare(b);
  });

  childrenKeys.forEach((key, index) => {
    const isLastChild = index === childrenKeys.length - 1;
    choices.push(...renderTree(node.children.get(key)!, newPrefix, isLastChild, depth + 1));
  });

  return choices;
}

export async function runDiffTool(options: { recordingId: string }) {
  const recordingBaseDir = path.join(process.cwd(), "recordings", options.recordingId);

  if (!fs.existsSync(recordingBaseDir)) {
    console.log(`No recordings found for ID: ${options.recordingId}`);
    return;
  }

  const diffFiles = getAllFiles(recordingBaseDir, (f) => f.endsWith(".diff"));

  if (diffFiles.length === 0) {
    console.log("No diff files found in this recording.");
    return;
  }

  while (true) {
    console.clear();
    const tree = buildTree(diffFiles, recordingBaseDir);
    const choices = renderTree(tree);

    choices.push({ title: "──────────────", value: "sep", disabled: true });
    choices.push({ title: "Exit", value: "exit" });

    const response = await prompts({
      type: "select",
      name: "file",
      message: "Select a diff to view",
      choices: choices,
      // @ts-ignore - 'optionsPerPage' is the correct property for 'select' type, but missing in @types/prompts
      optionsPerPage: process.stdout.rows ? Math.max(10, process.stdout.rows - 5) : 20,
      warn: " ",
    });

    if (!response.file || response.file === "exit" || response.file === "sep") {
      break;
    }

    await viewDiff(response.file);
  }
}
