import "dotenv/config";

import crypto from "crypto";
import express from "express";
import cors from "cors";
import Dockerode from "dockerode";
import Redis from "ioredis";

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));

const docker = new Dockerode({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "subterm-server";

// --- Redis ---
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
redis.on("error", (err) => console.error("[redis] Error:", err.message));

const SESSION_KEY = (id) => `session:${id}`;
const SESSIONS_SET = "sessions";

async function setSession(sessionId, data) {
  await redis.set(SESSION_KEY(sessionId), JSON.stringify(data));
  await redis.sadd(SESSIONS_SET, sessionId);
}

async function getSession(sessionId) {
  const raw = await redis.get(SESSION_KEY(sessionId));
  return raw ? JSON.parse(raw) : null;
}

async function deleteSession(sessionId) {
  await redis.del(SESSION_KEY(sessionId));
  await redis.srem(SESSIONS_SET, sessionId);
}

async function getAllSessions() {
  const ids = await redis.smembers(SESSIONS_SET);
  if (ids.length === 0) return [];
  const pipeline = redis.pipeline();
  ids.forEach((id) => pipeline.get(SESSION_KEY(id)));
  const results = await pipeline.exec();
  return ids
    .map((id, i) => {
      const raw = results[i][1];
      if (!raw) return null;
      return { sessionId: id, ...JSON.parse(raw) };
    })
    .filter(Boolean);
}

async function shutdown() {
  console.log("[gateway] Shutting down — stopping all containers...");
  const all = await getAllSessions();
  await Promise.allSettled(
    all.map(({ containerName }) =>
      docker
        .getContainer(containerName)
        .stop()
        .catch(() => {}),
    ),
  );
  await redis.quit();
  console.log("[gateway] All containers stopped. Exiting.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// POST /api/container — spin up a new sandbox container, return its host port
app.post("/api/container", async (req, res) => {
  try {
    const NETWORK_NAME = process.env.SANDBOX_NETWORK || "subterm-net";

    // Cryptographically secure session ID
    const sessionId = crypto.randomBytes(16).toString("hex");
    const containerName = `sess_${sessionId}`;

    const container = await docker.createContainer({
      Image: SANDBOX_IMAGE,
      name: containerName,
      Tty: false,
      ExposedPorts: { "3334/tcp": {} },
      HostConfig: {
        PortBindings: { "3334/tcp": [{ HostPort: "0" }] }, // 0 = random port
        AutoRemove: true,
        NetworkMode: NETWORK_NAME,
      },
    });

    await container.start();

    const now = Date.now();
    const workspacePath = `/workspace/${sessionId}/`;
    await setSession(sessionId, {
      containerName,
      workspacePath,
      createdAt: now,
      lastActive: now,
    });

    const info = await container.inspect();
    const hostPort = info.NetworkSettings.Ports["3334/tcp"][0].HostPort;

    console.log(
      `[gateway] Started container ${containerName} (${container.id.slice(0, 12)}) on host port ${hostPort}`,
    );

    // Clean up session when the container stops on its own
    container
      .wait()
      .then(() => deleteSession(sessionId))
      .catch(() => {});

    res.json({ sessionId, workspacePath, hostPort: parseInt(hostPort) });
  } catch (err) {
    console.error("[gateway] Error creating container:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/containers — list all active sessions
app.get("/api/containers", async (req, res) => {
  try {
    const list = await getAllSessions();
    res.json({ count: list.length, sessions: list });
  } catch (err) {
    console.error("[gateway] Error listing sessions:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/container/:id — return session metadata + live container status
app.get("/api/container/:id", async (req, res) => {
  const { id: sessionId } = req.params;
  const session = await getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const { containerName, workspacePath, createdAt, lastActive } = session;

  try {
    const info = await docker.getContainer(containerName).inspect();
    const status = info.State.Status; // "running" | "exited" | "paused" …
    const hostPort =
      info.NetworkSettings.Ports?.["3334/tcp"]?.[0]?.HostPort ?? null;

    res.json({
      sessionId,
      containerName,
      workspacePath,
      status,
      hostPort: hostPort ? parseInt(hostPort) : null,
      createdAt,
      lastActive,
    });
  } catch (err) {
    // Container gone but session entry still exists
    if (err.statusCode === 404) {
      return res.status(410).json({ error: "Container no longer exists" });
    }
    console.error("[gateway] Error inspecting container:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/container/:id — stop and destroy a sandbox container by sessionId
app.delete("/api/container/:id", async (req, res) => {
  const { id: sessionId } = req.params;
  const session = await getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const { containerName } = session;

  try {
    const container = docker.getContainer(containerName);

    // Stop the container; AutoRemove will delete it automatically.
    // Force-kill if it doesn't stop within 5 s.
    await container.stop({ t: 5 }).catch((err) => {
      // 304 = container already stopped, 404 = already removed — both are fine
      if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
    });

    await deleteSession(sessionId);

    console.log(
      `[gateway] Destroyed container ${containerName} (session ${sessionId})`,
    );
    res.json({ message: "Container destroyed", sessionId });
  } catch (err) {
    console.error("[gateway] Error destroying container:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`[gateway] Listening on http://0.0.0.0:${PORT}`),
);
