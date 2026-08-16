// server.js — Otto browser worker v3
// Adds: live view streaming, saved website logins (persistent sessions),
//       and multi-step scripted actions (click / type / press / wait / scroll).
//
// Required Fly secrets: OTTO_WORKER_SECRET, OTTO_PUBLIC_URL
// Deploy: replace this file wholesale in the otto-worker repo, then `fly deploy`.

const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

const SECRET = process.env.OTTO_WORKER_SECRET || "";
const PUBLIC_URL = (
  process.env.OTTO_PUBLIC_URL || "https://otto-worker.fly.dev"
).replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

// ------------------------------------------------------------------ live view
// Latest JPEG frame per task, held in memory only for the life of the task.
const frames = new Map(); // taskId -> Buffer

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

function checkView(req, taskId) {
  return (
    typeof req.query.k === "string" &&
    req.query.k === viewToken(taskId)
  );
}

app.get("/live/:taskId/frame.jpg", (req, res) => {
  const { taskId } = req.params;

  if (!checkView(req, taskId)) {
    return res.status(403).send("Forbidden");
  }

  const buf = frames.get(taskId);

  if (!buf) {
    return res.status(404).send("No frame yet");
  }

  res.set("Cache-Control", "no-store");
  res.type("jpeg").send(buf);
});

app.get("/live/:taskId", (req, res) => {
  const { taskId } = req.params;

  if (!checkView(req, taskId)) {
    return res.status(403).send("Forbidden");
  }

  const k = viewToken(taskId);

  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Otto live view</title>

  <style>
    html,body{
      margin:0;
      height:100%;
      background:#0b1220;
      overflow:hidden
    }

    #wrap{
      position:absolute;
      inset:0;
      display:flex;
      align-items:center;
      justify-content:center
    }

    img{
      max-width:100%;
      max-height:100%;
      display:block
    }

    #msg{
      color:#94a3b8;
      font:14px -apple-system,system-ui,sans-serif
    }

    #cursor{
      position:absolute;
      width:18px;
      height:18px;
      margin:-9px 0 0 -9px;
      border-radius:50%;
      background:rgba(6,182,212,.35);
      border:2px solid #06b6d4;
      pointer-events:none;
      transition:left .25s ease,top .25s ease;
      display:none
    }
  </style>
</head>

<body>
  <div id="wrap">
    <span id="msg">Starting the session…</span>
    <img
      id="f"
      alt="Otto live view"
      style="display:none"
    >
    <div id="cursor"></div>
  </div>

  <script>
    const img = document.getElementById('f');
    const msg = document.getElementById('msg');
    const src = "/live/${taskId}/frame.jpg?k=${k}&t=";

    let stopped = false;

    function tick() {
      if (stopped) return;

      const next = new Image();

      next.onload = () => {
        img.src = next.src;
        img.style.display = 'block';
        msg.style.display = 'none';
        setTimeout(tick, 350);
      };

      next.onerror = () => {
        setTimeout(tick, 900);
      };

      next.src = src + Date.now();
    }

    tick();

    window.addEventListener('pagehide', () => {
      stopped = true;
    });
  </script>
</body>
</html>`);
});

// ------------------------------------------------------------------- health

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "otto-worker",
    version: 3
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: 3,
    ts: Date.now()
  });
});

app.get("/diag", async (_req, res) => {
  let browser;

  try {
    browser = await launch();

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    res.json({
      ok: true,
      version: 3,
      chromium: browser.version(),
      title: await page.title()
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e && e.message || e)
    });
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
});

function launch() {
  return chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled"
    ]
  });
}

// --------------------------------------------------------------------- run

app.post("/run", (req, res) => {
  if (
    !SECRET ||
    req.headers["x-otto-secret"] !== SECRET
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const task = req.body || {};

  if (!task.task_id) {
    return res.status(400).json({
      error: "task_id required"
    });
  }

  // Answer immediately with the live URL so the portal can slide the viewer in.
  res.json({
    ok: true,
    accepted: true,
    live_view_url: liveUrl(task.task_id)
  });

  runTask(task).catch((e) => {
    console.error("task failed", e);
  });
});

async function callback(task, payload) {
  try {
    await fetch(task.callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-otto-secret": SECRET,
        "x-otto-job-token": task.job_token || ""
      },
      body: JSON.stringify({
        task_id: task.task_id,
        ...payload
      })
    });
  } catch (e) {
    console.error("callback error", e.message);
  }
}

function firstUrl(task) {
  const i = task.inputs || {};

  if (i.url) {
    return String(i.url);
  }

  const m = String(task.goal || "").match(
    /https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i
  );

  if (!m) {
    return null;
  }

  const raw = m[0];

  return raw.startsWith("http")
    ? raw
    : `https://${raw}`;
}

// Actions come from inputs.steps:
// [{action, selector?, text?, ms?}]
async function runAction(page, step) {
  const sel = step.selector;

  switch (
    String(step.action || "").toLowerCase()
  ) {
    case "goto":
      await page.goto(step.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000
      });
      break;

    case "click":
      await page.click(sel, {
        timeout: 20000
      });
      break;

    case "type":
    case "fill":
      await page.fill(
        sel,
        String(step.text ?? ""),
        {
          timeout: 20000
        }
      );
      break;

    case "press":
      await page.keyboard.press(
        step.text || "Enter"
      );
      break;

    case "scroll":
      await page.mouse.wheel(
        0,
        Number(step.ms || 800)
      );
      break;

    case "wait":
      await page.waitForTimeout(
        Number(step.ms || 1500)
      );
      break;

    case "wait_for":
      await page.waitForSelector(
        sel,
        {
          timeout: Number(
            step.ms || 20000
          )
        }
      );
      break;

    default:
      await page.waitForTimeout(500);
  }
}

async function runTask(task) {
  const taskId = task.task_id;

  let browser;
  let context;
  let page;
  let streamer;

  let idx = 0;

  const step = (
    label,
    status = "succeeded",
    detail = {}
  ) =>
    callback(task, {
      type: "step",
      idx: idx++,
      label,
      status,
      detail
    });

  try {
    await callback(task, {
      type: "live",
      live_view_url: liveUrl(taskId)
    });

    await step(
      "Opening a secure browser session",
      "running"
    );

    browser = await launch();

    context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 800
      },

      // Saved website login for this tenant + domain,
      // if PressPurpose sent one.
      storageState:
        task.storage_state &&
        Object.keys(task.storage_state).length
          ? task.storage_state
          : undefined,

      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125 Safari/537.36"
    });

    page = await context.newPage();

    // Stream frames for the live view.
    streamer = setInterval(
      async () => {
        try {
          frames.set(
            taskId,
            await page.screenshot({
              type: "jpeg",
              quality: 55
            })
          );
        } catch {}
      },
      700
    );

    if (task.storage_state) {
      await step(
        "Restoring your saved sign-in"
      );
    }

    const url = firstUrl(task);

    if (!url) {
      throw new Error(
        "No website was provided for this task."
      );
    }

    await step(
      `Opening ${url}`,
      "running"
    );

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(1200);

    const scripted =
      Array.isArray(task.inputs?.steps)
        ? task.inputs.steps
        : [];

    for (const s of scripted) {
      await step(
        s.label ||
          `${s.action} ${
            s.selector || s.text || ""
          }`.trim(),
        "running"
      );

      await runAction(page, s);

      await page.waitForTimeout(600);
    }

    await step("Reading the page");

    const title = await page.title();

    const text = (
      await page.evaluate(
        () =>
          document.body?.innerText || ""
      )
    ).slice(0, 4000);

    const signedIn = await page.evaluate(
      () =>
        !/\b(sign in|log in|login)\b/i.test(
          document.body?.innerText?.slice(
            0,
            1500
          ) || ""
        )
    );

    // Hand the refreshed cookies back so the next task stays signed in.
    if (task.session_domain) {
      try {
        const state =
          await context.storageState();

        await callback(task, {
          type: "session",
          domain: task.session_domain,
          storage_state: state
        });

        await step(
          "Saved this sign-in for next time"
        );
      } catch {}
    }

    await callback(task, {
      type: "finish",
      status: "succeeded",

      result: {
        url: page.url(),
        title,
        signed_in: signedIn,
        actions_run: scripted.length,

        summary:
          `Opened ${page.url()} — "${title}". ` +
          `${
            scripted.length
              ? `Completed ${scripted.length} action(s). `
              : ""
          }` +
          `${text.slice(0, 600)}`
      },

      browser_ms: 0,
      replay_available: false
    });
  } catch (e) {
    await callback(task, {
      type: "finish",
      status: "failed",
      error: String(
        e && e.message || e
      )
    });
  } finally {
    clearInterval(streamer);
    frames.delete(taskId);

    try {
      await context?.close();
    } catch {}

    try {
      await browser?.close();
    } catch {}
  }
}

app.listen(
  PORT,
  "0.0.0.0",
  () =>
    console.log(
      `otto-worker v3 listening on ${PORT}`
    )
);
