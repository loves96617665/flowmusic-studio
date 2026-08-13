/**
 * Vercel Edge Function — 單一 catch-all 入口。
 *
 * vercel.json 把 /v1/*、/api/models、/healthz、/health、/debug/* rewrite 到
 * /api/index?__path=<原始路徑>,這裡還原原始路徑後交給共用的 route()。
 *
 * Edge runtime 使用 Web Request/Response API,與 route() 完全相容;
 * env 直接來自 process.env(在 Vercel Dashboard 設定,不需任何 KV)。
 */
import { route } from "../src/index.js";

export const config = { runtime: "edge" };

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
  return await route(rebuilt, { ...process.env }, { waitUntil: () => {} });
}
