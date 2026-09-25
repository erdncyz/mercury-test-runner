// Web lanes share a few Chromium processes instead of starting one per lane. Every case still opens its own
// browser context (cookies, storage and cache are isolated), which costs far less memory than a whole browser.
// A browser holds at most `perBrowser` lanes so one crash only takes those lanes down; idle browsers close.
export const LANES_PER_BROWSER = 6;
export const IDLE_CLOSE_MS = 60_000;

export function createBrowserPool({ launch, perBrowser = LANES_PER_BROWSER, idleMs = IDLE_CLOSE_MS }) {
  const entries = [];

  function drop(entry) {
    entry.dead = true;
    clearTimeout(entry.timer);
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  }

  async function close(entry) {
    drop(entry);
    const browser = entry.browser || await entry.ready.catch(() => null);
    await browser?.close().catch(() => {});
  }

  function open() {
    const entry = { users: 0, timer: null, dead: false, browser: null };
    entry.ready = Promise.resolve().then(launch).then((browser) => {
      entry.browser = browser;
      browser.on?.("disconnected", () => drop(entry));
      return browser;
    });
    entry.ready.catch(() => drop(entry));
    entries.push(entry);
    return entry;
  }

  // Resolves to { browser, release }; `release` is idempotent. Lanes go to the least busy live browser.
  async function acquire() {
    for (;;) {
      const entry = entries.filter((item) => !item.dead && item.users < perBrowser)
        .sort((a, b) => a.users - b.users)[0] || open();
      entry.users += 1;
      clearTimeout(entry.timer);
      entry.timer = null;
      let browser;
      try {
        browser = await entry.ready;
      } catch (error) {
        entry.users -= 1;
        throw error;
      }
      if (entry.dead || browser.isConnected?.() === false) {
        entry.users -= 1;
        drop(entry);
        continue;
      }
      let released = false;
      return {
        browser,
        release() {
          if (released) return;
          released = true;
          entry.users -= 1;
          if (entry.users > 0 || entry.dead) return;
          entry.timer = setTimeout(() => close(entry), idleMs);
          entry.timer.unref?.();
        },
      };
    }
  }

  return {
    acquire,
    closeAll: () => Promise.all([...entries].map(close)),
    stats: () => ({ browsers: entries.length, lanes: entries.reduce((sum, item) => sum + item.users, 0) }),
  };
}
