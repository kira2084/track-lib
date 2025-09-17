const axios = require("axios");

function trackMiddleware({ trackingUrl, apiKey, sendInterval = 2000 }) {
  if (!trackingUrl || !apiKey)
    throw new Error("trackingUrl and apiKey required");

  const buffer = [];
  let flushing = false;

  function pushEvent(ev) {
    buffer.push(ev);
    flush();
  }

  async function flush() {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const toSend = buffer.splice(0, buffer.length);
    try {
      await axios.post(
        `${trackingUrl}/api/track`,
        { events: toSend },
        { headers: { "x-track-api-key": apiKey } }
      );
    } catch (err) {
      buffer.unshift(...toSend); // requeue
    } finally {
      flushing = false;
    }
  }

  setInterval(() => flush().catch(() => {}), sendInterval);

  // --------- Patch console ---------
  ["log", "warn", "error", "info"].forEach((level) => {
    const orig = console[level];
    console[level] = (...args) => {
      try {
        pushEvent({
          type: "console",
          level,
          message: args
            .map((a) => {
              try {
                return typeof a === "string" ? a : JSON.stringify(a);
              } catch {
                return String(a);
              }
            })
            .join(" "),
          timestamp: new Date(),
        });
      } catch {}
      orig(...args);
    };
  });

  // --------- Patch axios globally ---------
  axios.interceptors.request.use((cfg) => {
    cfg.metadata = { start: Date.now() };
    return cfg;
  });

  axios.interceptors.response.use(
    (res) => {
      pushEvent({
        type: "http",
        method: res.config.method,
        url: res.config.url,
        status: res.status,
        durationMs: Date.now() - res.config.metadata.start,
        timestamp: new Date(),
      });
      return res;
    },
    (err) => {
      const cfg = err.config || {};
      pushEvent({
        type: "http",
        method: cfg.method,
        url: cfg.url,
        status: err.response ? err.response.status : 0,
        durationMs: cfg.metadata ? Date.now() - cfg.metadata.start : 0,
        timestamp: new Date(),
        error: err.message,
      });
      return Promise.reject(err);
    }
  );

  // --------- Middleware for incoming Express ---------
  return (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      pushEvent({
        type: "incoming",
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
        timestamp: new Date(),
      });
    });
    next();
  };
}

module.exports = { trackMiddleware };
