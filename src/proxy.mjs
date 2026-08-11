import { createServer } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import { GoalWatchdogController } from "./controller.mjs";
import { RpcChannel } from "./rpc-channel.mjs";

function parseJson(data, isBinary, logger) {
  if (isBinary) return null;
  try {
    return JSON.parse(data.toString());
  } catch (error) {
    logger.warn(`Ignored non-JSON app-server frame: ${error.message}`);
    return null;
  }
}

function closeSocket(socket, code = 1000, reason = "closing") {
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}

export async function createWatchdogProxy({
  listenHost = "127.0.0.1",
  listenPort = 0,
  upstreamUrl,
  delaysMs,
  interruptAfterMs,
  recoveryGate = null,
  checkBalances = null,
  logger = console,
}) {
  if (!upstreamUrl) throw new Error("upstreamUrl is required");
  const httpServer = createServer((request, response) => {
    if (request.url === "/readyz" || request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });
  const wss = new WebSocketServer({ server: httpServer });
  let activeSession = null;
  let closing = false;

  wss.on("connection", (client) => {
    if (activeSession) {
      client.close(1013, "watchdog proxy already has an active TUI");
      return;
    }

    const upstream = new WebSocket(upstreamUrl);
    const queuedClientFrames = [];
    let sessionClosed = false;
    let controller;
    const rpc = new RpcChannel({
      send(message) {
        if (upstream.readyState !== WebSocket.OPEN) {
          throw new Error("app-server websocket is not open");
        }
        upstream.send(message);
      },
    });
    controller = new GoalWatchdogController({
      sendRequest: (method, params) => rpc.request(method, params),
      delaysMs,
      interruptAfterMs,
      recoveryGate,
      checkBalances,
      logger,
    });

    const closeSession = (code = 1000, reason = "session closed") => {
      if (sessionClosed) return;
      sessionClosed = true;
      controller.close();
      rpc.close(reason);
      closeSocket(client, code, reason);
      closeSocket(upstream, code, reason);
      if (activeSession?.client === client) activeSession = null;
    };
    activeSession = { client, upstream, close: closeSession };

    upstream.on("open", () => {
      logger.info(`Connected watchdog proxy to ${upstreamUrl}`);
      for (const frame of queuedClientFrames.splice(0)) {
        upstream.send(frame.data, { binary: frame.isBinary });
      }
    });

    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        queuedClientFrames.push({ data, isBinary });
      } else {
        closeSession(1011, "app-server websocket is unavailable");
      }
    });

    upstream.on("message", (data, isBinary) => {
      const message = parseJson(data, isBinary, logger);
      if (message && rpc.consume(message)) return;
      if (message?.method) controller.handleNotification(message);
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    client.on("close", () => closeSession(1000, "TUI disconnected"));
    upstream.on("close", () => {
      closeSession(1011, "app-server disconnected");
    });
    client.on("error", (error) => {
      logger.error(`TUI websocket error: ${error.message}`);
      closeSession(1011, "TUI websocket error");
    });
    upstream.on("error", (error) => {
      logger.error(`App-server websocket error: ${error.message}`);
      closeSession(1011, "app-server websocket error");
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(listenPort, listenHost);
  });

  const address = httpServer.address();
  const url = `ws://${listenHost}:${address.port}`;
  logger.info(`Watchdog proxy listening on ${url}`);
  httpServer.on("error", (error) => {
    logger.error(`Watchdog proxy server error: ${error.message}`);
  });

  return {
    server: httpServer,
    url,
    async close() {
      closing = true;
      activeSession?.close(1001, "watchdog proxy shutting down");
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      if (httpServer.listening) {
        await new Promise((resolve) => httpServer.close(resolve));
      }
    },
  };
}
