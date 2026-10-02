import http from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 45102);
http
  .createServer((request, response) => {
    if (request.url !== "/dashboard") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const source = readFileSync(new URL("./src/dashboard.jsx", import.meta.url), "utf8");
    const className = /className="([^"]+)"/.exec(source)?.[1] ?? "primary-action";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<main><button class="${className}">Create report</button></main>`);
  })
  .listen(port, "127.0.0.1");
