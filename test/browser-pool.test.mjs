import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBrowserPool } from "../src/browser-pool.mjs";

function fakeLauncher() {
  const browsers = [];
  const launch = async () => {
    const browser = Object.assign(new EventEmitter(), {
      id: browsers.length + 1,
      connected: true,
      closed: false,
      isConnected() { return this.connected; },
      async close() { this.closed = true; this.connected = false; },
      crash() { this.connected = false; this.emit("disconnected"); },
    });
    browsers.push(browser);
    return browser;
  };
  return { launch, browsers };
}

test("web hatları ortak tarayıcıyı paylaşır; tarayıcı başına hat sınırı dolunca yenisi açılır", async () => {
  const { launch, browsers } = fakeLauncher();
  const pool = createBrowserPool({ launch, perBrowser: 2, idleMs: 10_000 });
  const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  assert.equal(browsers.length, 2, "3 hat, tarayıcı başına 2 → 2 tarayıcı");
  assert.deepEqual(leases.map((lease) => lease.browser.id).sort(), [1, 1, 2]);
  assert.deepEqual(pool.stats(), { browsers: 2, lanes: 3 });
  leases[0].release();
  leases[0].release();
  assert.equal(pool.stats().lanes, 2, "release iki kez çağrılsa da bir kez sayılır");
  const next = await pool.acquire();
  assert.equal(browsers.length, 2, "boşalan yere yeni tarayıcı açılmadan girilir");
  for (const lease of [next, leases[1], leases[2]]) lease.release();
  await pool.closeAll();
  assert.ok(browsers.every((browser) => browser.closed));
});

test("çöken tarayıcı havuzdan düşer, sonraki hat yeni tarayıcı alır; boşta kalan tarayıcı kapanır", async () => {
  const { launch, browsers } = fakeLauncher();
  const pool = createBrowserPool({ launch, perBrowser: 4, idleMs: 20 });
  const first = await pool.acquire();
  first.browser.crash();
  const second = await pool.acquire();
  assert.notEqual(second.browser, first.browser);
  first.release();
  second.release();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(browsers[1].closed, true, "boşta kalan tarayıcı kapanır");
  assert.equal(pool.stats().browsers, 0);
});

test("tarayıcı açılamazsa hata hattın kendisine döner ve havuz bozulmaz", async () => {
  let fail = true;
  const { launch: ok } = fakeLauncher();
  const pool = createBrowserPool({ launch: async () => { if (fail) throw new Error("chromium yok"); return ok(); } });
  await assert.rejects(pool.acquire(), /chromium yok/);
  assert.deepEqual(pool.stats(), { browsers: 0, lanes: 0 });
  fail = false;
  const lease = await pool.acquire();
  assert.equal(lease.browser.isConnected(), true);
  lease.release();
  await pool.closeAll();
});
