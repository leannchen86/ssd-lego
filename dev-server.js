import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const root = import.meta.dir;
const port = Number(Bun.env.PORT || 8080);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function contentType(filePath) {
  return contentTypes[extname(filePath)] || "application/octet-stream";
}

function filePathFor(urlPathname) {
  const pathname = decodeURIComponent(urlPathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(root, relativePath));

  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return null;
  }

  return filePath;
}

async function serveFile(filePath) {
  let target = filePath;
  const info = await stat(target);

  if (info.isDirectory()) {
    target = join(target, "index.html");
  }

  return new Response(Bun.file(target), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType(target),
    },
  });
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const filePath = filePathFor(url.pathname);

    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }

    try {
      return await serveFile(filePath);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
});

console.log(`Serving http://localhost:${port}`);
