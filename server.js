const express = require('express');
const { chromium } = require('playwright');
const app = express();

app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const WORKER_SECRET = process.env.OTTO_WORKER_SECRET;

function auth(req, res, next) {
  if (req.headers['x-otto-secret'] !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function sendCallback(callbackUrl, payload, jobToken) {
  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Otto-Secret': WORKER_SECRET,
        'X-Otto-Job-Token': jobToken
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Callback failed:', e.message);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/run', auth, async (req, res) => {
  const {
    task_id,
    skill_key,
    goal,
    inputs,
    callback_url,
    job_token
  } = req.body;

  if (!task_id || !callback_url || !job_token) {
    return res.status(400).json({
      error: 'Missing task_id, callback_url, or job_token'
    });
  }

  res.json({
    ok: true,
    status: 'running'
  });

  const step = async (
    idx,
    label,
    status = 'succeeded',
    detail = {}
  ) => {
    await sendCallback(
      callback_url,
      {
        task_id,
        type: 'step',
        idx,
        label,
        status,
        detail
      },
      job_token
    );
  };

  let browser;

  try {
    await step(
      0,
      'Launching browser session',
      'running'
    );

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 900
      }
    });

    const page = await context.newPage();

    await step(
      1,
      'Navigating to task target',
      'running',
      {
        skill_key,
        goal
      }
    );

    const url = inputs?.url || 'https://www.google.com';

    await page.goto(url, {
      waitUntil: 'networkidle'
    });

    await step(
      2,
      'Capturing result',
      'succeeded',
      {
        title: await page.title(),
        url: page.url()
      }
    );

    await sendCallback(
      callback_url,
      {
        task_id,
        type: 'finish',
        status: 'succeeded',
        result: {
          skill_key,
          url: page.url(),
          title: await page.title()
        },
        cost_usd: 0.05,
        replay_available: false
      },
      job_token
    );
  } catch (err) {
    await sendCallback(
      callback_url,
      {
        task_id,
        type: 'finish',
        status: 'failed',
        error: err.message
      },
      job_token
    );
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Otto worker listening on ${PORT}`);
});