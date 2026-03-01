import fs from "fs";
import path from "path";
import { getBackendName, parseFile, generateDiff } from "./utils";
import { validateResponse, processHandlers } from "./handlers";

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

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function runTestRunner(options: {
  recordingId: string;
  primaryBackend: string;
  testingBackend: string;
}) {
  const baseDir = path.join(process.cwd(), "recordings");
  const primaryBackendName = getBackendName(options.primaryBackend);
  const primaryDir = path.join(
    baseDir,
    options.recordingId,
    primaryBackendName
  );

  if (!fs.existsSync(primaryDir)) {
    console.error(`Recording directory not found: ${primaryDir}`);
    process.exit(1);
  }

  const allFiles = getAllFiles(primaryDir);
  const reqFiles = allFiles.filter((f) => f.endsWith(".req"));

  const requestsToRun = reqFiles
    .map((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = parseFile(content);
      return {
        filePath,
        timeSinceStartMs: parsed.frontmatter.timeSinceStartMs || 0,
        fullUrl: parsed.frontmatter.fullUrl || "",
        method: parsed.frontmatter.method || "GET",
        headers: parsed.headers,
        body: parsed.body,
        filename: path.basename(filePath),
      };
    })
    .sort((a, b) => a.timeSinceStartMs - b.timeSinceStartMs);

  console.log(
    `Found ${requestsToRun.length} requests. Starting test runner...`
  );

  let passed = 0;
  let failed = 0;
  let lastRequestTime = 0;

  for (const reqData of requestsToRun) {
    const delay = reqData.timeSinceStartMs - lastRequestTime;
    if (delay > 0) {
      await sleep(delay);
    }
    lastRequestTime = reqData.timeSinceStartMs;

    // We can extract URL from fullUrl
    if (!reqData.fullUrl) {
      console.log(
        `❌ FAIL [NO-URL] ${reqData.filename} - Skipping because no fullUrl saved in frontmatter`
      );
      failed++;
      continue;
    }

    const testUrl = new URL(reqData.fullUrl, options.testingBackend);

    try {
      const res = await fetch(testUrl.toString(), {
        method: reqData.method,
        headers: reqData.headers,
        body: ["GET", "HEAD"].includes(reqData.method)
          ? undefined
          : reqData.body && reqData.body.length
            ? reqData.body
            : undefined,
      });

      const arrayBuffer = await res.arrayBuffer();
      const resBodyStr = Buffer.from(arrayBuffer).toString("utf8");

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });

      // Load primary backend response
      const resFilePath = reqData.filePath.replace(".req", ".res");
      let primaryResBodyStr = "";
      let primaryStatus = 200;
      if (fs.existsSync(resFilePath)) {
        const primaryResContent = fs.readFileSync(resFilePath, "utf8");
        const primaryParsed = parseFile(primaryResContent);
        primaryResBodyStr = primaryParsed.body;
        primaryStatus = primaryParsed.frontmatter.status || 200;
      }

      // Semantic JSON Diff
      let primaryBodyJson: any = primaryResBodyStr;
      let secBodyJson: any = resBodyStr;
      try {
        primaryBodyJson = JSON.parse(primaryResBodyStr);
      } catch (e) {}
      try {
        secBodyJson = JSON.parse(resBodyStr);
      } catch (e) {}

      const diffOutput = generateDiff(primaryBodyJson, secBodyJson);

      let hasError = false;
      let errMsg = "";

      if (res.status !== primaryStatus) {
        hasError = true;
        errMsg += `Status code mismatch: expected ${primaryStatus}, got ${res.status}. `;
      }

      if (diffOutput && diffOutput.trim() !== "") {
        hasError = true;
        errMsg += `Response body diff found. `;
      }

      // Check Zod schema using the mock req/res mock Express objects? Or directly loading handlers?
      // For simplicity, we just check handlers if available.
      // But we need the exact dir path for this recording to resolve the handler.
      const dirPath = path.dirname(reqData.filePath);
      const leaf = reqData.filename.replace(".req", ""); // e.g. "users.get.abc.1"
      const handlerPathMatch = path.join(dirPath, `${leaf}.ts`);
      let responseSchema: any;

      if (fs.existsSync(handlerPathMatch)) {
        try {
          const mod = require(handlerPathMatch);
          if (mod.responseSchema) responseSchema = mod.responseSchema;
        } catch (e) {}
      }

      if (responseSchema) {
        const target = {
          headers: resHeaders,
          body: secBodyJson,
          status: res.status,
        };
        const result = responseSchema.safeParse(target);
        if (!result.success) {
          hasError = true;
          errMsg += `Zod responseSchema failed: ${result.error.message}. `;
        }
      }

      if (hasError) {
        console.log(`❌ FAIL ${reqData.method} ${reqData.fullUrl} - ${errMsg}`);
        failed++;

        // Save diff file in testing dir
        const testingBaseDir = path.join(
          process.cwd(),
          "testing",
          options.recordingId,
          getBackendName(options.testingBackend)
        );
        const relPath = path.relative(primaryDir, reqData.filePath);
        const targetDiffPath = path.join(
          testingBaseDir,
          relPath.replace(".req", ".diff")
        );

        fs.mkdirSync(path.dirname(targetDiffPath), { recursive: true });
        fs.writeFileSync(targetDiffPath, diffOutput || errMsg, "utf8");
      } else {
        console.log(`✅ PASS ${reqData.method} ${reqData.fullUrl}`);
        passed++;
      }
    } catch (err: any) {
      console.log(
        `❌ FAIL ${reqData.method} ${reqData.fullUrl} - Fetch error: ${err.message}`
      );
      failed++;
    }
  }

  console.log(`\nTest Runner Finished. ${passed} passed, ${failed} failed.`);
}
