import http from "node:http";

const port = Number(process.env.PORT ?? 45101);
const pages = new Map([
  ["/catalog", ["Catalog", "Browse the current collection"]],
  ["/checkout", ["Checkout", "Review and confirm the order"]],
]);

http
  .createServer((request, response) => {
    const page = pages.get(request.url ?? "");
    if (!page) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><main><h1>${page[0]}</h1><p>${page[1]}</p></main>`);
  })
  .listen(port, "127.0.0.1");
