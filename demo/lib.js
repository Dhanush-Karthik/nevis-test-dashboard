'use strict';

// Small helpers that make the automated browser look like a person driving it: a visible cursor,
// eased mouse movement, typed text, and a caption bar that mirrors the narration.
const CURSOR_CSS = `
#demo-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;pointer-events:none;transform:translate(-4px,-3px);transition:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))}
#demo-cursor svg{display:block}
.demo-ripple{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(255,255,255,.85);pointer-events:none;animation:demo-ripple .5s ease-out forwards}
@keyframes demo-ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
#demo-caption{position:fixed;z-index:2147483645;left:50%;bottom:26px;transform:translateX(-50%);max-width:1080px;padding:11px 20px;border-radius:10px;background:rgba(10,10,12,.88);border:1px solid rgba(255,255,255,.14);color:#f2f2f4;font:500 17px/1.4 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5);opacity:0;transition:opacity .25s ease;pointer-events:none}
#demo-caption.on{opacity:1}
#demo-title{position:fixed;z-index:2147483647;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#0b0b0d;color:#f2f2f4;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;text-align:center;transition:opacity .5s ease}
#demo-title h1{margin:0;font-size:44px;font-weight:650;letter-spacing:-.02em}
#demo-title p{margin:0;font-size:19px;color:#a0a0a8}
#demo-title.off{opacity:0;pointer-events:none}
`;

const INIT_SCRIPT = `(() => {
  const css = ${JSON.stringify(CURSOR_CSS)};
  const boot = () => {
    if (document.getElementById('demo-cursor')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8-6 1.5L8 18z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement('div'); cap.id = 'demo-caption'; document.body.appendChild(cap);
    window.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r); setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHelpers(page) {
  let pos = { x: 700, y: 450 };

  const moveTo = async (x, y, steps = 28) => {
    await page.mouse.move(x, y, { steps });
    pos = { x, y };
  };

  const center = async (loc) => {
    await loc.first().scrollIntoViewIfNeeded({ timeout: 8000 });
    const box = await loc.first().boundingBox();
    if (!box) throw new Error('element has no box');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  };

  const h = {
    page,
    sleep,
    async hover(loc) {
      const c = await center(loc);
      await moveTo(c.x, c.y);
    },
    async click(loc, { pause = 350 } = {}) {
      const c = await center(loc);
      await moveTo(c.x, c.y);
      await sleep(180);
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
      await sleep(pause);
    },
    async type(loc, text, { delay = 55, clear = false } = {}) {
      await h.click(loc, { pause: 150 });
      if (clear) {
        await page.keyboard.press('Meta+A');
        await page.keyboard.press('Backspace');
      }
      await page.keyboard.type(text, { delay });
    },
    async drag(from, to) {
      const a = await center(from);
      const b = await center(to);
      await moveTo(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 30 });
      await sleep(120);
      await page.mouse.up();
      pos = { x: b.x, y: b.y };
      await sleep(300);
    },
    async caption(text) {
      await page.evaluate((t) => {
        const el = document.getElementById('demo-caption');
        if (!el) return;
        if (!t) el.classList.remove('on');
        else { el.textContent = t; el.classList.add('on'); }
      }, text || '');
    },
    async titleCard(title, sub) {
      await page.evaluate(([t, s]) => {
        let el = document.getElementById('demo-title');
        if (!el) { el = document.createElement('div'); el.id = 'demo-title'; document.body.appendChild(el); }
        el.classList.remove('off');
        el.innerHTML = '<h1></h1><p></p>';
        el.querySelector('h1').textContent = t;
        el.querySelector('p').textContent = s;
      }, [title, sub]);
    },
    async hideTitle() {
      await page.evaluate(() => document.getElementById('demo-title')?.classList.add('off'));
    },
  };
  return h;
}

module.exports = { INIT_SCRIPT, makeHelpers, sleep };
