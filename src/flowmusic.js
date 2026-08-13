/**
 * flowmusic.app 上游封裝。
 * 協定逆向自前端 _app.js + 實測:
 *   - 所有請求走 https://www.flowmusic.app/__api/*(Next.js rewrite 代理到後端)
 *   - POST /conversation        {conversation_id, parts, client_context, model_name:"producer:standard", mode:"standard"} → {job_id}
 *   - POST /producer/tool-call  {conversation_id, part, client_context} → {job_id}
 *   - POST /recipes/create      {recipe:{nodes,instruction}} → {recipe_id}
 *   - GET  /messages/{job}/stream?last_id=0  SSE: begin / conversation_id / part / complete / generated-title / suggestion / final
 *   - POST /clips {"clip_ids":[...]} → {"clips":{id:{...}}}
 *
 * 工具調用回傳格式(實測):
 *   audio__create_song → {status, operation_id, clip_id, clip_id_b?, a_b_test_id?, estimated_time}
 *   audio__render_edit → {status, operation_id, clip_outputs:[{node_id, clip_id, title}], estimated_time}
 *   audio__split_stems → {status, stems:[{stem_type:"vocals"|"drums"|"bass"|"other", clip_id}]}
 */

// ── recipe 節點(module 34663 對應)─────────────────────────────────────────────
const N_INPUT = "input";
const N_PROCESSING = "processing";
const N_OUTPUT = "output";

function inputNode(clipId) {
  return { node_type: "Input", clip_id: clipId, input_ids: [], output_ids: [N_INPUT] };
}
function outputNode(title, generateImage = true) {
  return { node_type: "Output", input_ids: [N_PROCESSING], output_ids: [N_OUTPUT], title, generate_image: generateImage };
}

/** extend recipe:{nodes,instruction} */
export function buildExtendRecipe({ clipId, instruction, extend_s, extend_from_s, seed, title, generateImage = true }) {
  const section = {
    node_type: "ExtendSection",
    input_ids: [N_INPUT],
    output_ids: [N_PROCESSING],
    instruction,
    extend_s,
    extend_from_s: extend_from_s ?? null,
    seed: seed ?? null,
  };
  return {
    nodes: [inputNode(clipId), section, outputNode(title, generateImage)],
    instruction: instruction || null,
  };
}

/** replace recipe(剪輯區段) */
export function buildReplaceRecipe({ clipId, instruction, masks, seed, title, generateImage = true }) {
  const section = {
    node_type: "ReplaceSection",
    input_ids: [N_INPUT],
    output_ids: [N_PROCESSING],
    instruction,
    masks,
    seed: seed ?? null,
  };
  return {
    nodes: [inputNode(clipId), section, outputNode(title, generateImage)],
    instruction: instruction || null,
  };
}

/** cover recipe(翻唱;strength 預設 0.5,官方預設) */
export function buildCoverRecipe({ clipId, instruction, strength, seed, title, generateImage = true }) {
  const section = {
    node_type: "CoverSong",
    input_ids: [N_INPUT],
    output_ids: [N_PROCESSING],
    instruction,
    strength: strength ?? 0.5,
    seed: seed ?? null,
  };
  return {
    nodes: [inputNode(clipId), section, outputNode(title, generateImage)],
    instruction: instruction || null,
  };
}

// ── 基礎請求 ───────────────────────────────────────────────────────────────────
export async function apiFetch(env, ctx, upstreamHeaders, path, options = {}) {
  const headers = await upstreamHeaders(env, ctx, options.headers || {});
  const url = (env.FLOWMUSIC_BASE_URL || "https://www.flowmusic.app/__api") + path;
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    let detail = "";
    try {
      const j = await resp.clone().json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j).slice(0, 300);
    } catch {
      detail = (await resp.text().catch(() => "")).slice(0, 300);
    }
    const err = new Error(`flowmusic upstream ${resp.status}: ${detail}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

export async function apiJson(env, ctx, upstreamHeaders, path, options = {}) {
  const resp = await apiFetch(env, ctx, upstreamHeaders, path, options);
  return await resp.json();
}

/** 建立 conversation,回傳 conversation_id */
export async function createConversation(env, ctx, upstreamHeaders, projectId = null) {
  const data = await apiJson(env, ctx, upstreamHeaders, "/conversation/create", {
    method: "POST",
    body: JSON.stringify({ project_id: projectId }),
  });
  return data.conversation_id;
}

export async function deleteConversation(env, ctx, upstreamHeaders, conversationId) {
  try {
    await apiJson(env, ctx, upstreamHeaders, `/conversations/${conversationId}`, {
      method: "DELETE",
      body: "{}",
    });
  } catch {
    /* 忽略清理失敗 */
  }
}

/** 建立 recipe,回傳 recipe_id */
export async function createRecipe(env, ctx, upstreamHeaders, recipe) {
  const data = await apiJson(env, ctx, upstreamHeaders, "/recipes/create", {
    method: "POST",
    body: JSON.stringify({ recipe }),
  });
  return data.recipe_id;
}

function defaultClientContext(model, lyricsMap = {}, extra = {}) {
  return {
    current_song_id: null,
    song_queue: [],
    project_id: null,
    selected_model: model,
    lyrics_id_map: lyricsMap,
    ghostwriter_version: "standard",
    ...extra,
  };
}

/**
 * 聊天流程:POST /conversation 並讀完整個 SSE。
 * 回傳 { texts, toolCalls, toolReturns, clipIds, title, suggestions }
 */
export async function runChatStream(env, ctx, upstreamHeaders, conversationId, userText, model, lyricsMap = {}) {
  const resp = await apiFetch(env, ctx, upstreamHeaders, "/conversation", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: conversationId,
      parts: [{ content: userText, part_kind: "user-prompt" }],
      client_context: defaultClientContext(model, lyricsMap),
      model_name: "producer:standard",
      mode: "standard",
    }),
  });
  const { job_id } = await resp.json();

  const result = { texts: [], toolCalls: [], toolReturns: [], clipIds: [], title: null, suggestions: [] };
  const seenToolCalls = new Set();
  const seenClipIds = new Set();
  const streamResp = await apiFetch(env, ctx, upstreamHeaders, `/messages/${job_id}/stream?last_id=0`);
  if (!streamResp.ok) throw new Error("stream failed: " + streamResp.status);

  const { parseSSE } = await import("./shared.js");
  await parseSSE(streamResp, (event, data) => {
    if (event === "part" && data && data.part) {
      const part = data.part;
      const kind = part.part_kind;
      if (kind === "text" && data.status === "delta" && part.delta) {
        if (result.texts.length === 0) result.texts.push("");
        result.texts[result.texts.length - 1] += part.delta;
      } else if (kind === "text" && data.status === "final" && part.content) {
        result.texts.push(part.content);
      } else if (kind === "tool-call" && data.status === "final") {
        if (!seenToolCalls.has(part.tool_call_id)) {
          seenToolCalls.add(part.tool_call_id);
          result.toolCalls.push(part);
        }
      } else if (kind === "tool-return" && data.status === "final") {
        result.toolReturns.push(part);
        collectToolReturnClipIds(part.content, seenClipIds, result.clipIds);
      }
    } else if (event === "generated-title" && data && data.title) {
      result.title = data.title;
    } else if (event === "suggestion" && data && Array.isArray(data.parts)) {
      result.suggestions.push(data);
    }
  });
  return result;
}

/** 從 tool-return content 收集 clip ids(相容 create_song / render_edit / split_stems) */
function collectToolReturnClipIds(content, seen, out) {
  if (!content || typeof content !== "object") return;
  const push = (cid) => {
    if (cid && !seen.has(cid)) {
      seen.add(cid);
      out.push(cid);
    }
  };
  if (content.clip_id) push(content.clip_id);
  if (content.clip_id_b) push(content.clip_id_b);
  if (Array.isArray(content.clip_outputs)) {
    for (const o of content.clip_outputs) push(o && o.clip_id);
  }
  if (Array.isArray(content.stems)) {
    for (const s of content.stems) push(s && s.clip_id);
  }
}

/**
 * 通用工具調用:POST /producer/tool-call + SSE。
 * part = {tool_name, args, tool_call_id, part_kind:"tool-call"}
 * 回傳 { toolReturns, clipIds, stems }
 */
export async function runToolCall(env, ctx, upstreamHeaders, conversationId, part, model, lyricsMap = {}) {
  const resp = await apiFetch(env, ctx, upstreamHeaders, "/producer/tool-call", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: conversationId,
      part,
      client_context: defaultClientContext(model, lyricsMap),
    }),
  });
  const { job_id } = await resp.json();

  const result = { toolReturns: [], clipIds: [], stems: [] };
  const seenClipIds = new Set();
  const streamResp = await apiFetch(env, ctx, upstreamHeaders, `/messages/${job_id}/stream?last_id=0`);
  const { parseSSE } = await import("./shared.js");
  await parseSSE(streamResp, (event, data) => {
    if (event === "message" && data && Array.isArray(data.parts)) {
      for (const p of data.parts) {
        if (p.part_kind === "tool-return") {
          result.toolReturns.push(p);
          const content = p.content;
          if (content && typeof content === "object") {
            collectToolReturnClipIds(content, seenClipIds, result.clipIds);
            if (Array.isArray(content.stems)) result.stems.push(...content.stems);
          }
        }
      }
    }
  });
  return result;
}

function makeToolCallId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 直接生成(audio__create_song),回傳 clip ids */
export async function runCreateSongTool(env, ctx, upstreamHeaders, conversationId, args, model, lyricsMap = {}) {
  const result = await runToolCall(env, ctx, upstreamHeaders, conversationId, {
    tool_name: "audio__create_song",
    args,
    tool_call_id: makeToolCallId(),
    part_kind: "tool-call",
  }, model, lyricsMap);
  return result.clipIds;
}

/** render edit(extend/replace/cover):建立 recipe → audio__render_edit,回傳 clip ids */
export async function runRenderEditTool(env, ctx, upstreamHeaders, conversationId, recipe, title, model, lyricsMap = {}) {
  const recipeId = await createRecipe(env, ctx, upstreamHeaders, recipe);
  const args = { recipe_id: recipeId, title };
  const result = await runToolCall(env, ctx, upstreamHeaders, conversationId, {
    tool_name: "audio__render_edit",
    args,
    tool_call_id: makeToolCallId(),
    part_kind: "tool-call",
  }, model, lyricsMap);
  return result.clipIds;
}

/** stem split(audio__split_stems),回傳 [{stem_type, clip_id}] */
export async function runSplitStemsTool(env, ctx, upstreamHeaders, conversationId, clipId, model, lyricsMap = {}) {
  const result = await runToolCall(env, ctx, upstreamHeaders, conversationId, {
    tool_name: "audio__split_stems",
    args: { clip_id: clipId },
    tool_call_id: makeToolCallId(),
    part_kind: "tool-call",
  }, model, lyricsMap);
  return result.stems;
}

/** POST /clips {clip_ids:[...]} 抓 clip 詳情 */
export async function fetchClips(env, ctx, upstreamHeaders, clipIds) {
  const data = await apiJson(env, ctx, upstreamHeaders, "/clips", {
    method: "POST",
    body: JSON.stringify({ clip_ids: clipIds }),
  });
  return data.clips || {};
}

/** 把 clip 物件整理成乾淨的公開欄位 */
export function sanitizeClip(clip) {
  if (!clip) return null;
  let duration = null;
  if (clip.duration && clip.duration.status === "completed") duration = Number(clip.duration.value) || null;
  let lyrics = null;
  if (clip.lyrics && clip.lyrics.status === "completed" && clip.lyrics.value) {
    lyrics = {
      id: clip.lyrics.value.id || null,
      text: clip.lyrics.value.text || null,
    };
  }
  return {
    id: clip.id,
    title: clip.title,
    op_type: clip.op_type,
    duration,
    lyrics,
    audio_url: clip.audio_url || null,
    wav_url: clip.wav_url || null,
    image_url: clip.image_url || null,
    video_url: clip.video_url || null,
    privacy: clip.privacy,
    is_favorite: !!clip.is_favorite,
    favorite_count: clip.favorite_count,
    play_count: clip.play_count,
    created_at: clip.created_at,
  };
}
