import fs from "fs";
import path from "path";
import { getBackendName, parseHurl, generateDiff } from "./utils.js";
import { validateResponse } from "./handlers.js";

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
  const hurlFiles = allFiles.filter((f) => f.endsWith(".hurl"));

  const requestsToRun = hurlFiles
    .map((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const interaction = parseHurl(content, filePath);
      return {
        filePath,
        interaction,
        timeSinceStartMs: parseInt(interaction.metadata.timeSinceStartMs, 10) || 0,
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

    const { interaction } = reqData;
    
    // Reconstruct URL
    let testUrl: URL;
    try {
        // Use the path from request.url which was saved without query
        const tempUrl = new URL(interaction.request.url); 
        testUrl = new URL(tempUrl.pathname, options.testingBackend);
        
        // Add query params from [Query] section
        Object.entries(interaction.request.query).forEach(([k, v]) => {
            testUrl.searchParams.append(k, String(v));
        });
    } catch (e) {
        console.log(`❌ FAIL [INVALID-URL] ${reqData.filename} - ${e}`);
        failed++;
        continue;
    }

    const headers = { ...interaction.request.headers };
    // Add cookies from [Cookies] section
    if (Object.keys(interaction.request.cookies).length > 0) {
        headers["cookie"] = Object.entries(interaction.request.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
    }

    try {
      const res = await fetch(testUrl.toString(), {
        method: interaction.request.method,
        headers: headers as Record<string, string>,
        body: ["GET", "HEAD"].includes(interaction.request.method)
          ? undefined
          : interaction.request.body && interaction.request.body.length
            ? interaction.request.body
            : undefined,
      });

      const arrayBuffer = await res.arrayBuffer();
      const resBodyStr = Buffer.from(arrayBuffer).toString("utf8");

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });

      // Load primary backend response from the same interaction
      const primaryResponse = interaction.response;
      let primaryResBodyStr = "";
      let primaryStatus = 200;
      if (primaryResponse) {
        primaryResBodyStr = Buffer.isBuffer(primaryResponse.body) 
            ? primaryResponse.body.toString("utf8") 
            : primaryResponse.body;
        primaryStatus = primaryResponse.status;
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

      // Check Zod schema
      const dirPath = path.dirname(reqData.filePath);
      const leaf = reqData.filename.replace(".hurl", ""); 
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
        console.log(`❌ FAIL ${interaction.request.method} ${testUrl.pathname}${testUrl.search} - ${errMsg}`);
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
          relPath.replace(".hurl", ".diff")
        );

        fs.mkdirSync(path.dirname(targetDiffPath), { recursive: true });
        fs.writeFileSync(targetDiffPath, diffOutput || errMsg, "utf8");
      } else {
        console.log(`✅ PASS ${interaction.request.method} ${testUrl.pathname}${testUrl.search}`);
        passed++;
      }
    } catch (err: any) {
      console.log(
        `❌ FAIL ${interaction.request.method} ${testUrl.pathname}${testUrl.search} - Fetch error: ${err.message}`
      );
      failed++;
    }
  }

  console.log(`\nTest Runner Finished. ${passed} passed, ${failed} failed.`);
}
