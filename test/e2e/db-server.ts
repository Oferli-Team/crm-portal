// Runs only via `npx tsx` as its own subprocess (see test/e2e/global-setup.ts),
// never imported by a Playwright-transformed file. Playwright Test's own
// esbuild-based transform cannot load src/generated/prisma/client.ts (an
// `import.meta`-using ESM module) the way Vitest's Vite-based pipeline
// does — every DB touchpoint an E2E test needs (fixture seed/cleanup, and
// ad-hoc assertions against what the UI just did) goes through this tiny
// HTTP server instead, over plain fetch() calls Playwright test files can
// make without importing Prisma themselves. See the Stage 5 report.
import { createServer } from "node:http";
import { prisma } from "@/lib/prisma";
import { seedTestData, cleanupTestData } from "../fixtures/seed";
import { E2E_DB_SERVER_PORT } from "../support/e2e-ports";

const PORT = E2E_DB_SERVER_PORT;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};

    if (req.url === "/seed" && req.method === "POST") {
      const fixtures = await seedTestData();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(fixtures));
      return;
    }

    if (req.url === "/cleanup" && req.method === "POST") {
      await cleanupTestData(body.fixtures);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    // Generic escape hatch for ad-hoc assertions: { model, operation, args }
    // -> prisma[model][operation](args). Test-only, never reachable
    // outside this subprocess (there is no route in the actual app that
    // proxies to this).
    if (req.url === "/query" && req.method === "POST") {
      const { model, operation, args } = body;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (prisma as any)[model][operation](args ?? {});
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`E2E db-server listening on ${PORT}`);
});

process.on("SIGTERM", () => server.close());
