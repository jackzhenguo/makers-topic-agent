import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onRequest } from "../agents/topic/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] || 8787);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readMaterials() {
  const [account, rules, hotUrls, recentArticles] = await Promise.all([
    readFile(path.join(root, "data/account.md"), "utf8"),
    readFile(path.join(root, "data/rules.md"), "utf8"),
    readFile(path.join(root, "data/hot-urls.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "data/recent-articles.json"), "utf8").then(JSON.parse)
  ]);

  return { account, rules, hotUrls, recentArticles };
}

async function toNodeResponse(webResponse, res) {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const fullPath = path.resolve(publicDir, `.${requested}`);
  if (!fullPath.startsWith(publicDir)) {
    await toNodeResponse(json({ error: "Forbidden" }, 403), res);
    return;
  }

  try {
    const data = await readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
    res.end(data);
  } catch {
    await toNodeResponse(json({ error: "Not found" }, 404), res);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/materials") {
      await toNodeResponse(json(await readMaterials()), res);
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/topic" || url.pathname === "/topic")) {
      const body = await readBody(req);
      const context = {
        request: {
          method: "POST",
          body,
          signal: AbortSignal.timeout(Number(process.env.AGENT_TIMEOUT_MS || 180000))
        },
        conversation_id: body.conversationId || `web_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
        env: process.env,
        store: {
          async appendMessage() {},
          claudeSessionStore() {
            return undefined;
          }
        },
        tools: {
          toClaudeMcpServer() {
            return { name: "edgeone", tools: [], allowedTools: [] };
          }
        }
      };

      await toNodeResponse(await onRequest(context), res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(url.pathname, res);
      return;
    }

    await toNodeResponse(json({ error: "Method not allowed" }, 405), res);
  } catch (error) {
    await toNodeResponse(json({ error: error.message || "Internal server error" }, 500), res);
  }
});

server.listen(port, () => {
  console.log(`Makers Topic Agent web UI: http://localhost:${port}`);
});
