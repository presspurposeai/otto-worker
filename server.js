// server.js — Otto browser worker (complete file, live view included)
// Deploy target: Fly.io app "otto-worker"
// Env vars required: OTTO_WORKER_SECRET, OTTO_PUBLIC_URL
// Optional: OTTO_LIVE_FRAME_MS (default 700), PORT (default 8080)

const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const SECRET = process.env.OTTO_WORKER_SECRET || "";
const PUBLIC_URL = (process.env.OTTO_PUBLIC_URL || "https://otto-worker.fly.dev").replace(/\/$/, "");
const FRAME_MS = Number(process.env.OTTO_LIVE_FRAME_MS || 700);

// ---------------------------------------------------------------- live view

/** taskId -> { buf: Buffer, ts: number } */
const frames = new Map();

function viewToken(taskId) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`live:${taskId}`)
    .digest("hex")
    .slice(0, 32);
}

function liveUrl(taskId) {
  return `${PUBLIC_URL}/live/${taskId}?k=${viewToken(taskId)}`;
}

function checkToken(taskId, k) {
  if (!SECRET || !k) return false;

  const a = Buffer.from(String(k));
  const b = Buffer.from(viewToken(taskId));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function startLiveView(page, taskId) {
  let stopped = false;

  (async () => {
    while (!stopped) {
      try {
        if (!page.isClosed()) {
          const buf = await page.screenshot({
            type: "jpeg",
            quality: 45,
            timeout: 5000
          });

          frames.set(taskId, {
            buf,
            ts: Date.now()
          });
        }
      } catch (_) {
        // page busy or navigating — skip this frame
      }

      await new Promise((r) => setTimeout(r, FRAME_MS));
    }

    frames.delete(taskId);
  })();

  return () => {
    stopped = true;
  };
}

const VIEWER_HTML = (taskId, k) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Otto live view</title>
  <style>
    html,body{
      margin:0;
      height:100%;
      background:#0a0f1a;
      color:#e2e8f0;
      font:14px/1.4 Inter,system-ui,sans-serif
    }

    .wrap{
      height:100%;
      display:flex;
      align-items:center;
      justify-content:center
    }

    img{
      max-width:100%;
      max-height:100%;
      display:block
    }

    .idle{
      opacity:.7;
      display:flex;
      align-items:center;
      gap:8px
    }

    .dot{
      width:8px;
      height:8px;
      border-radius:99px;
      background:#4EEEB0;
      animation:p 1.2s infinite
    }

    @keyframes p{
      0%,100%{opacity:1}
      50%{opacity:.25}
    }
  </style>
</head>

<body>
  <div class="wrap">
    <div class="idle" id="idle">
      <span class="dot"></span>
      Waiting for the browser…
    </div>

    <img
      id="f"
      alt="Otto live view"
      style="display:none"
    >
  </div>

  <script>
    const src = "/live/${taskId}/frame.jpg?k=${k}&t=";

    const img = document.getElementById("f");
    const idle = document.getElementById("idle");

    function tick() {
      const n = new Image();

      n.onload = () => {
        img.src = n.src;
        img.style.display = "block";
        idle.style.display = "none";
      };

      n.src = src + Date.now();
    }

    setInterval(tick, ${FRAME_MS});
    tick();
  </script>
</body>
</html>`;

app.get("/live/:taskId/frame.jpg", (req, res) => {
  const { taskId } = req.params;

  if (!checkToken(taskId, req.query.k)) {
    return res.status(403).end();
  }

  const f = frames.get(taskId);

  if (!f) {
    return res.status(404).end();
  }

  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "no-store");
  res.send(f.buf);
});

app.get("/live/:taskId", (req, res) => {
  const { taskId } = req.params;
  const k = String(req.query.k || "");

  if (!checkToken(taskId, k)) {
    return res.status(403).send("Forbidden");
  }

  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");

  // allow embedding in the portal iframe
  res.removeHeader("X-Frame-Options");

  res.send(VIEWER_HTML(taskId, k));
});

// ---------------------------------------------------------------- callbacks

async function callback(task, payload) {
  try {
    await fetch(task.callback_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-otto-secret": SECRET,
        "x-otto-job-token": task.job_token || ""
      },
      body: JSON.stringify({
        task_id: task.task_id,
        ...payload
      })
    });
  } catch (e) {
    console.error(
      "callback failed",
      payload.type,
      e.message
    );
  }
}

const step = (
  task,
  idx,
  label,
  status,
  detail
) =>
  callback(task, {
    type: "step",
    idx,
    label,
    status,
    detail: detail || {}
  });

// ---------------------------------------------------------------- health

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "otto-worker"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now()
  });
});

app.get("/diag", async (_req, res) => {
  let browser;

  try {
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    await page.goto("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    const title = await page.title();

    res.json({
      ok: true,
      chromium: browser.version(),
      title
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

// ---------------------------------------------------------------- run

app.post("/run", (req, res) => {
  if (!SECRET || req.get("x-otto-secret") !== SECRET) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const task = req.body || {};

  if (!task.task_id || !task.callback_url) {
    return res.status(400).json({
      error: "task_id and callback_url are required"
    });
  }

  // Answer immediately with the live URL so the portal can show "Watch live".
  res.json({
    ok: true,
    accepted: true,
    live_view_url: liveUrl(task.task_id)
  });

  runTask(task).catch(async (e) => {
    await callback(task, {
      type: "finish",
      status: "failed",
      error: e.message
    });
  });
});

async function runTask(task) {
  const started = Date.now();

  let browser;
  let stopLive = () => {};

  try {
    await step(
      task,
      1,
      "Launching the browser",
      "running"
    );

    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 800
      }
    });

    const page = await context.newPage();

    // ---- live view on ----
    stopLive = startLiveView(
      page,
      task.task_id
    );

    await callback(task, {
      type: "live",
      live_view_url: liveUrl(task.task_id)
    });

    await step(
      task,
      1,
      "Launching the browser",
      "succeeded"
    );

    const inputs = task.inputs || {};

    const target =
      inputs.url ||
      (
        typeof task.goal === "string" &&
        (task.goal.match(/https?:\/\/\S+/) || [])[0]
      ) ||
      (
        typeof task.goal === "string" &&
        (task.goal.match(/[a-z0-9-]+\.[a-z]{2,}\S*/i) || [])[0]
      ) ||
      "https://example.com";

    const url = target.startsWith("http")
      ? target
      : `https://${target}`;

    await step(
      task,
      2,
      `Navigating to ${url}`,
      "running"
    );

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(1500);

    await step(
      task,
      2,
      `Navigating to ${url}`,
      "succeeded"
    );

    await step(
      task,
      3,
      "Capturing the result",
      "running"
    );

    const title = await page.title();

    const headings = await page
      .$$eval(
        "h1, h2",
        (els) =>
          els
            .slice(0, 8)
            .map((e) => e.textContent.trim())
            .filter(Boolean)
      )
      .catch(() => []);

    await step(
      task,
      3,
      "Capturing the result",
      "succeeded",
      {
        title
      }
    );

    await callback(task, {
      type: "finish",
      status: "succeeded",
      result: {
        url: page.url(),
        title,
        headings
      },
      browser_ms: Date.now() - started
    });
  } catch (e) {
    await callback(task, {
      type: "finish",
      status: "failed",
      error: e.message,
      browser_ms: Date.now() - started
    });
  } finally {
    stopLive();

    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

app.listen(
  PORT,
  "0.0.0.0",
  () => console.log(`otto-worker listening on ${PORT}`)
);
