import http from "node:http";

const port = Number(process.env.PORT ?? 43191);
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "healthy" }));
    return;
  }

  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1");
