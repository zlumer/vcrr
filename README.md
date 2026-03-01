# VCRR

Multi-Backend HTTP Proxy & Replay Testing Tool

V - verify
C - continue
R - record
R - replay

## 1. Overview

The tool is a Node.js/TypeScript-based HTTP proxy built with Express.js. It acts as an intermediary that multiplexes incoming HTTP requests to multiple backends simultaneously, tracking performance (response time) and storing requests/responses in local files. It serves as a recording proxy, a replay mock server, and a test runner for API regression testing.

## 2. Core Concepts

- **Primary Backend:** The main backend whose response is actually returned to the client during recording.
- **Secondary Backends:** Additional backends that receive the same requests simultaneously for shadowing/diffing purposes.
- **Modes of Operation:** `record`, `replay`, `continue`, `verify` (test runner).
- **Storage Format:** Files are saved using JSON frontmatter followed by a `---` delimiter, and then the raw HTTP body. Headers are included in the frontmatter or raw body.

## 3. Configuration

Configuration is provided via a `.env` file and environment variables, plus CLI arguments.

**Environment Variables (`.env`):**

- `PORT`: The port the proxy listens on (e.g., 9090).
- `PRIMARY_BACKEND`: The URL of the primary backend (e.g., `http://localhost:8081`).
- `BACKEND_{N}`: URLs for secondary backends (e.g., `BACKEND_1=http://localhost:8082`, `BACKEND_2=https://staging.api.com`).
- `TESTING_BACKEND`: The URL used specifically for the `verify` (test runner) mode.

**CLI Execution:**

```bash
ts-node proxy.ts --mode <record|replay|continue|verify> --id <recording_id>
```

## 4. File System Structure & Naming

Recordings are grouped by recording ID and the backend's calculated name (derived from its URL, e.g., `http-localhost-8080`).

**Directory Structure:**

```
recordings/
  <recording_id>/
    <backend_name>/
      <path_segments>/
        <filename>
```

**File Naming Convention:**
For a request to `/api/users?id=123`:

1. **Path mapping:** The URL path `/api/users` determines the directory `api/`.
2. **Filename format:** `<path_leaf>.<method>.<query_hash>.<sequence_index>.<ext>`
   - `<path_leaf>`: `users`
   - `<method>`: `get`, `post`, etc. (lowercase)
   - `<query_hash>`: Hash of the query string `?id=123` (e.g., `abc`). If no query, a default empty hash or omitted. Request bodies are NOT hashed for matching; matching relies entirely on Method+Path+Query and the sequence index.
   - `<sequence_index>`: Incremental integer (`1`, `2`, `3`) for sequential identical requests.
   - `<ext>`: `req`, `res`, `diff`, `ts`.

**Examples:**

- `users.get.abc.1.req`: The 1st captured incoming request.
- `users.get.abc.1.res`: The 1st captured backend response.
- `users.get.abc.1.diff`: Semantic JSON differences between this secondary backend's response and the primary backend's response.

**File Format (`.req` and `.res`):**
Text file with JSON frontmatter, separated by `---`, followed by the HTTP headers and body (similar to `hurl`).

Example `.res`:

```json
{
  "status": 200,
  "timeSinceStartMs": 1500,
  "timeTakenMs": 45
}
---
Content-Type: application/json
X-Custom-Header: value

{"id": 123, "name": "John Doe"}
```

## 5. Operating Modes

### 5.1 `record` Mode

- Listens for incoming HTTP requests.
- Proxies the request to `PRIMARY_BACKEND` and all `BACKEND_{N}` simultaneously.
- Immediately returns the response from `PRIMARY_BACKEND` to the client.
- Waits for secondary backends in the background (handling timeouts/failures gracefully).
- Saves `.req` and `.res` files for all backends in their respective directories.
- Assigns a `<sequence_index>` to handle multiple identical requests. Never overwrites existing files.
- Generates Semantic JSON `.diff` files for secondary backends by comparing their responses against the primary backend's response.

### 5.2 `replay` Mode

- Acts as a pure offline mock server. Makes NO outgoing requests to any backends.
- Matches incoming requests based on Method + URL Path + Query Hash + Sequence Index.
- Serves the corresponding `.res` file from the `PRIMARY_BACKEND` recording directory.
- **Exhaustion Behavior:** If a request exceeds the recorded sequence (e.g., 4th request but only 3 recorded), it returns a `502 Bad Gateway` error **UNLESS** a manual fallback file exists (e.g., `users.get.abc.res` without the index).

### 5.3 `continue` Mode

- A hybrid of `replay` and `record`.
- If a `.res` file exists for the current Sequence Index, it behaves like `replay` (serves mock, skips backends).
- If no file exists for the Sequence Index (a new request in the sequence), it behaves like `record` (proxies to all backends, records `.req`, `.res`, `.diff`).

### 5.4 `verify` Mode (Auto-Replay / Test Runner)

- Ignores incoming HTTP requests.
- Acts as a test runner. Reads the sequence of `.req` files from the `PRIMARY_BACKEND` folder, sorted by `timeSinceStartMs`.
- Fires these requests at the `TESTING_BACKEND`.
- Awaits sequentially between requests (wait for response, sleep, then fire the next one) based on `timeSinceStartMs`.
- Compares the `TESTING_BACKEND` responses against the recorded `PRIMARY_BACKEND` responses.
- Validation includes executing Zod schemas if defined in corresponding `.ts` handler files.
- Generates a stdout report (Deno test-style output: `✅ PASS`, `❌ FAIL`).
- Saves diffs for failures into a new directory: `testing/<recording_id>/<backend_name>/...`.

## 6. TypeScript Handlers & Schema Validation (express-file-routing style)

Users can provide custom behavior by placing `.ts` files inside the `recordings/<recording_id>/...` directory alongside the recordings.

**Resolution Order (Most specific to least specific):**
For `/api/users?id=123` (hash `abc`, sequence `1`):

1. `users.get.abc.1.ts` (Applies to this exact request in the sequence)
2. `users.get.abc.ts` (Applies to all requests with this specific query)
3. `users.get.ts` (Applies to all GET requests to `/api/users`)
4. `users.ts` (Applies to all methods on `/api/users`)

**Capabilities:**

- **Express Handlers:** Export standard Express middleware/handlers to override default matching/response logic (e.g., `export const get = (req, res) => ...`).
- **Schema Validation:** Export Zod schemas (e.g., `export const requestSchema = z.object(...)`, `export const responseSchema = z.object(...)`).
  - Target structure for Zod validation is the full object: `{ headers, body, query }`.
  - If schema validation fails during `record` or `continue` modes: Log a warning to `stderr` and mark the test as failed in the final report, but **allow** the request/response to pass through.

## 7. Diffing

- Semantic JSON diffs are generated in `record` and `continue` modes for secondary backends (compared against primary).
- Semantic JSON diffs are generated in `verify` mode for `TESTING_BACKEND` (compared against recorded primary).
- Saved as plain text `.diff` files next to the `.res` files.
