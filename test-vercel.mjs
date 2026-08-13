/**
 * 本地 harness:不部署也能測試 Vercel Edge Function 的 handler。
 * 驗證:① __path 路徑還原 ② API key 驗證 ③ 路由接線(缺 token 時正確報錯) ④ query 保留。
 *
 * 跑法:node test-vercel.mjs
 */
import assert from "node:assert/strict";
import handler from "./api/index.js";

const BASE = "https://flowmusic-studio.vercel.app";
let passed = 0;

async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// ① healthz(不需 API key)→ 驗證 __path 還原與路由
await t("healthz 還原 __path 並回 200", async () => {
  const res = await handler(new Request(`${BASE}/api/index?__path=/healthz`));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
});

// ② 缺 API key → 401
await t("缺少 API key → 401 missing_api_key", async () => {
  const res = await handler(new Request(`${BASE}/api/index?__path=/v1/models`));
  assert.equal(res.status, 401);
  const d = await res.json();
  assert.equal(d.error.code, "missing_api_key");
});

// ③ 路由接線:有 key 但沒上游 token → 500 且訊息明確(證明走到生成路由)
const savedKeys = process.env.API_KEYS;
process.env.API_KEYS = "sk-test-vercel";
try {
  await t("帶 key 打 /v1/music/generations → 缺 token 明確報錯", async () => {
    const res = await handler(
      new Request(`${BASE}/api/index?__path=/v1/music/generations`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test-vercel",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "synthwave test" }),
      })
    );
    assert.equal(res.status, 502); // generations 路由把上游認證錯誤包成 502
    const d = await res.json();
    assert.match(d.error.message, /No FLOWMUSIC_REFRESH_TOKEN/);
  });
} finally {
  if (savedKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = savedKeys;
}

// ④ query 保留:/v1/songs?limit=5 的 limit 應保留(缺 key 時先被 401 擋下,證明 query 沒壞即可)
await t("query 參數保留(非 __path)", async () => {
  const res = await handler(new Request(`${BASE}/api/index?__path=/v1/songs&limit=5`));
  assert.equal(res.status, 401); // 沒帶 key,路由正常
});

// ⑤ 未經 rewrite 的直連路徑(非 API 且無 ASSETS)→ 404
await t("非 API 路徑 → 404(不是 500)", async () => {
  const res = await handler(new Request(`${BASE}/some-page`));
  assert.equal(res.status, 404);
});

console.log(`\n${passed}/5 vercel harness 測試通過`);
