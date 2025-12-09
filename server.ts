import * as path from "path";
import fs from "fs/promises";
import express from "express";
import compression from "compression";
import { createRequestHandler } from "@remix-run/express";

const BUILD_DIR = path.resolve("build");

const app = express();

app.use(compression());
app.use(express.static("public", { maxAge: "1h" }));

app.all(
  "*",
  createRequestHandler({
    build: async () =>
      JSON.parse(
        await fs.readFile(path.join(BUILD_DIR, "server/index.js"), "utf-8"),
      ),
    mode: process.env.NODE_ENV,
  }),
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Remix app running on port ${port}`);
});
