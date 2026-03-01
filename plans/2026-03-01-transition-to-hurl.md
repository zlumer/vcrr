# PLAN: Transition the proxy to use fully idiomatic, executable `.hurl` files. 

### 1. File Structure & Extension (`proxy/utils.ts`)
*   **Single Extension**: Update `getFilename` to generate a single `.hurl` file per interaction (e.g., `users.get.abc.1.hurl`) instead of separate `.req` and `.res` files.

### 2. Idiomatic Hurl Serialization (`stringifyHurl` in `proxy/utils.ts`)
We will replace `stringifyFile` with a new `stringifyHurl` function that formats the request and response into strictly valid Hurl syntax:
*   **Metadata**: Internal proxy state (like `timeSinceStartMs`, `timeTakenMs`, and `sequenceIndex`) will be prefixed as `# key: value` comments so they are ignored by the `hurl` CLI but parsable by our tool.
*   **Request Line**: Output the absolute URL *without* query parameters (e.g., `POST http://localhost:9099/api/users`).
*   **Request Headers**: Print all headers natively. We will intentionally omit the `Cookie` header from this list to prevent duplication.
*   **`[Query]` Section**: Iterate over `req.query` and output each parameter as a native Hurl key-value pair, with values wrapped in double quotes.
*   **`[Cookies]` Section**: If a `Cookie` header exists, parse it into individual cookies and output them as native Hurl key-value pairs, with values wrapped in double quotes.
*   **Request Body**: Output the body wrapped in Hurl's multiline string syntax (e.g. ` ```json ` or ` ``` `) to prevent parser ambiguity.
*   **Response Line**: Output `HTTP {status}`.
*   **Response Headers & Body**: Print response headers natively, followed by an empty line, and then the response body wrapped in Hurl's multiline string syntax.

**Example Output:**
<hurl>
# timeSinceStartMs: 1500
# sequenceIndex: 1
POST http://localhost:9099/api/users
Host: localhost:9099
Accept: application/json
Content-Type: application/json

[Query]
id: 123

[Cookies]
session: abc123_token

```json
{
  "name": "Alice"
}
```

HTTP 200
# timeTakenMs: 45
Content-Type: application/json
Content-Length: 42

```json
{
  "id": 123,
  "name": "John Doe"
}
```
</hurl>

### 3. Custom Hurl Parser (`parseHurl` in `proxy/utils.ts`)
We will replace `parseFile` with an internal `parseHurl` function that understands our generated subset of Hurl syntax. It will read the file line-by-line to extract:
*   **Frontmatter/Metadata**: Extract any `# key: value` comments into a metadata object.
*   **Request Info**: Parse the method and URL.
*   **Request Sections**: Extract request headers, `[Query]` parameters, and `[Cookies]`.
*   **Request Body**: Collect all lines between the request sections and the `HTTP <status>` line.
*   **Response Info**: Parse the `HTTP <status>` line.
*   **Response Sections**: Extract response headers and the raw response body.

### 4. Middleware Updates (`proxy/middleware.ts`)
*   **Two-step File Writing**: Currently, `.req` files are saved immediately upon request arrival. Since we're writing a single `.hurl` file, we will append to it after the response. That means we need to store the reference to the file in memory while the request is in flight.
*   **Replay/Continue Mode**: Update the replay logic to look for the `.hurl` file instead of `.res`. It will use `parseHurl` to read the file and serve the parsed response status, headers, and body.
*   **Error Handling**: If the primary backend fails (e.g., connection refused), we will still record the interaction by saving a `.hurl` file with a mocked `HTTP 502` response containing the error details in the body.

### 5. Test Runner Updates (`proxy/runner.ts`)
*   **File Discovery**: Look for `.hurl` files instead of `.req` files.
*   **Request Execution**: Use `parseHurl` to load the request payload (method, base URL, headers, and body). The runner will manually reconstruct the query string from the `[Query]` section and append the `Cookie` header from the `[Cookies]` section before firing the request at the testing backend.
*   **Diffing**: Compare the testing backend's response against the recorded primary response payload extracted from the same `.hurl` file.

## Hurl Documentation

- https://hurl.dev/docs/hurl-file.html
- https://hurl.dev/docs/entry.html
- https://hurl.dev/docs/request.html
- https://hurl.dev/docs/response.html
- https://hurl.dev/docs/capturing-response.html
- https://hurl.dev/docs/asserting-response.html
- https://hurl.dev/docs/filters.html
- https://hurl.dev/docs/templates.html
- https://hurl.dev/docs/grammar.html
