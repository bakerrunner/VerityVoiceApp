const messagesEl = document.querySelector("#messages");
const statusEl = document.querySelector("#status");
const form = document.querySelector("#composer");
const input = document.querySelector("#textInput");
const textToggle = document.querySelector("#textToggle");
const callToggle = document.querySelector("#callToggle");
const callMicButton = document.querySelector("#callMicButton");
const endCallButton = document.querySelector("#endCallButton");
const resetChat = document.querySelector("#resetChat");
const adminDialog = document.querySelector("#adminDialog");
const adminOpen = document.querySelector("#adminOpen");
const saveSettings = document.querySelector("#saveSettings");
const appTitle = document.querySelector("#appTitle");
const chatPanel = document.querySelector("#chatPanel");
const callView = document.querySelector("#callView");
const callAvatar = document.querySelector("#callAvatar");
const callName = document.querySelector("#callName");
const callStatus = document.querySelector("#callStatus");
const userAvatarFile = document.querySelector("#userAvatarFile");
const characterAvatarFile = document.querySelector("#characterAvatarFile");
const userAvatarPreview = document.querySelector("#userAvatarPreview");
const characterAvatarPreview = document.querySelector("#characterAvatarPreview");

let store = null;
let settings = null;
let aborter = null;
let callMode = false;
let handsFreeMic = false;
let handsFreeTimer = null;
let cartesiaStt = null;
let playbackQueue = Promise.resolve();
let currentAudio = null;
let speechRun = 0;
let sentenceBuffer = "";
let speechFlushTimer = null;
let ttsWarningShown = false;
let ttsSocket = null;
let ttsSocketPromise = null;
let ttsToken = "";
let ttsTokenExpiresAt = 0;
let activeTtsContext = "";
let streamingPlayer = null;
let streamingTtsReady = false;
let keepaliveTimer = null;
let keepaliveInFlight = false;
let orbLevel = 0;
let orbTargetLevel = 0;
let orbAnimationFrame = 0;
let pendingUserAvatar = null;
let pendingCharacterAvatar = null;

function setStatus(text) {
  statusEl.textContent = text;
  if (callStatus) callStatus.textContent = text;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function characterName() {
  return settings?.character_profile?.name || "Verity";
}

function userName() {
  return settings?.user_profile?.name || "User";
}

function avatarForRole(role) {
  if (role === "assistant") return settings?.character_profile?.avatar_image || "";
  return settings?.user_profile?.avatar_image || "";
}

function applyAvatar(node, image, fallbackName) {
  if (!node) return;
  if (image) {
    node.style.backgroundImage = `url("${image}")`;
    node.textContent = "";
    node.classList.add("has-image");
  } else {
    node.style.backgroundImage = "";
    node.textContent = initials(fallbackName);
    node.classList.remove("has-image");
  }
}

function updateCallIdentity() {
  const name = characterName();
  callName.textContent = name;
  applyAvatar(callAvatar, avatarForRole("assistant"), name);
}

function updateAdminAvatarPreviews() {
  applyAvatar(userAvatarPreview, pendingUserAvatar ?? settings?.user_profile?.avatar_image, userName());
  applyAvatar(characterAvatarPreview, pendingCharacterAvatar ?? settings?.character_profile?.avatar_image, characterName());
}

function setCallMode(active) {
  callMode = active;
  if (active) updateCallIdentity();
  chatPanel.classList.toggle("call-mode", callMode);
  callView.setAttribute("aria-hidden", String(!callMode));
  textToggle.setAttribute("aria-pressed", String(!callMode));
  callToggle.setAttribute("aria-pressed", String(callMode));
  callToggle.classList.toggle("toggle", callMode);
  textToggle.classList.toggle("toggle", !callMode);
}

function setHandsFreeMic(active) {
  handsFreeMic = active;
  if (!active && handsFreeTimer) {
    clearTimeout(handsFreeTimer);
    handsFreeTimer = null;
  }
}

function micIsListening() {
  return Boolean(cartesiaStt);
}

function shouldResumeHandsFree(runId) {
  return handsFreeMic
    && runId === speechRun
    && !aborter
    && !micIsListening()
    && !currentAudio
    && !activeTtsContext
    && !chatPanel.classList.contains("is-speaking");
}

function scheduleHandsFreeListening(runId, delay = 650) {
  if (!handsFreeMic) return;
  if (handsFreeTimer) clearTimeout(handsFreeTimer);
  handsFreeTimer = setTimeout(() => {
    handsFreeTimer = null;
    if (shouldResumeHandsFree(runId)) startVoiceInput({ handsFree: true });
  }, delay);
}

function setOrbAudioLevel(level) {
  orbTargetLevel = Math.max(0, Math.min(1, level));
  if (!orbAnimationFrame) animateOrbLevel();
}

function animateOrbLevel() {
  orbLevel += (orbTargetLevel - orbLevel) * 0.34;
  orbTargetLevel *= 0.88;
  if (orbLevel < 0.01 && orbTargetLevel < 0.01) {
    orbLevel = 0;
    orbTargetLevel = 0;
    orbAnimationFrame = 0;
    chatPanel.style.setProperty("--orb-level", "0");
    return;
  }
  chatPanel.style.setProperty("--orb-level", orbLevel.toFixed(3));
  orbAnimationFrame = requestAnimationFrame(animateOrbLevel);
}

function audioLevelFromFloat32(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, Math.max(rms * 7.5, peak * 1.4));
}

function render() {
  const messages = store?.messages || [];
  messagesEl.innerHTML = "";
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Verity is ready. Start with text, or click Call and then Mic.";
    messagesEl.append(empty);
    return;
  }
  for (const message of messages) messagesEl.append(renderMessage(message));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(message) {
  const node = document.createElement("article");
  node.className = `message-row ${message.role}`;
  node.dataset.id = message.id || "";

  const stack = document.createElement("div");
  stack.className = "message-stack";
  const meta = document.createElement("span");
  meta.className = "message-label";
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  const displayName = message.role === "assistant" ? characterName() : userName();
  applyAvatar(avatar, avatarForRole(message.role), displayName);
  const label = document.createElement("span");
  label.textContent = displayName.toUpperCase();
  meta.append(avatar, label);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = formatForDisplay(message.content || "");

  stack.append(meta, bubble);
  node.append(stack);
  return node;
}

function formatForDisplay(text) {
  return String(text || "")
    .replace(/<break\s+time=["'][^"']+["']\s*\/>/gi, " ")
    .replace(/<emotion\s+value=["'][^"']+["']\s*\/>/gi, "")
    .replace(/\[laughter\]/gi, "laughs")
    .trim();
}

function appendMessage(role, content, mode = "text") {
  const message = {
    id: crypto.randomUUID(),
    role,
    content,
    mode,
    created_at: Date.now(),
  };
  store.messages.push(message);
  return message;
}

function updateMessage(id, content) {
  const message = store.messages.find((item) => item.id === id);
  if (message) message.content = content;
  const node = messagesEl.querySelector(`[data-id="${id}"] .message-bubble`);
  if (node) node.textContent = formatForDisplay(content);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadState() {
  const res = await fetch("/api/state");
  const data = await res.json();
  store = data.store;
  settings = data.settings;
  appTitle.textContent = settings.app_title || "VerityVoice";
  document.title = settings.app_title || "VerityVoice";
  input.placeholder = `Talk to ${characterName()}...`;
  input.setAttribute("aria-label", `Message ${characterName()}`);
  fillAdmin();
  updateCallIdentity();
  render();
  setStatus(settings.cartesia_api_key ? "Ready" : "Ready - add a Cartesia key in Admin for voice");
  if (settings.cartesia_api_key) warmCartesiaSocket();
  startLmStudioKeepalive();
}

function fillAdmin() {
  const user = settings.user_profile || {};
  const character = settings.character_profile || {};
  pendingUserAvatar = null;
  pendingCharacterAvatar = null;
  if (userAvatarFile) userAvatarFile.value = "";
  if (characterAvatarFile) characterAvatarFile.value = "";
  document.querySelector("#userName").value = user.name || "";
  document.querySelector("#userGender").value = user.gender || "";
  document.querySelector("#userBirthdate").value = user.birthdate || "";
  document.querySelector("#userLocation").value = user.location || "";
  document.querySelector("#userBio").value = user.bio || "";
  document.querySelector("#userSystemNotes").value = user.system_notes || "";

  document.querySelector("#characterName").value = character.name || "";
  document.querySelector("#characterGender").value = character.gender || "";
  document.querySelector("#characterAge").value = character.age || "";
  document.querySelector("#characterBio").value = character.bio || "";
  document.querySelector("#characterSystemPrompt").value = character.system_prompt || settings.system_prompt || "";
  document.querySelector("#characterSystemNotes").value = character.system_notes || "";
  document.querySelector("#characterMemories").value = Array.isArray(character.memories) ? character.memories.join("\n") : "";

  document.querySelector("#llmProvider").value = settings.llm_provider || "lmstudio";
  document.querySelector("#lmUrl").value = settings.lmstudio_base_url || "";
  document.querySelector("#lmModel").value = settings.lmstudio_model || "";
  document.querySelector("#openrouterChatModel").value = settings.openrouter_chat_model || "";
  document.querySelector("#openrouterBaseUrl").value = settings.openrouter_base_url || "https://openrouter.ai/api/v1";
  document.querySelector("#temperature").value = settings.temperature ?? 0.8;
  document.querySelector("#lmKeepaliveEnabled").checked = settings.lmstudio_keepalive_enabled !== false;
  document.querySelector("#lmKeepaliveInterval").value = settings.lmstudio_keepalive_interval || 120;
  document.querySelector("#cartesiaKey").value = "";
  document.querySelector("#cartesiaVoice").value = settings.cartesia_voice_id || "";
  document.querySelector("#cartesiaModel").value = settings.cartesia_model_id || "";
  document.querySelector("#cartesiaSttModel").value = settings.cartesia_stt_model || "ink-2";
  document.querySelector("#fullHistory").checked = Boolean(settings.send_full_history);
  document.querySelector("#maxMessages").value = settings.max_context_messages || 80;
  document.querySelector("#fastVoiceContext").checked = settings.fast_voice_context !== false;
  document.querySelector("#voiceMessages").value = settings.voice_context_messages || 40;
  document.querySelector("#carryoverTurns").value = settings.carryover_turns ?? 6;
  updateAdminAvatarPreviews();
}

function adminPayload() {
  const key = document.querySelector("#cartesiaKey").value.trim();
  const openrouterKey = document.querySelector("#openrouterKey").value.trim();
  const currentUser = settings.user_profile || {};
  const currentCharacter = settings.character_profile || {};
  const payload = {
    app_title: "VerityVoice",
    user_profile: {
      ...currentUser,
      name: document.querySelector("#userName").value.trim(),
      gender: document.querySelector("#userGender").value.trim(),
      birthdate: document.querySelector("#userBirthdate").value,
      location: document.querySelector("#userLocation").value.trim(),
      bio: document.querySelector("#userBio").value.trim(),
      system_notes: document.querySelector("#userSystemNotes").value.trim(),
      avatar_image: pendingUserAvatar ?? currentUser.avatar_image ?? "",
    },
    character_profile: {
      ...currentCharacter,
      name: document.querySelector("#characterName").value.trim(),
      gender: document.querySelector("#characterGender").value.trim(),
      age: document.querySelector("#characterAge").value.trim(),
      bio: document.querySelector("#characterBio").value.trim(),
      system_prompt: document.querySelector("#characterSystemPrompt").value.trim(),
      system_notes: document.querySelector("#characterSystemNotes").value.trim(),
      memories: linesFromTextarea("#characterMemories"),
      avatar_image: pendingCharacterAvatar ?? currentCharacter.avatar_image ?? "",
    },
    llm_provider: document.querySelector("#llmProvider").value,
    lmstudio_base_url: document.querySelector("#lmUrl").value.trim(),
    lmstudio_model: document.querySelector("#lmModel").value.trim(),
    openrouter_chat_model: document.querySelector("#openrouterChatModel").value.trim(),
    openrouter_base_url: document.querySelector("#openrouterBaseUrl").value.trim(),
    temperature: Number(document.querySelector("#temperature").value),
    lmstudio_keepalive_enabled: document.querySelector("#lmKeepaliveEnabled").checked,
    lmstudio_keepalive_interval: Number(document.querySelector("#lmKeepaliveInterval").value),
    cartesia_voice_id: document.querySelector("#cartesiaVoice").value.trim(),
    cartesia_model_id: document.querySelector("#cartesiaModel").value.trim(),
    cartesia_stt_model: document.querySelector("#cartesiaSttModel").value.trim(),
    send_full_history: document.querySelector("#fullHistory").checked,
    max_context_messages: Number(document.querySelector("#maxMessages").value),
    fast_voice_context: document.querySelector("#fastVoiceContext").checked,
    voice_context_messages: Number(document.querySelector("#voiceMessages").value),
    carryover_turns: Number(document.querySelector("#carryoverTurns").value),
  };
  if (key) payload.cartesia_api_key = key;
  if (openrouterKey) payload.openrouter_api_key = openrouterKey;
  return payload;
}

function linesFromTextarea(selector) {
  return document.querySelector(selector).value.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function saveAdmin() {
  setStatus("Saving settings...");
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(adminPayload()),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  settings = data.settings;
  fillAdmin();
  updateCallIdentity();
  render();
  startLmStudioKeepalive();
  setStatus("Settings saved");
}

function startLmStudioKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if ((settings?.llm_provider || "lmstudio") !== "lmstudio") return;
  if (!settings?.lmstudio_keepalive_enabled) return;
  const seconds = Math.max(30, Number(settings.lmstudio_keepalive_interval || 120));
  keepaliveTimer = setInterval(() => pingLmStudio(), seconds * 1000);
}

async function pingLmStudio() {
  if (keepaliveInFlight || aborter || (document.hidden && !handsFreeMic)) return;
  keepaliveInFlight = true;
  try {
    await fetch("/api/lmstudio-keepalive", { method: "POST" });
  } catch {
    // Keepalive failures should not interrupt chat.
  } finally {
    keepaliveInFlight = false;
  }
}

async function sendMessage(text, mode = "text") {
  const message = text.trim();
  if (!message || aborter) return;

  aborter = new AbortController();
  resetSpeechState();
  speechRun += 1;
  ttsWarningShown = false;
  const runId = speechRun;
  const shouldSpeak = mode === "voice" && Boolean(settings.cartesia_api_key);
  appendMessage("user", message, mode);
  const assistant = appendMessage("assistant", "", shouldSpeak ? "voice" : "text");
  render();
  input.value = "";
  setBusy(true);
  const name = characterName();
  setStatus(shouldSpeak ? `${name} is replying with voice...` : `${name} is replying...`);
  if (shouldSpeak) startStreamingSpeech(runId);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, mode, speak: shouldSpeak }),
      signal: aborter.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Chat failed with ${res.status}`);
    }

    let assistantText = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "delta") {
          assistantText += event.text;
          updateMessage(assistant.id, assistantText);
          if (shouldSpeak) queueSpeech(sanitizeSpeechText(event.text), runId, false);
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }
    }
    if (shouldSpeak) flushSpeech(runId);
    setStatus("Ready");
  } catch (error) {
    if (error.name !== "AbortError") {
      updateMessage(assistant.id, `${assistant.content || ""}\n\n[${error.message}]`.trim());
      setStatus("Error");
    } else {
      setStatus("Stopped");
    }
  } finally {
    setBusy(false);
    aborter = null;
  }
  if (!shouldSpeak) scheduleHandsFreeListening(runId);
}

function setBusy(busy) {
  form.querySelector("#sendButton").disabled = busy;
  callMicButton.disabled = busy && !callMicButton.classList.contains("is-listening");
  resetChat.disabled = busy;
}

function sanitizeSpeechText(text) {
  return String(text || "")
    .replace(/<\|end\|>|<end>|<eos>|<\/s>/gi, "")
    .replace(/\[\[.*?\]\]/g, " ");
}

function setMicActive(active) {
  callMicButton.classList.toggle("is-listening", active);
  callMicButton.setAttribute("aria-pressed", String(active));
  callMicButton.textContent = active ? "Listening" : (handsFreeMic ? "Hands-free" : "Mic");
  chatPanel.classList.toggle("is-listening", active);
  if (!active && !chatPanel.classList.contains("is-speaking")) setOrbAudioLevel(0);
}

function stopCurrentSpeech() {
  speechRun += 1;
  if (streamingPlayer) streamingPlayer.stop();
  if (activeTtsContext && ttsSocket?.readyState === WebSocket.OPEN) {
    ttsSocket.send(JSON.stringify({ context_id: activeTtsContext, cancel: true }));
  }
  resetSpeechState();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  chatPanel.classList.remove("is-speaking");
  setOrbAudioLevel(0);
}

function stopListening() {
  setHandsFreeMic(false);
  stopCartesiaStt(false);
  setMicActive(false);
}

function resetSpeechState() {
  sentenceBuffer = "";
  if (speechFlushTimer) {
    clearTimeout(speechFlushTimer);
    speechFlushTimer = null;
  }
  activeTtsContext = "";
  streamingPlayer = null;
  streamingTtsReady = false;
}

function revealVoiceTranscript() {
  chatPanel.classList.add("is-speaking");
}

function queueSpeech(delta, runId, force) {
  sentenceBuffer += delta;
  const chunk = takeSpeechChunk(force);
  if (chunk) speakChunk(chunk, runId, false);

  if (speechFlushTimer) clearTimeout(speechFlushTimer);
  speechFlushTimer = setTimeout(() => {
    const delayed = takeSpeechChunk(true);
    if (delayed) speakChunk(delayed, runId, false);
  }, 420);
}

function takeSpeechChunk(force) {
  const text = sentenceBuffer.trimStart();
  if (!text) {
    sentenceBuffer = "";
    return "";
  }
  const strong = text.match(/^(.+?[.!?])(\s+|$)/s);
  if (strong && strong[1].trim().length >= 8) {
    sentenceBuffer = text.slice(strong[0].length);
    return strong[1].trim();
  }
  if (text.length >= 46) {
    const maxCut = Math.min(text.length, 92);
    const boundary = Math.max(
      text.lastIndexOf(",", maxCut),
      text.lastIndexOf(";", maxCut),
      text.lastIndexOf(":", maxCut),
      text.lastIndexOf(" ", maxCut),
    );
    if (boundary >= 30) {
      const cut = boundary + 1;
      sentenceBuffer = text.slice(cut);
      return text.slice(0, cut).trim();
    }
  }
  if (force && text.length >= 32) {
    const boundary = Math.max(
      text.lastIndexOf(","),
      text.lastIndexOf(";"),
      text.lastIndexOf(":"),
      text.lastIndexOf(" "),
    );
    if (boundary >= 18) {
      const cut = boundary + 1;
      sentenceBuffer = text.slice(cut);
      return text.slice(0, cut).trim();
    }
  }
  if (force && /[.!?]$/.test(text)) {
    sentenceBuffer = "";
    return text.trim();
  }
  return "";
}

function flushSpeech(runId) {
  if (speechFlushTimer) {
    clearTimeout(speechFlushTimer);
    speechFlushTimer = null;
  }
  const rest = sentenceBuffer.trim();
  sentenceBuffer = "";
  if (rest) speakChunk(rest, runId, true);
  else finishStreamingSpeech(runId);
}

function speakChunk(text, runId, final) {
  text = sanitizeSpeechText(text);
  if (streamingTtsReady || activeTtsContext) {
    streamSpeechChunk(text, runId, final).catch((error) => {
      reportTtsError(error);
      enqueueSpeech(text, runId);
    });
    return;
  }
  enqueueSpeech(text, runId);
}

function finishStreamingSpeech(runId) {
  if (!activeTtsContext) return;
  streamSpeechChunk("", runId, true).catch(reportTtsError);
}

function enqueueSpeech(text, runId) {
  const audioPromise = fetchSpeech(text, runId);
  playbackQueue = playbackQueue.then(() => playSpeech(audioPromise, runId)).catch(reportTtsError);
}

function reportTtsError(error) {
  if (ttsWarningShown) return;
  ttsWarningShown = true;
  setStatus(error.message || "Voice playback failed");
}

async function warmCartesiaSocket() {
  try {
    await ensureCartesiaSocket();
  } catch {
    ttsSocketPromise = null;
  }
}

async function startStreamingSpeech(runId) {
  if (runId !== speechRun) return;
  activeTtsContext = crypto.randomUUID();
  streamingPlayer = new PcmStreamPlayer(24000, revealVoiceTranscript, () => scheduleHandsFreeListening(runId));
  try {
    await ensureCartesiaSocket();
    streamingTtsReady = true;
  } catch (error) {
    streamingTtsReady = false;
    activeTtsContext = "";
    reportTtsError(error);
  }
}

async function ensureCartesiaSocket() {
  if (ttsSocket?.readyState === WebSocket.OPEN) return ttsSocket;
  if (ttsSocketPromise) return ttsSocketPromise;
  ttsSocketPromise = openCartesiaSocket();
  return ttsSocketPromise;
}

async function openCartesiaSocket() {
  const token = await getCartesiaToken();
  const url = new URL("wss://api.cartesia.ai/tts/websocket");
  url.searchParams.set("cartesia_version", settings.cartesia_version || "2026-03-01");
  url.searchParams.set("access_token", token);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => {
      ttsSocket = socket;
      resolve(socket);
    };
    socket.onerror = () => reject(new Error("Cartesia streaming voice connection failed"));
    socket.onclose = () => {
      if (ttsSocket === socket) ttsSocket = null;
      ttsSocketPromise = null;
      streamingTtsReady = false;
    };
    socket.onmessage = (event) => handleCartesiaMessage(event);
  });
}

async function getCartesiaToken() {
  if (ttsToken && Date.now() < ttsTokenExpiresAt - 10_000) return ttsToken;
  const res = await fetch("/api/cartesia-token", { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "Could not get Cartesia voice token");
  ttsToken = data.token;
  ttsTokenExpiresAt = Date.now() + Number(data.expires_in || 300) * 1000;
  return ttsToken;
}

async function streamSpeechChunk(text, runId, final) {
  if (runId !== speechRun || !activeTtsContext) return;
  const socket = await ensureCartesiaSocket();
  if (runId !== speechRun || !activeTtsContext) return;
  if (socket.readyState !== WebSocket.OPEN) throw new Error("Cartesia streaming voice is not open");
  socket.send(JSON.stringify({
    model_id: settings.cartesia_model_id || "sonic-3.5",
    transcript: final ? text : (/\s$/.test(text) ? text : `${text} `),
    voice: { mode: "id", id: settings.cartesia_voice_id },
    language: "en",
    context_id: activeTtsContext,
    output_format: {
      container: "raw",
      encoding: "pcm_s16le",
      sample_rate: 24000,
    },
    add_timestamps: false,
    continue: !final,
  }));
}

function handleCartesiaMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === "error") {
    reportTtsError(new Error(message.message || "Cartesia streaming voice failed"));
    return;
  }
  if (message.context_id !== activeTtsContext) return;
  if (message.type === "chunk" && message.data && streamingPlayer) streamingPlayer.playBase64(message.data);
  if (message.done) {
    activeTtsContext = "";
    if (streamingPlayer && !streamingPlayer.sources.size) scheduleHandsFreeListening(speechRun);
  }
}

class PcmStreamPlayer {
  constructor(sampleRate, onFirstAudio, onIdle) {
    this.sampleRate = sampleRate;
    this.onFirstAudio = onFirstAudio;
    this.onIdle = onIdle;
    this.audioContext = null;
    this.analyser = null;
    this.meterData = null;
    this.meterFrame = 0;
    this.nextStartTime = 0;
    this.started = false;
    this.sources = new Set();
  }

  ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.meterData = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.audioContext.destination);
      this.nextStartTime = this.audioContext.currentTime + 0.16;
    }
    this.audioContext.resume?.();
  }

  playBase64(base64) {
    this.ensureContext();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const samples = new Float32Array(bytes.length / 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;

    const buffer = this.audioContext.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.analyser);

    const startAt = Math.max(this.audioContext.currentTime + 0.05, this.nextStartTime);
    if (!this.started) {
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(1, startAt + 0.06);
    }
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size) {
        chatPanel.classList.remove("is-speaking");
        this.stopMeter();
        setOrbAudioLevel(0);
        if (!activeTtsContext) this.onIdle?.();
      }
    };
    this.startMeter();
    if (!this.started) {
      this.started = true;
      this.onFirstAudio?.();
    }
  }

  startMeter() {
    if (this.meterFrame || !this.analyser || !this.meterData) return;
    const tick = () => {
      if (!this.sources.size || !this.analyser || !this.meterData) {
        this.meterFrame = 0;
        return;
      }
      this.analyser.getFloatTimeDomainData(this.meterData);
      setOrbAudioLevel(audioLevelFromFloat32(this.meterData));
      this.meterFrame = requestAnimationFrame(tick);
    };
    this.meterFrame = requestAnimationFrame(tick);
  }

  stopMeter() {
    if (this.meterFrame) cancelAnimationFrame(this.meterFrame);
    this.meterFrame = 0;
  }

  stop() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.stopMeter();
    chatPanel.classList.remove("is-speaking");
    setOrbAudioLevel(0);
  }
}

async function fetchSpeech(text, runId) {
  if (runId !== speechRun) return;
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "TTS failed");
  }
  if (runId !== speechRun) return;
  return res.blob();
}

async function playSpeech(audioPromise, runId) {
  const blob = await audioPromise;
  if (!blob || runId !== speechRun) return;
  const url = URL.createObjectURL(blob);
  await playUrl(url, runId);
  URL.revokeObjectURL(url);
}

function playUrl(url, runId) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null;
      scheduleHandsFreeListening(runId);
      resolve();
    };
    audio.onerror = () => {
      if (currentAudio === audio) currentAudio = null;
      scheduleHandsFreeListening(runId);
      resolve();
    };
    audio.onplaying = revealVoiceTranscript;
    if (runId !== speechRun) {
      resolve();
      return;
    }
    audio.play().catch(resolve);
  });
}

async function startCartesiaStt() {
  if (cartesiaStt) return;
  if (!settings.cartesia_api_key) {
    setStatus("Add a Cartesia key in Admin for voice chat");
    return;
  }

  setMicActive(true);
  setStatus("Connecting mic...");
  stopCurrentSpeech();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(2048, 1, 1);
  source.connect(processor);
  processor.connect(audioContext.destination);

  const token = await getCartesiaToken();
  const url = new URL("wss://api.cartesia.ai/stt/turns/websocket");
  url.searchParams.set("model", settings.cartesia_stt_model || "ink-2");
  url.searchParams.set("encoding", "pcm_f32le");
  url.searchParams.set("sample_rate", String(audioContext.sampleRate));
  url.searchParams.set("cartesia_version", settings.cartesia_version || "2026-03-01");
  url.searchParams.set("access_token", token);

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  cartesiaStt = { socket, stream, audioContext, source, processor, ending: false };

  socket.onopen = () => setStatus("Listening...");
  socket.onerror = () => {
    setStatus("Mic error");
    stopCartesiaStt(false);
  };
  socket.onclose = () => stopCartesiaStt(false);
  socket.onmessage = (event) => handleCartesiaSttMessage(event);

  processor.onaudioprocess = (event) => {
    if (!cartesiaStt || socket.readyState !== WebSocket.OPEN) return;
    const inputBuffer = event.inputBuffer.getChannelData(0);
    setOrbAudioLevel(audioLevelFromFloat32(inputBuffer));
    socket.send(inputBuffer.slice().buffer);
  };
}

function handleCartesiaSttMessage(event) {
  if (!cartesiaStt) return;
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message.type === "connected" || message.type === "turn.resume") {
    setStatus("Listening...");
    return;
  }
  if (message.type === "turn.start") {
    stopCurrentSpeech();
    setMicActive(true);
    setStatus("Listening...");
    return;
  }
  if (message.type === "turn.update" || message.type === "turn.eager_end") {
    if (message.transcript) input.value = message.transcript;
    setStatus(message.type === "turn.eager_end" ? "Almost ready..." : "Listening...");
    return;
  }
  if (message.type === "turn.end") {
    const transcript = String(message.transcript || input.value || "").trim();
    cartesiaStt.ending = true;
    stopCartesiaStt(false);
    if (transcript) sendMessage(transcript, "voice");
    else scheduleHandsFreeListening(speechRun, 350);
    return;
  }
  if (message.type === "error") {
    setStatus(message.message || "Mic error");
    stopCartesiaStt(false);
  }
}

function stopCartesiaStt(sendClose) {
  if (!cartesiaStt) {
    setMicActive(false);
    return;
  }
  const state = cartesiaStt;
  cartesiaStt = null;
  processorDisconnect(state.processor);
  processorDisconnect(state.source);
  state.stream.getTracks().forEach((track) => track.stop());
  state.audioContext.close?.();
  if (sendClose && state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: "close" }));
  else if (state.socket.readyState === WebSocket.OPEN) state.socket.close();
  setMicActive(false);
  if (!state.ending) setStatus("Ready");
}

function processorDisconnect(node) {
  try {
    node.disconnect();
  } catch {}
}

function startVoiceInput(options = {}) {
  if (!settings) return;
  if (options.handsFree || callMode) setHandsFreeMic(true);
  if (aborter || micIsListening()) return;
  startCartesiaStt().catch((error) => {
    setStatus(error.message || "Mic unavailable");
    stopCartesiaStt(false);
  });
}

function readAvatarFile(file, onLoaded) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("Choose an image file for the avatar");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => onLoaded(String(reader.result || ""));
  reader.onerror = () => setStatus("Could not read avatar image");
  reader.readAsDataURL(file);
}

function stopInteraction() {
  if (aborter) aborter.abort();
  stopListening();
  stopCurrentSpeech();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(input.value, "text");
});

textToggle.addEventListener("click", () => setCallMode(false));
callToggle.addEventListener("click", () => setCallMode(true));
callMicButton.addEventListener("click", () => {
  if (handsFreeMic) {
    setStatus(micIsListening() ? "Listening..." : "Voice chat is active");
    return;
  }
  startVoiceInput({ handsFree: true });
});
endCallButton.addEventListener("click", () => {
  stopListening();
  stopCurrentSpeech();
  setStatus("Ready");
});

resetChat.addEventListener("click", async () => {
  if (!confirm("Start a new chat? VerityVoice will summarize this session and save memories first.")) return;
  setStatus("Saving memories...");
  const res = await fetch("/api/reset", { method: "POST" });
  const data = await res.json();
  if (data.error) {
    setStatus(data.error);
    return;
  }
  store = data.store;
  settings = data.settings || settings;
  fillAdmin();
  updateCallIdentity();
  render();
  setStatus("New chat ready");
});

adminOpen.addEventListener("click", () => adminDialog.showModal());
saveSettings.addEventListener("click", () => saveAdmin().catch((error) => setStatus(error.message)));

userAvatarFile.addEventListener("change", () => {
  readAvatarFile(userAvatarFile.files?.[0], (image) => {
    pendingUserAvatar = image;
    updateAdminAvatarPreviews();
  });
});

characterAvatarFile.addEventListener("change", () => {
  readAvatarFile(characterAvatarFile.files?.[0], (image) => {
    pendingCharacterAvatar = image;
    updateAdminAvatarPreviews();
  });
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === tab.dataset.tab));
  });
});

loadState().catch((error) => setStatus(error.message));
