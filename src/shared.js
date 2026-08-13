/**
 * 共用工具。
 * 逆向自 flowmusic.app 前端(_app.js module 83229 = uuid v5,namespace b8f9e3a1-...),
 * 伺服器端與客戶端使用同一演算法,已用實際生成結果驗證:
 *   uuid5("[Instrumental]") == 55161754-f78d-5b7f-9fa2-6a3cc8d6ba93
 *   uuid5(擴寫後完整歌詞)   == clip.lyrics.value.id
 */

export const LYRICS_NAMESPACE = "b8f9e3a1-7c2d-4f5e-9a8b-1c3d5e7f9a2b";
export const INSTRUMENTAL = "[Instrumental]";

/** 把 "b8f9e3a1-7c2d-4f5e-9a8b-1c3d5e7f9a2b" 解析成 16 bytes */
export function parseUuidBytes(s) {
  const hex = s.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("Invalid UUID: " + s);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(bytes) {
  const h = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * UUID v5 (SHA-1 name-based),與 flowmusic 前端完全一致:
 *   sha1(namespace_bytes || utf8(name))[0..16],版本 nibble=5, variant=10
 * Worker 環境用 crypto.subtle (SHA-1 可用)。
 */
export async function uuid5(name, namespace = LYRICS_NAMESPACE) {
  const ns = parseUuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const buf = new Uint8Array(16 + nameBytes.length);
  buf.set(ns, 0);
  buf.set(nameBytes, 16);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  const bytes = new Uint8Array(digest.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/**
 * lyricsIdFromLyricsText 的 JS 對應:
 * 空字串 / 純空白 / "[Instrumental]" → ""(純音樂,不帶 lyrics_id)
 */
export async function lyricsIdFromLyricsText(text) {
  if (text === INSTRUMENTAL || text.trim() === "") return "";
  return await uuid5(text);
}

/** 把 lyrics 全文(或空)轉成 tool-call args 的 lyrics_id 並回傳 {lyrics_id, lyrics_id_map} */
export async function buildLyricsPayload(lyrics) {
  const map = {};
  if (lyrics && lyrics.trim() !== "" && lyrics !== INSTRUMENTAL) {
    const id = await uuid5(lyrics);
    map[id] = lyrics;
    return { lyrics_id: id, lyrics_id_map: map };
  }
  return { lyrics_id: "", lyrics_id_map: map };
}

/** 簡易 uuid v4(用於 tool_call_id 等) */
export function uuid4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** SSE 串流解析:逐事件回呼 {event, data(已 JSON.parse 嘗試)} */
export async function parseSSE(response, onEvent) {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = null;
  const dataLines = [];

  function flush() {
    if (event === null) return;
    const payload = dataLines.join("\n");
    let parsed = null;
    try {
      parsed = payload ? JSON.parse(payload) : null;
    } catch {
      parsed = payload;
    }
    onEvent(event, parsed, payload);
    event = null;
    dataLines.length = 0;
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // 正規化 \r\n → \n(上游 SSE 用 CRLF)
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    // SSE 事件以空行分隔
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        // id: / retry: / 註解行忽略
      }
      flush();
    }
  }
  // 尾部殘留
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    flush();
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function jsonError(message, status = 400, type = "invalid_request_error", code = null) {
  return json({ error: { message, type, code } }, status);
}

export function safeParseInt(v, def = null) {
  if (v === null || v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}
