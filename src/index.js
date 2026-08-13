/**
 * Flow Music Studio — 共用路由核心(Cloudflare Worker 與 Vercel Edge 共用)
 * Google Flow Music (Lyria) 音樂生成閘道:OpenAI 相容 API + API Key 驗證。
 *
 * 協定逆向來源:
 *   - 前端 _app.js 的 API client、ChatSession、Producer 工具 schema
 *   - 實測:POST /conversation、POST /producer/tool-call、SSE /messages/{job}/stream
 */

import { json, jsonError } from "./shared.js";
import { checkApiKey, upstreamHeaders } from "./auth.js";
import {
  handleModels,
  handleChatCompletions,
  handleMusicGenerations,
  handleMusicEdits,
  handleMusicStems,
  handleSongs,
} from "./routes-openai.js";

function readJsonBody(request) {
  return request.json().catch(() => null);
}

/**
 * 共用的路由核心:同時被 Cloudflare Worker(export default)與 Vercel Edge Function(api/index.js)呼叫。
 */
export async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 健康檢查(不需 API key)
  if (path === "/healthz" || path === "/health") {
    return json({ ok: true, service: "flowmusic-studio" });
  }

  // 全部 API 都需要 API Key
  if (!path.startsWith("/v1/") && path !== "/api/models") {
    // 非 API 路徑 → 交給靜態資源(UI);CF 有 ASSETS binding,Vercel 由平台處理靜態
    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(request);
    return jsonError("Not found", 404, "not_found", "not_found");
  }
    const auth = checkApiKey(request, env);
    if (!auth.ok) {
      if (auth.reason === "not_configured") {
        return jsonError(
          "Server not configured: API_KEYS is empty. Set API_KEYS in the Vercel dashboard (Settings → Environment Variables).",
          503,
          "not_configured",
          "api_keys_not_configured"
        );
      }
      if (auth.reason === "missing_header") {
        return jsonError(
          "Missing API key. Set Authorization: Bearer <key>.",
          401,
          "invalid_api_key",
          "missing_api_key"
        );
      }
      return jsonError(
        "Invalid API key. Set Authorization: Bearer <key>.",
        401,
        "invalid_api_key",
        "invalid_api_key"
      );
    }

    try {
      // 唯讀診斷:不洩漏 token,只回傳狀態(方便遠端定位上游認證問題)
      if (request.method === "GET" && path === "/debug/auth") {
        return json({
          env_refresh_present: !!env.FLOWMUSIC_REFRESH_TOKEN,
          env_access_present: !!env.FLOWMUSIC_ACCESS_TOKEN,
        });
      }
      if (request.method === "GET" && (path === "/v1/models" || path === "/api/models")) {
        return await handleModels(env, ctx, upstreamHeaders);
      }
      if (request.method === "POST" && path === "/v1/chat/completions") {
        const body = await readJsonBody(request);
        if (!body) return jsonError("Invalid JSON body", 400, "invalid_request_error", "invalid_json");
        return await handleChatCompletions(env, ctx, upstreamHeaders, body);
      }
      if (request.method === "POST" && path === "/v1/music/generations") {
        const body = await readJsonBody(request);
        if (!body) return jsonError("Invalid JSON body", 400, "invalid_request_error", "invalid_json");
        return await handleMusicGenerations(env, ctx, upstreamHeaders, body);
      }
      if (request.method === "POST" && path === "/v1/music/edits") {
        const body = await readJsonBody(request);
        if (!body) return jsonError("Invalid JSON body", 400, "invalid_request_error", "invalid_json");
        return await handleMusicEdits(env, ctx, upstreamHeaders, body);
      }
      if (request.method === "POST" && path === "/v1/music/stems") {
        const body = await readJsonBody(request);
        if (!body) return jsonError("Invalid JSON body", 400, "invalid_request_error", "invalid_json");
        return await handleMusicStems(env, ctx, upstreamHeaders, body);
      }
      if (request.method === "GET" && path.startsWith("/v1/songs")) {
        return await handleSongs(env, ctx, upstreamHeaders, url);
      }
      return jsonError(`Route not found: ${request.method} ${path}`, 404, "not_found", "route_not_found");
    } catch (e) {
      console.error("route error", e);
      return jsonError("Internal error: " + e.message, 500, "server_error");
    }
}

// Cloudflare Worker 入口(若仍想部署到 CF)
export default {
  fetch: route,
};
