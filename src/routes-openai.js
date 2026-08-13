/**
 * OpenAI 相容層。
 *   GET  /v1/models                → OpenAI model 列表
 *   POST /v1/chat/completions      → Producer 聊天代理(回傳 agent 文字 + 生成歌曲)
 *   POST /v1/music/generations     → 直接生成歌曲(OpenAI images/generations 風格;支援 bpm / duration)
 *   POST /v1/music/edits           → 編輯/重混:extend / replace / cover(audio__render_edit)
 *   POST /v1/music/stems           → 分軌(audio__split_stems)
 *   GET  /v1/songs                 → 帳號歌曲列表
 *   GET  /v1/songs/:id             → 單曲詳情
 *
 * 認證:Authorization: Bearer <API Key>(API_KEYS env)
 */

import { json, jsonError, safeParseInt, uuid4 } from "./shared.js";
import {
  buildCoverRecipe,
  buildExtendRecipe,
  buildReplaceRecipe,
  createConversation,
  deleteConversation,
  fetchClips,
  runChatStream,
  runCreateSongTool,
  runRenderEditTool,
  runSplitStemsTool,
  sanitizeClip,
} from "./flowmusic.js";

const DEFAULT_MODEL = "Lyria 3.5";

/** 把各種模型別名對映到 flowmusic public_name */
export function normalizeModel(model) {
  if (!model) return DEFAULT_MODEL;
  const m = String(model).toLowerCase().trim();
  const map = {
    "lyria-3.5": "Lyria 3.5",
    "lyria_3_5": "Lyria 3.5",
    "lyria3.5": "Lyria 3.5",
    "lyria 3.5": "Lyria 3.5",
    "g1": "Lyria 3.5",
    "lyria-3-pro": "Lyria 3 Pro",
    "lyria_3_pro": "Lyria 3 Pro",
    "lyria3pro": "Lyria 3 Pro",
    "lyria 3 pro": "Lyria 3 Pro",
  };
  return map[m] || m.replace(/-/g, " ").replace(/_/g, " ") || DEFAULT_MODEL;
}

function oaiModel(model) {
  return { id: model, object: "model", created: 0, owned_by: "flowmusic" };
}

/**
 * 複刻官方 _constructCreateArgs 的 bpm / 長度注入:
 *   - bpm       → sound_prompt 尾綴 ", {bpm} bpm"
 *   - duration  → lyrics 尾綴 "[End - mm:ss]"(instrumental 時從 "[Instrumental]" 起算)
 * 回傳 { sound_prompt, lyrics, instrumental }
 */
export function applyBpmDuration({ prompt, lyrics, instrumental, bpm, duration }) {
  let soundPrompt = prompt;
  if (bpm) soundPrompt = soundPrompt ? `${soundPrompt}, ${bpm} bpm` : `${bpm} bpm`;

  let text = instrumental ? "[Instrumental]" : lyrics || "";
  if (duration && duration > 0) {
    const m = Math.floor(duration / 60);
    const s = Math.floor(duration % 60);
    const tag = `[End - ${m}:${String(s).padStart(2, "0")}]`;
    text = text ? `${text}\n${tag}` : tag;
  }
  return { sound_prompt: soundPrompt, lyrics: text, instrumental };
}

/** GET /v1/models — 實時拉上游,快取 5 分鐘 */
export async function handleModels(env, ctx, upstreamHeaders) {
  const resp = await fetch(
    (env.FLOWMUSIC_BASE_URL || "https://www.flowmusic.app/__api") + "/models",
    { headers: await upstreamHeaders(env) }
  );
  if (!resp.ok) return jsonError("Upstream models failed: " + resp.status, 502, "upstream_error");
  const data = await resp.json();
  const models = (data.models || []).map((m) => oaiModel(m.public_name));
  return json({ object: "list", data: models });
}

/** POST /v1/chat/completions */
export async function handleChatCompletions(env, ctx, upstreamHeaders, body) {
  const model = normalizeModel(body.model);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userText = messages
    .filter((m) => m && m.role === "user" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n")
    .trim();
  const systemText = messages
    .filter((m) => m && m.role === "system" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n")
    .trim();
  if (!userText) return jsonError("No user message provided", 400, "invalid_request_error", "missing_message");

  const prompt = systemText ? `${systemText}\n\n${userText}` : userText;

  let conversationId = null;
  try {
    conversationId = await createConversation(env, ctx, upstreamHeaders);
    const stream = await runChatStream(env, ctx, upstreamHeaders, conversationId, prompt, model);

    const clips = stream.clipIds.length ? await fetchClips(env, ctx, upstreamHeaders, stream.clipIds) : {};
    const songs = stream.clipIds.map((id) => sanitizeClip(clips[id])).filter(Boolean);

    const content = stream.texts.join("\n").trim() || "Done.";

    const toolCalls = stream.toolCalls
      .filter((tc) => tc.tool_name && tc.tool_name !== "synthetic__suggest_actions")
      .map((tc) => ({
        id: tc.tool_call_id || uuid4(),
        type: "function",
        function: { name: tc.tool_name, arguments: JSON.stringify(tc.args || {}) },
      }));

    return json({
      id: "chatcmpl-" + uuid4(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      songs,
      conversation_title: stream.title,
    });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return jsonError("flowmusic auth failed: " + e.message, 502, "upstream_auth_error");
    }
    return jsonError("Chat failed: " + e.message, 502, "upstream_error");
  } finally {
    if (conversationId) await deleteConversation(env, ctx, upstreamHeaders, conversationId);
  }
}

/** 把 clip list 轉成 generations 回應的 data 格式 */
function songsToData(songs) {
  return songs.map((s) => ({
    id: s.id,
    title: s.title,
    url: s.audio_url,
    wav_url: s.wav_url,
    image_url: s.image_url,
    duration: s.duration,
    lyrics: s.lyrics ? s.lyrics.text : null,
    created_at: s.created_at,
  }));
}

/** POST /v1/music/generations — 直接生成(對映 OpenAI images/generations 風格) */
export async function handleMusicGenerations(env, ctx, upstreamHeaders, body) {
  const model = normalizeModel(body.model);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return jsonError("prompt is required", 400, "invalid_request_error", "missing_prompt");

  const rawLyrics = typeof body.lyrics === "string" ? body.lyrics : null;
  const instrumental = !!body.instrumental || rawLyrics === "[Instrumental]";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
  const seed = safeParseInt(body.seed, null);
  const n = safeParseInt(body.n, 2);
  const count = Math.min(Math.max(n || 2, 1), 4);
  const bpm = safeParseInt(body.bpm, null);
  const duration = safeParseInt(body.duration, null); // 秒

  // bpm / 長度注入(官方邏輯)
  const { sound_prompt, lyrics } = applyBpmDuration({
    prompt,
    lyrics: rawLyrics || "",
    instrumental,
    bpm,
    duration,
  });

  const { buildLyricsPayload } = await import("./shared.js");
  const { lyrics_id, lyrics_id_map } = await buildLyricsPayload(lyrics);

  const args = { sound_prompt, title, seed };
  if (lyrics_id) args.lyrics_id = lyrics_id;

  let conversationId = null;
  try {
    conversationId = await createConversation(env, ctx, upstreamHeaders);
    const clipIds = [];
    for (let i = 0; i < count; i++) {
      const ids = await runCreateSongTool(env, ctx, upstreamHeaders, conversationId, args, model, lyrics_id_map);
      clipIds.push(...ids);
    }
    const clips = clipIds.length ? await fetchClips(env, ctx, upstreamHeaders, clipIds) : {};
    const songs = clipIds.map((id) => sanitizeClip(clips[id])).filter(Boolean);

    return json({
      created: Math.floor(Date.now() / 1000),
      model,
      data: songsToData(songs),
    });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return jsonError("flowmusic auth failed: " + e.message, 502, "upstream_auth_error");
    }
    return jsonError("Generation failed: " + e.message, 502, "upstream_error");
  } finally {
    if (conversationId) await deleteConversation(env, ctx, upstreamHeaders, conversationId);
  }
}

/**
 * POST /v1/music/edits — extend / replace / cover(audio__render_edit)
 * body:
 *   { model?, mode:"extend"|"replace"|"cover", clip_id, instruction, title?,
 *     extend_s?, extend_from_s?, masks?:[{start_s,end_s}], strength?, seed?, bpm?, duration? }
 */
export async function handleMusicEdits(env, ctx, upstreamHeaders, body) {
  const model = normalizeModel(body.model);
  const mode = String(body.mode || "").toLowerCase();
  const clipId = String(body.clip_id || "").trim();
  const instruction = String(body.instruction || "").trim();
  if (!clipId) return jsonError("clip_id is required", 400, "invalid_request_error", "missing_clip_id");
  if (!["extend", "replace", "cover"].includes(mode)) {
    return jsonError("mode must be extend | replace | cover", 400, "invalid_request_error", "invalid_mode");
  }
  if (!instruction) return jsonError("instruction is required", 400, "invalid_request_error", "missing_instruction");

  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
  const seed = safeParseInt(body.seed, null);
  const bpm = safeParseInt(body.bpm, null);
  const duration = safeParseInt(body.duration, null);

  let soundInstruction = instruction;
  if (bpm) soundInstruction = `${soundInstruction}, ${bpm} bpm`;
  if (duration) soundInstruction = `${soundInstruction}, [End - ${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}]`;

  let recipe;
  if (mode === "extend") {
    recipe = buildExtendRecipe({
      clipId,
      instruction: soundInstruction,
      extend_s: safeParseInt(body.extend_s, 30),
      extend_from_s: safeParseInt(body.extend_from_s, null),
      seed,
      title,
    });
  } else if (mode === "replace") {
    const masks = Array.isArray(body.masks)
      ? body.masks
      : [{ start_s: safeParseInt(body.start_s, 0), end_s: safeParseInt(body.end_s, 30) }];
    recipe = buildReplaceRecipe({ clipId, instruction: soundInstruction, masks, seed, title });
  } else {
    recipe = buildCoverRecipe({
      clipId,
      instruction: soundInstruction,
      strength: body.strength != null ? Number(body.strength) : 0.5,
      seed,
      title,
    });
  }

  let conversationId = null;
  try {
    conversationId = await createConversation(env, ctx, upstreamHeaders);
    const clipIds = await runRenderEditTool(env, ctx, upstreamHeaders, conversationId, recipe, title || "Untitled Edit", model);
    const clips = clipIds.length ? await fetchClips(env, ctx, upstreamHeaders, clipIds) : {};
    const songs = clipIds.map((id) => sanitizeClip(clips[id])).filter(Boolean);
    return json({
      created: Math.floor(Date.now() / 1000),
      model,
      mode,
      data: songsToData(songs),
    });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return jsonError("flowmusic auth failed: " + e.message, 502, "upstream_auth_error");
    }
    return jsonError("Edit failed: " + e.message, 502, "upstream_error");
  } finally {
    if (conversationId) await deleteConversation(env, ctx, upstreamHeaders, conversationId);
  }
}

/** POST /v1/music/stems — 分軌(audio__split_stems) */
export async function handleMusicStems(env, ctx, upstreamHeaders, body) {
  const model = normalizeModel(body.model);
  const clipId = String(body.clip_id || "").trim();
  if (!clipId) return jsonError("clip_id is required", 400, "invalid_request_error", "missing_clip_id");

  let conversationId = null;
  try {
    conversationId = await createConversation(env, ctx, upstreamHeaders);
    const stems = await runSplitStemsTool(env, ctx, upstreamHeaders, conversationId, clipId, model);
    const ids = stems.map((s) => s.clip_id).filter(Boolean);
    const clips = ids.length ? await fetchClips(env, ctx, upstreamHeaders, ids) : {};
    return json({
      created: Math.floor(Date.now() / 1000),
      model,
      data: stems.map((s) => ({
        stem_type: s.stem_type,
        id: s.clip_id,
        title: s.title || null,
        url: clips[s.clip_id] ? clips[s.clip_id].audio_url : null,
        wav_url: clips[s.clip_id] ? clips[s.clip_id].wav_url : null,
      })),
    });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return jsonError("flowmusic auth failed: " + e.message, 502, "upstream_auth_error");
    }
    return jsonError("Stem split failed: " + e.message, 502, "upstream_error");
  } finally {
    if (conversationId) await deleteConversation(env, ctx, upstreamHeaders, conversationId);
  }
}

/** GET /v1/songs / GET /v1/songs/:id */
export async function handleSongs(env, ctx, upstreamHeaders, url) {
  const match = url.pathname.match(/^\/v1\/songs\/([^/]+)\/?$/);
  const id = match ? decodeURIComponent(match[1]) : null;
  if (id) {
    const clips = await fetchClips(env, ctx, upstreamHeaders, [id]);
    const clip = sanitizeClip(clips[id]);
    if (!clip) return jsonError("Song not found", 404, "not_found");
    return json(clip);
  }
  const resp = await fetch(
    (env.FLOWMUSIC_BASE_URL || "https://www.flowmusic.app/__api") + "/clips/auth-user?page=0&page_size=50",
    { headers: await upstreamHeaders(env) }
  );
  if (!resp.ok) return jsonError("Upstream clips failed: " + resp.status, 502, "upstream_error");
  const data = await resp.json();
  return json({ object: "list", data: (data.clips || []).map(sanitizeClip).filter(Boolean) });
}
