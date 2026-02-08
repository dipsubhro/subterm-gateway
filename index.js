require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Dockerode = require("dockerode");

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));

const docker = new Dockerode({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "subterm-server";

// POST /api/container — spin up a new sandbox container, return its host port
app.post("/api/container", async (req, res) => {
  try {
    const container = await docker.createContainer({
      Image: SANDBOX_IMAGE,
      Tty: false,
      ExposedPorts: { "3334/tcp": {} },
      HostConfig: {
        PortBindings: { "3334/tcp": [{ HostPort: "0" }] }, // 0 = random port
        AutoRemove: true,
      },
    });

    await container.start();

    const info = await container.inspect();
    const hostPort = info.NetworkSettings.Ports["3334/tcp"][0].HostPort;

    console.log(
      `[gateway] Started container ${container.id.slice(0, 12)} on host port ${hostPort}`,
    );

    res.json({ containerId: container.id, hostPort: parseInt(hostPort) });
  } catch (err) {
    console.error("[gateway] Error creating container:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`[gateway] Listening on http://0.0.0.0:${PORT}`),
);
