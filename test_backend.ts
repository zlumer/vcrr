import express from "express";

const app1 = express();
app1.use(express.json());
app1.all("/*path", (req, res) => {
  console.log(`[Backend 1 (Primary)] ${req.method} ${req.originalUrl}`);
  res.json({
    message: "Hello from Primary",
    method: req.method,
    url: req.originalUrl,
    body: req.body,
  });
});

const app2 = express();
app2.use(express.json());
app2.all("/*path", (req, res) => {
  console.log(`[Backend 2 (Secondary)] ${req.method} ${req.originalUrl}`);
  // Intentionally return different response for diffing
  res.json({
    message: "Hello from Secondary",
    method: req.method,
    url: req.originalUrl,
    body: req.body,
    extra: "Diff me!",
  });
});

const app3 = express();
app3.use(express.json());
app3.all("/*path", (req, res) => {
  console.log(`[Backend 3 (Testing)] ${req.method} ${req.originalUrl}`);
  res.json({
    message: "Hello from Testing",
    method: req.method,
    url: req.originalUrl,
    body: req.body,
  });
});

app1.listen(8081, () => console.log("Primary Backend listening on 8081"));
app2.listen(8082, () => console.log("Secondary Backend listening on 8082"));
app3.listen(8083, () => console.log("Testing Backend listening on 8083"));
