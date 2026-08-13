/**
 * Vercel Edge Function — 單一 catch-all 入口。
 *
 * vercel.json 把 /v1/*、/api/models、/healthz、/health、/debug/* rewrite 到
 * /api/index?__path=<原始路徑>,這裡還原原始路徑後交給共用的 route()。
 *
 * Edge runtime 使用 Web Request/Response API,與 Cloudflare Worker 的 route()
 * 完全相容;env 從 process.env 注入(含可選的 Vercel KV / Upstash REST 轉接器)。
 */
import { route } from "../src/index.js";

export const config = { runtime: "edge" };

/**
 * 可選的 Vercel KV(Upstash REST)轉接器。
 * 沒設 KV_REST_API_URL / KV_REST_API_TOKEN(即未連結 Vercel KV)就回 undefined,
 * 此時 auth.js 走「重用 env refresh token」策略,不需要任何 KV。
 */
function vercelKv(env) {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) return undefined;
  return {
    async get(key) {
      const r = await fetch(`${url}/get/${key}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.result ? String(d.result) : null;
    },
    async put(key, value) {
      await fetch(`${url}/set/${key}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
    },
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  // vercel.json rewrite 帶進來的原始路徑
  const originalPath = url.searchParams.get("__path") || url.pathname;

  // 還原成原始請求 URL(保留 __path 以外的 query 參數,例如 /v1/songs?limit=10)
  const params = new URLSearchParams(url.search);
  params.delete("__path");
  const target = new URL(originalPath, request.url);
  for (const [k, v] of params) target.searchParams.append(k, v);

  const rebuilt = new Request(target.toString(), request);
  const env = { ...process.env, FLOWMUSIC_KV: vercelKv(process.env) };
  const ctx = {
    // Vercel edge 沒有 waitUntil;auth.js 已改為 await KV put,這裡只是兜底
    waitUntil: (p) => {
      p && p.catch && p.catch(() => {});
    },
  };
  return await route(rebuilt, env, ctx);
}
