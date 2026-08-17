// human-cursor.js — drop into the otto-worker repo (same folder as server.js)
//
// Gives the Otto live stream a visible mouse pointer and human-feeling input:
//   • a real arrow-cursor SVG overlay painted INSIDE the page (so it shows up in
//     the CDP screencast and in step screenshots)
//   • eased, curved pointer movement instead of teleporting
//   • click ripple + brief press state
//   • humanType(): per-character typing with jittered delays and a caret focus ring
//   • humanPaste(): instant fill with a "Pasted" chip, for long content
//
// Usage in server.js:
//   const { attachCursor, humanMove, humanClick, humanType, humanPaste } = require("./human-cursor");
//   await attachCursor(page);            // once per page, right after creation
//   await humanClick(page, 'input[name=q]');
//   await humanType(page, 'input[name=q]', 'jake press presspurpose ai');
//   await humanPaste(page, 'textarea', longText);

const OVERLAY_ID = "__otto_cursor__";

/** Script injected into every document so the pointer survives navigations. */
const OVERLAY_SCRIPT = `
(() => {
  if (window.__ottoCursorReady) return;
  window.__ottoCursorReady = true;

  const ID = ${JSON.stringify(OVERLAY_ID)};

  const ensure = () => {
    if (!document.body) return null;
    let root = document.getElementById(ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = ID;
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = [
      "position:fixed","left:0","top:0","width:0","height:0",
      "z-index:2147483647","pointer-events:none",
      "transform:translate3d(-100px,-100px,0)",
      "transition:transform 90ms linear",
      "will-change:transform",
    ].join(";");

    // macOS-style arrow pointer with a soft drop shadow so it reads on any page.
    root.innerHTML = \`
      <svg width="26" height="30" viewBox="0 0 26 30" fill="none"
           style="position:absolute;left:-2px;top:-2px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))">
        <path d="M6 3.2 L6 24.2 L11.1 19.4 L14.3 26.6 L17.9 25.1 L14.7 18.1 L21.4 17.9 Z"
              fill="#ffffff" stroke="#0f172a" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
      <span data-otto-ring style="
        position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:9999px;
        border:2px solid rgba(6,182,212,.9);opacity:0;transform:scale(.4);
        transition:opacity 180ms ease,transform 180ms ease"></span>
      <span data-otto-chip style="
        position:absolute;left:22px;top:16px;white-space:nowrap;
        font:600 11px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        color:#e2e8f0;background:rgba(15,23,42,.92);border:1px solid rgba(148,163,184,.35);
        padding:3px 8px;border-radius:9999px;opacity:0;transition:opacity 140ms ease"></span>
    \`;
    document.body.appendChild(root);
    return root;
  };

  window.__ottoCursor = {
    move(x, y, instant) {
      const root = ensure();
      if (!root) return;
      root.style.transition = instant ? "none" : "transform 90ms linear";
      root.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    },
    press() {
      const root = ensure();
      if (!root) return;
      const ring = root.querySelector("[data-otto-ring]");
      if (!ring) return;
      ring.style.transition = "none";
      ring.style.opacity = "1";
      ring.style.transform = "scale(.4)";
      requestAnimationFrame(() => {
        ring.style.transition = "opacity 420ms ease, transform 420ms ease";
        ring.style.opacity = "0";
        ring.style.transform = "scale(1.5)";
      });
    },
    label(text) {
      const root = ensure();
      if (!root) return;
      const chip = root.querySelector("[data-otto-chip]");
      if (!chip) return;
      if (!text) { chip.style.opacity = "0"; return; }
      chip.textContent = text;
      chip.style.opacity = "1";
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensure, { once: true });
  } else {
    ensure();
  }
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

/** Attach the overlay to a page (survives navigation via addInitScript). */
async function attachCursor(page) {
  await page.addInitScript(OVERLAY_SCRIPT);
  try {
    await page.evaluate(OVERLAY_SCRIPT);
  } catch {
    /* page may not have a document yet — init script covers it */
  }
  page.__ottoPointer = { x: 60, y: 80 };
  await safeEval(page, (p) => window.__ottoCursor?.move(p.x, p.y, true), page.__ottoPointer);
}

async function safeEval(page, fn, arg) {
  try {
    await page.evaluate(fn, arg);
  } catch {
    /* mid-navigation evaluates are expected to fail sometimes */
  }
}

/** Re-inject after a navigation if the overlay was wiped. */
async function ensureCursor(page) {
  const ok = await page.evaluate(() => !!window.__ottoCursor).catch(() => false);
  if (!ok) await safeEval(page, new Function(OVERLAY_SCRIPT));
}

/** Show / hide the little status chip that trails the pointer. */
async function cursorLabel(page, text) {
  await safeEval(page, (t) => window.__ottoCursor?.label(t), text || "");
}

/**
 * Glide the pointer to (x, y) along an eased, slightly curved path and keep
 * the real Playwright mouse in sync so hover states fire like a human visit.
 */
async function humanMove(page, x, y, { steps } = {}) {
  await ensureCursor(page);
  const from = page.__ottoPointer || { x: 60, y: 80 };
  const dist = Math.hypot(x - from.x, y - from.y);
  const n = steps || Math.max(8, Math.min(28, Math.round(dist / 26)));

  // Control point for a gentle arc — straight lines look robotic.
  const cx = (from.x + x) / 2 + rand(-40, 40);
  const cy = (from.y + y) / 2 + rand(-30, 30);

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    const px = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * x;
    const py = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * y;
    await safeEval(page, (p) => window.__ottoCursor?.move(p.x, p.y), { x: px, y: py });
    await page.mouse.move(px, py).catch(() => {});
    await sleep(rand(8, 18));
  }

  await safeEval(page, (p) => window.__ottoCursor?.move(p.x, p.y), { x, y });
  page.__ottoPointer = { x, y };
}

async function centerOf(page, target) {
  const locator = typeof target === "string" ? page.locator(target).first() : target;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element not visible: " + String(target));
  return {
    locator,
    x: box.x + box.width / 2 + rand(-Math.min(6, box.width / 5), Math.min(6, box.width / 5)),
    y: box.y + box.height / 2 + rand(-Math.min(4, box.height / 5), Math.min(4, box.height / 5)),
  };
}

/** Move to an element, show the press ripple, then click it. */
async function humanClick(page, target, { label } = {}) {
  const { locator, x, y } = await centerOf(page, target);
  if (label) await cursorLabel(page, label);
  await humanMove(page, x, y);
  await sleep(rand(60, 160));
  await safeEval(page, () => window.__ottoCursor?.press());
  await sleep(70);
  await locator.click({ timeout: 15000 }).catch(async () => {
    await page.mouse.click(x, y);
  });
  await sleep(rand(80, 200));
  if (label) await cursorLabel(page, "");
}

/**
 * Type like a person: click the field, then emit characters with jittered
 * delays and slightly longer pauses after spaces and punctuation.
 */
async function humanType(page, target, text, { label = "Typing…", pressEnter = false } = {}) {
  const { locator } = await centerOf(page, target);
  await humanClick(page, locator);
  await cursorLabel(page, label);
  await locator.fill("").catch(() => {});

  for (const ch of String(text)) {
    await page.keyboard.type(ch, { delay: 0 }).catch(() => {});
    let d = rand(45, 115);
    if (ch === " ") d += rand(20, 70);
    if (".,?!/@".includes(ch)) d += rand(40, 120);
    if (Math.random() < 0.06) d += rand(120, 280); // occasional think-pause
    await sleep(d);
  }

  await cursorLabel(page, "");
  if (pressEnter) {
    await sleep(rand(150, 350));
    await page.keyboard.press("Enter").catch(() => {});
  }
}

/**
 * Paste-style entry for long content: fills the field in one shot and flashes
 * a "Pasted" chip so the viewer understands it wasn't hand-typed.
 */
async function humanPaste(page, target, text, { label = "Pasting…", pressEnter = false } = {}) {
  const { locator } = await centerOf(page, target);
  await humanClick(page, locator);
  await cursorLabel(page, label);
  await sleep(rand(180, 320));
  await locator.fill(String(text)).catch(async () => {
    await page.keyboard.insertText(String(text));
  });
  await cursorLabel(page, "Pasted");
  await sleep(700);
  await cursorLabel(page, "");
  if (pressEnter) {
    await sleep(rand(150, 300));
    await page.keyboard.press("Enter").catch(() => {});
  }
}

/** Human-ish scroll with the pointer parked on the page. */
async function humanScroll(page, dy = 600) {
  const chunks = Math.max(3, Math.round(Math.abs(dy) / 180));
  const step = dy / chunks;
  for (let i = 0; i < chunks; i++) {
    await page.mouse.wheel(0, step).catch(() => {});
    await sleep(rand(60, 140));
  }
}

module.exports = {
  attachCursor,
  ensureCursor,
  cursorLabel,
  humanMove,
  humanClick,
  humanType,
  humanPaste,
  humanScroll,
};
