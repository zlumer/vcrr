import fs from "fs";
import path from "path";
import prompts from "prompts";
import { spawnSync } from "child_process";
import { getBackendName, parseHurl, generateDiff } from "./utils.js";

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  const files = fs.readdirSync(dirPath);
  files.forEach(function (file) {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
    } else {
      arrayOfFiles.push(path.join(dirPath, "/", file));
    }
  });
  return arrayOfFiles;
}

export async function runDiffTool(options: {
  recordingId: string;
  testingBackend: string;
  primaryBackend: string;
}) {
  const testingBackendName = getBackendName(options.testingBackend);
  const primaryBackendName = getBackendName(options.primaryBackend);
  
  const testingDir = path.join(process.cwd(), "testing", options.recordingId, testingBackendName);
  const recordingDir = path.join(process.cwd(), "recordings", options.recordingId, primaryBackendName);

  if (!fs.existsSync(testingDir)) {
    console.log("No test results found for this recording and backend.");
    return;
  }

  while (true) {
    const allFiles = getAllFiles(testingDir);
    const failingHurlFiles = allFiles.filter(f => f.endsWith(".actual.hurl"));

    if (failingHurlFiles.length === 0) {
      console.log("No failing tests found.");
      break;
    }

    const choices = failingHurlFiles.map(filePath => {
      const relPath = path.relative(testingDir, filePath).replace(".actual.hurl", ".hurl");
      return {
        title: relPath,
        value: filePath
      };
    });

    choices.push({ title: "Exit", value: "exit" });

    const response = await prompts({
      type: 'select',
      name: 'file',
      message: 'Select a failing test to view diff',
      choices: choices,
    });

    if (!response.file || response.file === 'exit') {
      break;
    }

    const actualPath = response.file;
    const relPath = path.relative(testingDir, actualPath).replace(".actual.hurl", ".hurl");
    const originalPath = path.join(recordingDir, relPath);

    if (!fs.existsSync(originalPath)) {
        console.error(`Could not find original recording at ${originalPath}`);
        continue;
    }

    const originalInteraction = parseHurl(fs.readFileSync(originalPath, "utf8"), originalPath);
    const actualInteraction = parseHurl(fs.readFileSync(actualPath, "utf8"), actualPath);

    const originalBody = originalInteraction.response?.body;
    const actualBody = actualInteraction.response?.body;

    let originalJson: unknown = originalBody;
    let actualJson: unknown = actualBody;

    try {
        if (typeof originalBody === "string") originalJson = JSON.parse(originalBody);
    } catch(e) {}
    try {
        if (typeof actualBody === "string") actualJson = JSON.parse(actualBody);
    } catch(e) {}

    const coloredDiff = generateDiff(originalJson, actualJson, true);

    if (!coloredDiff) {
        console.log("No diff found in bodies. It might be a status code mismatch.");
        const originalStatus = originalInteraction.response?.status;
        const actualStatus = actualInteraction.response?.status;
        console.log(`Status: Expected ${originalStatus}, Got ${actualStatus}`);
        await prompts({ type: 'text', name: 'continue', message: 'Press enter to return to list' });
    } else {
        // Use less -R to display the colored diff
        spawnSync("less", ["-R"], {
            input: coloredDiff,
            stdio: ["pipe", "inherit", "inherit"]
        });
    }
  }
}
