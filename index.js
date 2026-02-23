import "dotenv/config";

import crypto from "crypto";
import express from "express";
import cors from "cors";
import Dockerode from "dockerode";
import Redis from "ioredis";
import { startInactivityWatcher } from "./timeout.js";

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));

const docker = new Dockerode({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "subterm-server";
const MAX_CONTAINERS = parseInt(process.env.MAX_CONTAINERS) || 10;

// --- Redis ---
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
redis.on("error", (err) => console.error("[redis] Error:", err.message));

const SESSION_KEY = (id) => `session:${id}`;
const SESSIONS_SET = "sessions";
const CONTAINER_COUNTER = "containers:active";

// Atomically increment counter only if it is below the cap.
// Returns the new count, or -1 if the cap would be exceeded.
const LUA_RESERVE = `local cur = tonumber(redis.call('GET', KEYS[1]) or 0)
  if cur >= tonumber(ARGV[1]) then return -1 end
  return redis.call('INCR', KEYS[1])`;

async function reserveContainerSlot() {
  const result = await redis.eval(
    LUA_RESERVE,
    1,
    CONTAINER_COUNTER,
    MAX_CONTAINERS,
  );
  return result !== -1; // true = slot granted
}

async function releaseContainerSlot() {
  const val = await redis.decr(CONTAINER_COUNTER);
  if (val < 0) await redis.set(CONTAINER_COUNTER, 0); // guard against underflow
}

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
  await releaseContainerSlot();
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
  clearInterval(cleanupTimer);
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

const cleanupTimer = startInactivityWatcher(
  docker,
  getAllSessions,
  deleteSession,
);

// POST /api/container — spin up a new sandbox container, return its host port
app.post("/api/container", async (req, res) => {
  try {
    const granted = await reserveContainerSlot();
    if (!granted) {
      return res.status(503).json({
        error: "Container limit reached",
        detail: `Maximum of ${MAX_CONTAINERS} simultaneous containers allowed`,
      });
    }

    const NETWORK_NAME = process.env.SANDBOX_NETWORK || "subterm-net";

    // Cryptographically secure session ID
    const sessionId = crypto.randomBytes(16).toString("hex");
    const containerName = `sess_${sessionId}`;

    const WORKSPACE_SIZE = process.env.CONTAINER_DISK_LIMIT || "1G";
    const MEMORY_LIMIT =
      parseInt(process.env.CONTAINER_MEMORY_MB || "512") * 1024 * 1024;
    const CPU_CORES = parseFloat(process.env.CONTAINER_CPU_CORES || "1");
    const PIDS_LIMIT = parseInt(process.env.CONTAINER_PIDS_LIMIT || "100");

    const baseContainerConfig = {
      Image: SANDBOX_IMAGE,
      name: containerName,
      Tty: false,
      ExposedPorts: { "3000/tcp": {} },
      Env: [`SESSION_ID=${sessionId}`, `WORKSPACE_PATH=/workspace`],
      HostConfig: {
        AutoRemove: true,
        NetworkMode: NETWORK_NAME,
        // No PortBindings — all traffic routes via the internal Docker network

        // Workspace disk cap via tmpfs (works on any filesystem, including ext4)
        Tmpfs: {
          "/workspace": `rw,size=${WORKSPACE_SIZE},mode=755`,
        },

        // Resource limits — prevent runaway containers from affecting the host
        Memory: MEMORY_LIMIT,
        MemorySwap: MEMORY_LIMIT, // equal = no swap headroom
        NanoCpus: Math.round(CPU_CORES * 1e9),
        PidsLimit: PIDS_LIMIT,
      },
    };

    // Attempt StorageOpt disk quota (only works on xfs + pquota; graceful fallback otherwise)
    const diskLimit = process.env.CONTAINER_DISK_LIMIT || "1G";
    let container;
    if (diskLimit) {
      const configWithQuota = {
        ...baseContainerConfig,
        HostConfig: {
          ...baseContainerConfig.HostConfig,
          StorageOpt: { size: diskLimit },
        },
      };
      try {
        container = await docker.createContainer(configWithQuota);
        console.log(
          `[gateway] Container ${containerName} created with disk limit ${diskLimit}`,
        );
      } catch (quotaErr) {
        // StorageOpt is not supported on this storage driver — create without quota
        console.warn(
          `[gateway] StorageOpt not supported (${quotaErr.message}), ` +
            "falling back — workspace capped via tmpfs.",
        );
        container = await docker.createContainer(baseContainerConfig);
      }
    } else {
      container = await docker.createContainer(baseContainerConfig);
    }

    await container.start();

    const now = Date.now();
    const workspacePath = `/`;
    await setSession(sessionId, {
      containerName,
      workspacePath,
      createdAt: now,
      lastActive: now,
    });

    console.log(
      `[gateway] Started container ${containerName} (${container.id.slice(0, 12)})`,
    );

    // Clean up session when the container stops on its own
    container
      .wait()
      .then(() => deleteSession(sessionId)) // also releases the slot
      .catch(() => {});

    res.json({ sessionId, workspacePath });
  } catch (err) {
    // If container creation failed after we reserved a slot, release it
    await releaseContainerSlot().catch(() => {});
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

    res.json({
      sessionId,
      containerName,
      workspacePath,
      status,
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
