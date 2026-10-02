import http from "node:http";

const port = Number(process.env.PORT ?? 45103);
http
  .createServer((request, response) => {
    if (request.url !== "/account") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><main><h1>Account</h1></main>");
  })
  .listen(port, "127.0.0.1");
