// Inactivity-based container eviction
// Scans Redis sessions every CLEANUP_INTERVAL and destroys containers
// that have been idle for longer than INACTIVITY_TIMEOUT.

const INACTIVITY_TIMEOUT = parseInt(process.env.INACTIVITY_TIMEOUT_MS) || 10 * 60 * 1000; // 10 min
const CLEANUP_INTERVAL   = parseInt(process.env.CLEANUP_INTERVAL_MS)   ||      60 * 1000; // 1  min

export function startInactivityWatcher(docker, getAllSessions, deleteSession) {
  async function cleanupInactiveSessions() {
    const now = Date.now();
    let all;
    try {
      all = await getAllSessions();
    } catch (err) {
      console.error("[timeout] Redis error:", err.message);
      return;
    }

    for (const { sessionId, containerName, lastActive } of all) {
      if (now - lastActive < INACTIVITY_TIMEOUT) continue;

      const idleMin = Math.round((now - lastActive) / 60_000);
      console.log(
        `[timeout] Session ${sessionId} idle ${idleMin} min — evicting container ${containerName}`,
      );

      try {
        await docker
          .getContainer(containerName)
          .stop({ t: 5 })
          .catch((err) => {
            if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
          });
      } catch (err) {
        console.error(
          `[timeout] Could not stop container ${containerName}:`,
          err.message,
        );
      }

      await deleteSession(sessionId);
    }
  }

  const timer = setInterval(cleanupInactiveSessions, CLEANUP_INTERVAL);
  console.log(
    `[timeout] Inactivity watcher started — timeout ${INACTIVITY_TIMEOUT / 60_000} min, interval ${CLEANUP_INTERVAL / 60_000} min`,
  );
  return timer; // caller holds reference for clearInterval on shutdown
}
