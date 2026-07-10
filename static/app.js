const messagesEl = document.querySelector("#messages");
const statusEl = document.querySelector("#status");
const form = document.querySelector("#composer");
const input = document.querySelector("#textInput");
const textToggle = document.querySelector("#textToggle");
const callToggle = document.querySelector("#callToggle");
const callMicButton = document.querySelector("#callMicButton");
const endCallButton = document.querySelector("#endCallButton");
const attachButton = document.querySelector("#attachButton");
const imageButton = document.querySelector("#imageButton");
const fileInput = document.querySelector("#fileInput");
const attachmentTray = document.querySelector("#attachmentTray");
const resetChat = document.querySelector("#resetChat");
const adminDialog = document.querySelector("#adminDialog");
const adminOpen = document.querySelector("#adminOpen");
const saveSettings = document.querySelector("#saveSettings");
const importButton = document.querySelector("#importButton");
const loadImageModels = document.querySelector("#loadImageModels");
const appTitle = document.querySelector("#appTitle");
const chatPanel = document.querySelector("#chatPanel");
const callView = document.querySelector("#callView");
const callAvatar = document.querySelector("#callAvatar");
const callName = document.querySelector("#callName");
const callStatus = document.querySelector("#callStatus");
const imageDialog = document.querySelector("#imageDialog");
const imageDialogImg = document.querySelector("#imageDialogImg");
const imageViewerPrompt = document.querySelector("#imageViewerPrompt");
const imageViewerPromptText = document.querySelector("#imageViewerPromptText");
const imageDownload = document.querySelector("#imageDownload");
const imageClose = document.querySelector("#imageClose");
const imageProgress = document.querySelector("#imageProgress");
const imageProgressLabel = document.querySelector("#imageProgressLabel");
const imageProgressPercent = document.querySelector("#imageProgressPercent");
const imageProgressBar = document.querySelector("#imageProgressBar");
const imagePromptDialog = document.querySelector("#imagePromptDialog");
const imagePromptText = document.querySelector("#imagePromptText");
const imagePromptClose = document.querySelector("#imagePromptClose");
const imagePromptGenerate = document.querySelector("#imagePromptGenerate");
const imageReferenceAdd = document.querySelector("#imageReferenceAdd");
const imageReferenceInput = document.querySelector("#imageReferenceInput");
const imageReferenceTray = document.querySelector("#imageReferenceTray");
const imagePreviewPanel = document.querySelector("#imagePreviewPanel");
const imagePreviewImg = document.querySelector("#imagePreviewImg");
const imagePreviewDownload = document.querySelector("#imagePreviewDownload");
const imagePreviewDelete = document.querySelector("#imagePreviewDelete");
const imagePreviewPost = document.querySelector("#imagePreviewPost");
const imageDialogProgress = document.querySelector("#imageDialogProgress");
const imageDialogProgressLabel = document.querySelector("#imageDialogProgressLabel");
const imageDialogProgressPercent = document.querySelector("#imageDialogProgressPercent");
const imageDialogProgressBar = document.querySelector("#imageDialogProgressBar");

let store = null;
let settings = null;
let voiceOn = true;
let aborter = null;
let recognition = null;
let suppressRecognitionEnd = false;
let browserRecognitionActive = false;
let playbackQueue = Promise.resolve();
let sentenceBuffer = "";
let currentAudio = null;
let speechRun = 0;
let ttsWarningShown = false;
let speechFlushTimer = null;
let voiceHasStarted = false;
let pendingAssistantText = "";
let activeAssistantId = "";
let speechSanitizer = createSpeechSanitizer();
let ttsSocket = null;
let ttsSocketPromise = null;
let ttsToken = "";
let ttsTokenExpiresAt = 0;
let activeTtsContext = "";
let streamingPlayer = null;
let streamingTtsReady = false;
let cartesiaStt = null;
let keepaliveTimer = null;
let keepaliveInFlight = false;
let pendingAttachments = [];
let orbLevel = 0;
let orbTargetLevel = 0;
let orbAnimationFrame = 0;
let imageProgressTimer = null;
let imageProgressValue = 0;
let imageDialogProgressTimer = null;
let imageDialogProgressValue = 0;
let imageDialogReferences = [];
let includeCharacterReference = true;
let includeUserReference = true;
let pendingGeneratedImage = null;
let imagePosting = false;
let callMode = false;
let handsFreeMic = false;
let handsFreeTimer = null;
const pauseBreakTag = '<break time="350ms"/>';
const automaticSelfieUserTurnCooldown = 10;

function setStatus(text) {
  statusEl.textContent = text;
  if (callStatus) callStatus.textContent = text;
}

function updateCallIdentity() {
  const character = settings?.character_profile || {};
  const name = character.name || "Maya";
  callName.textContent = name;
  if (character.avatar) {
    callAvatar.style.backgroundImage = `url(${character.avatar})`;
    callAvatar.textContent = "";
  } else {
    callAvatar.style.backgroundImage = "";
    callAvatar.textContent = initials(name);
  }
}

function setCallMode(active) {
  callMode = active;
  if (active) {
    voiceOn = true;
  }
  chatPanel.classList.toggle("call-mode", callMode);
  callView.setAttribute("aria-hidden", String(!callMode));
  textToggle.setAttribute("aria-pressed", String(!callMode));
  callToggle.setAttribute("aria-pressed", String(callMode));
  callToggle.classList.toggle("toggle", callMode);
  textToggle.classList.toggle("toggle", !callMode);
  if (active) {
    updateCallIdentity();
  }
}

function setHandsFreeMic(active) {
  handsFreeMic = active;
  if (!active && handsFreeTimer) {
    clearTimeout(handsFreeTimer);
    handsFreeTimer = null;
  }
}

function micIsListening() {
  return Boolean(cartesiaStt || browserRecognitionActive);
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

function latestVisibleMessage() {
  const messages = store?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.content) return message;
  }
  return null;
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
    empty.textContent = "Maya is ready. Start with text, or use the mic if your browser supports speech recognition.";
    messagesEl.append(empty);
    return;
  }
  for (const message of messages) {
    messagesEl.append(renderMessage(message));
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(message) {
  const node = document.createElement("article");
  node.className = `message-row ${message.role}`;
  node.dataset.id = message.id || "";

  const meta = document.createElement("span");
  meta.className = "message-label";
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  const profile = message.role === "assistant" ? settings?.character_profile : settings?.user_profile;
  const image = message.role === "assistant" ? profile?.avatar : profile?.photo;
  if (image) {
    avatar.style.backgroundImage = `url(${image})`;
  } else {
    avatar.textContent = initials(profile?.name || (message.role === "assistant" ? "Maya" : "User"));
  }
  const label = document.createElement("span");
  label.textContent = message.role === "assistant"
    ? (settings?.character_profile?.name || "Maya").toUpperCase()
    : (settings?.user_profile?.name || "User").toUpperCase();
  meta.append(avatar, label);

  const stack = document.createElement("div");
  stack.className = "message-stack";
  stack.append(meta);
  const displayText = formatForDisplay(message.content || "");
  if (displayText || message.role === "assistant") {
    const text = document.createElement("div");
    text.className = `message-bubble${message.mode === "image" && displayText === "Posting image" ? " is-posting" : ""}`;
    text.textContent = displayText;
    if (message.mode === "image" && displayText === "Posting image") {
      const dots = document.createElement("span");
      dots.className = "thought-dots";
      dots.setAttribute("aria-hidden", "true");
      dots.innerHTML = "<i></i><i></i><i></i>";
      text.append(" ", dots);
    }
    stack.append(text);
  }
  const renderedAttachments = renderAttachments(message.attachments || [], message);
  if (renderedAttachments) stack.append(renderedAttachments);
  if (message.role === "assistant") {
    const actions = document.createElement("nav");
    actions.className = "message-actions";
    actions.setAttribute("aria-label", "Message actions");
    const selfie = document.createElement("button");
    selfie.type = "button";
    selfie.textContent = "Request selfie";
    selfie.addEventListener("click", () => requestSelfieFromMessage(message));
    actions.append(selfie);
    stack.append(actions);
  }
  node.append(stack);
  return node;
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
  messagesEl.append(renderMessage(message));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return message;
}

function replaceMessage(localId, serverMessage) {
  const index = store.messages.findIndex((item) => item.id === localId);
  if (index >= 0) {
    store.messages[index] = serverMessage;
  } else {
    store.messages.push(serverMessage);
  }
  const node = messagesEl.querySelector(`[data-id="${localId}"]`);
  if (node) node.replaceWith(renderMessage(serverMessage));
  else messagesEl.append(renderMessage(serverMessage));
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  input.placeholder = `Talk to ${settings.character_profile?.name || "Maya"}...`;
  input.setAttribute("aria-label", `Message ${settings.character_profile?.name || "Maya"}`);
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
  document.querySelector("#userPhotoPreview").style.backgroundImage = user.photo ? `url(${user.photo})` : "";
  document.querySelector("#userPhotoPreview").src = user.photo || "";
  document.querySelector("#userName").value = user.name || "";
  document.querySelector("#userGender").value = user.gender || "";
  document.querySelector("#userBirthdate").value = user.birthdate || "";
  document.querySelector("#userLocation").value = user.location || "";
  document.querySelector("#userBio").value = user.bio || "";
  document.querySelector("#userSystemNotes").value = user.system_notes || "";

  document.querySelector("#characterAvatarPreview").style.backgroundImage = character.avatar ? `url(${character.avatar})` : "";
  document.querySelector("#characterAvatarPreview").src = character.avatar || "";
  document.querySelector("#characterName").value = character.name || "";
  document.querySelector("#characterGender").value = character.gender || "";
  document.querySelector("#characterAge").value = character.age || "";
  document.querySelector("#characterBio").value = character.bio || "";
  document.querySelector("#characterSystemPrompt").value = character.system_prompt || settings.system_prompt || "";
  document.querySelector("#characterSystemNotes").value = character.system_notes || "";
  document.querySelector("#characterMemories").value = Array.isArray(character.memories) ? character.memories.join("\n") : "";

  document.querySelector("#lmUrl").value = settings.lmstudio_base_url || "";
  document.querySelector("#lmModel").value = settings.lmstudio_model || "";
  document.querySelector("#temperature").value = settings.temperature ?? 0.8;
  document.querySelector("#lmKeepaliveEnabled").checked = settings.lmstudio_keepalive_enabled !== false;
  document.querySelector("#lmKeepaliveInterval").value = settings.lmstudio_keepalive_interval || 120;
  document.querySelector("#cartesiaKey").value = "";
  document.querySelector("#cartesiaVoice").value = settings.cartesia_voice_id || "";
  document.querySelector("#cartesiaModel").value = settings.cartesia_model_id || "";
  document.querySelector("#cartesiaSttEnabled").checked = settings.use_cartesia_stt !== false;
  document.querySelector("#cartesiaSttModel").value = settings.cartesia_stt_model || "ink-2";
  document.querySelector("#imageProvider").value = settings.image_provider || "openrouter";
  document.querySelector("#openrouterKey").value = "";
  document.querySelector("#openrouterImageModel").value = settings.openrouter_image_model || "";
  document.querySelector("#openrouterImageAspect").value = settings.openrouter_image_aspect_ratio || "1:1";
  document.querySelector("#openrouterImageResolution").value = settings.openrouter_image_resolution || "";
  document.querySelector("#openrouterImageQuality").value = settings.openrouter_image_quality || "medium";
  document.querySelector("#openrouterImageFormat").value = settings.openrouter_image_output_format || "png";
  document.querySelector("#openrouterUseCharacterReference").checked = settings.openrouter_use_character_reference !== false;
  document.querySelector("#fullHistory").checked = Boolean(settings.send_full_history);
  document.querySelector("#maxMessages").value = settings.max_context_messages || 80;
  document.querySelector("#fastVoiceContext").checked = settings.fast_voice_context !== false;
  document.querySelector("#voiceMessages").value = settings.voice_context_messages || 40;
  document.querySelector("#carryoverTurns").value = settings.carryover_turns ?? 6;
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
    },
    lmstudio_base_url: document.querySelector("#lmUrl").value.trim(),
    lmstudio_model: document.querySelector("#lmModel").value.trim(),
    temperature: Number(document.querySelector("#temperature").value),
    lmstudio_keepalive_enabled: document.querySelector("#lmKeepaliveEnabled").checked,
    lmstudio_keepalive_interval: Number(document.querySelector("#lmKeepaliveInterval").value),
    cartesia_voice_id: document.querySelector("#cartesiaVoice").value.trim(),
    cartesia_model_id: document.querySelector("#cartesiaModel").value.trim(),
    use_cartesia_stt: document.querySelector("#cartesiaSttEnabled").checked,
    cartesia_stt_model: document.querySelector("#cartesiaSttModel").value.trim(),
    image_provider: document.querySelector("#imageProvider").value,
    openrouter_image_model: document.querySelector("#openrouterImageModel").value.trim(),
    openrouter_image_aspect_ratio: document.querySelector("#openrouterImageAspect").value.trim(),
    openrouter_image_resolution: document.querySelector("#openrouterImageResolution").value.trim(),
    openrouter_image_quality: document.querySelector("#openrouterImageQuality").value,
    openrouter_image_output_format: document.querySelector("#openrouterImageFormat").value,
    openrouter_use_character_reference: document.querySelector("#openrouterUseCharacterReference").checked,
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

function initials(name) {
  return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
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
  if ((!message && !pendingAttachments.length) || aborter) return;
  const outgoingAttachments = pendingAttachments;
  pendingAttachments = [];
  renderAttachmentTray();

  aborter = new AbortController();
  resetSpeechState();
  speechRun += 1;
  ttsWarningShown = false;
  voiceHasStarted = false;
  pendingAssistantText = "";
  speechSanitizer = createSpeechSanitizer();
  const runId = speechRun;
  const shouldSpeak = voiceOn && Boolean(settings.cartesia_api_key);
  appendMessage("user", message || "[Attachment]", mode).attachments = outgoingAttachments;
  render();
  const assistant = appendMessage("assistant", "", shouldSpeak ? "voice" : "text");
  activeAssistantId = assistant.id;
  input.value = "";
  setBusy(true);
  setStatus(voiceOn && !settings.cartesia_api_key ? "Maya is replying - add a Cartesia key in Admin for voice" : shouldSpeak ? "Maya is replying with voice..." : "Maya is replying...");
  if (shouldSpeak) startStreamingSpeech(runId);
  let pendingSelfiePrompt = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, mode, speak: shouldSpeak, attachments: outgoingAttachments }),
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
          if (shouldSpeak && !voiceHasStarted) {
            pendingAssistantText = assistantText;
          } else {
            updateMessage(assistant.id, assistantText);
          }
          if (shouldSpeak) {
            const speakableText = speechSanitizer.push(event.text);
            if (speakableText) queueSpeech(speakableText, runId, false);
          }
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }
    }
    pendingSelfiePrompt = firstSelfiePrompt(assistantText);
    if (pendingSelfiePrompt && !canAutoGenerateSelfie()) {
      pendingSelfiePrompt = "";
    }
    if (shouldSpeak) {
      const remainingSpeakableText = speechSanitizer.flush();
      if (remainingSpeakableText) queueSpeech(remainingSpeakableText, runId, true);
      flushSpeech(runId);
    }
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
  if (pendingSelfiePrompt) {
    await generateImage({ prompt: pendingSelfiePrompt, initiator: "assistant", directPrompt: true });
  }
  if (!shouldSpeak) scheduleHandsFreeListening(runId);
}

function setBusy(busy) {
  form.querySelector("#sendButton").disabled = busy;
  callMicButton.disabled = busy && !callMicButton.classList.contains("is-listening");
  attachButton.disabled = busy;
  imageButton.disabled = busy;
  resetChat.disabled = busy;
}

async function generateImage(options = {}) {
  if (aborter) return;
  if (settings.image_provider !== "openrouter") {
    setStatus("Image generation is disabled in Admin");
    return;
  }
  if (!settings.openrouter_api_key) {
    setStatus("Add an OpenRouter API key in Admin for images");
    return;
  }
  const prompt = typeof options === "string" ? options : (options.prompt ?? input.value.trim());
  const initiator = typeof options === "object" && options.initiator ? options.initiator : "user";
  const directPrompt = typeof options === "object" && Boolean(options.directPrompt);
  const referenceImages = typeof options === "object" && Array.isArray(options.referenceImages)
    ? options.referenceImages
    : [];
  const useCharacterReference = typeof options === "object" && "useCharacterReference" in options
    ? Boolean(options.useCharacterReference)
    : true;
  const previewOnly = typeof options === "object" && Boolean(options.previewOnly);
  if (initiator === "user" && !prompt) {
    setStatus("Type an image prompt first");
    return;
  }
  if (initiator === "user") {
    input.value = "";
    pendingAttachments = pendingAttachments.filter((item) => item.kind !== "image");
    renderAttachmentTray();
  }
  setBusy(true);
  if (previewOnly) startImageDialogProgress("Sending image prompt...");
  else startImageProgress(directPrompt ? "Sending image prompt..." : "Creating selfie prompt...");
  try {
    const res = await fetch("/api/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        initiator,
        direct_prompt: directPrompt,
        reference_images: referenceImages,
        use_character_reference: useCharacterReference,
        preview_only: previewOnly,
      }),
    });
    if (previewOnly) updateImageDialogProgress(92, "Receiving image...");
    else updateImageProgress(92, "Receiving image...");
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Image generation failed");
    if (previewOnly) {
      showGeneratedImagePreview(data);
    } else {
      store = data.store;
      render();
    }
    const cost = formatImageCost(data.usage?.cost);
    if (previewOnly) finishImageDialogProgress("Preview ready");
    else finishImageProgress("Image ready");
    const readyText = previewOnly ? "Preview ready." : "Image ready.";
    setStatus(data.warning ? `${data.warning}${cost}` : `${readyText}${cost}`);
  } catch (error) {
    if (previewOnly) stopImageDialogProgress();
    else stopImageProgress();
    setStatus(error.message || "Image generation failed");
  } finally {
    setBusy(false);
  }
}

function formatImageCost(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return ` Cost: $${amount.toFixed(2)}`;
}

function openImagePromptDialog() {
  imagePromptText.value = input.value.trim();
  imageDialogReferences = pendingAttachments.filter((item) => item.kind === "image");
  includeCharacterReference = Boolean(settings?.character_profile?.avatar);
  includeUserReference = Boolean(settings?.user_profile?.photo);
  clearGeneratedImagePreview();
  renderImageReferenceTray();
  imagePromptDialog.showModal();
  setTimeout(() => imagePromptText.focus(), 0);
}

async function addImageReferenceFiles(files) {
  const builtInCount = (includeCharacterReference && settings?.character_profile?.avatar ? 1 : 0)
    + (includeUserReference && settings?.user_profile?.photo ? 1 : 0);
  const remaining = Math.max(0, 3 - builtInCount - imageDialogReferences.length);
  if (!remaining) {
    setStatus("Remove a reference before adding another image");
    imageReferenceInput.value = "";
    return;
  }
  const selected = Array.from(files || []).slice(0, remaining);
  for (const file of selected) {
    if (!file.type.startsWith("image/")) continue;
    imageDialogReferences.push(await attachmentFromFile(file));
  }
  imageReferenceInput.value = "";
  renderImageReferenceTray();
}

function renderImageReferenceTray() {
  imageReferenceTray.innerHTML = "";
  const avatar = settings?.character_profile?.avatar;
  if (avatar) {
    imageReferenceTray.append(referenceChip({
      name: `${settings.character_profile?.name || "Character"} avatar`,
      data_url: avatar,
      locked: false,
      included: includeCharacterReference,
      onRemove: () => {
        includeCharacterReference = false;
        renderImageReferenceTray();
      },
      onRestore: () => {
        includeCharacterReference = true;
        renderImageReferenceTray();
      },
    }));
  }
  const userPhoto = settings?.user_profile?.photo;
  if (userPhoto) {
    imageReferenceTray.append(referenceChip({
      name: `${settings.user_profile?.name || "User"} photo`,
      data_url: userPhoto,
      included: includeUserReference,
      onRemove: () => {
        includeUserReference = false;
        renderImageReferenceTray();
      },
      onRestore: () => {
        includeUserReference = true;
        renderImageReferenceTray();
      },
    }));
  }
  for (const [index, item] of imageDialogReferences.entries()) {
    imageReferenceTray.append(referenceChip({
      name: item.name || "reference image",
      data_url: item.data_url,
      included: true,
      onRemove: () => {
        imageDialogReferences.splice(index, 1);
        renderImageReferenceTray();
      },
    }));
  }
}

function referenceChip({ name, data_url, included, onRemove, onRestore }) {
  const chip = document.createElement("div");
  chip.className = `reference-chip${included ? "" : " is-muted"}`;
  const img = document.createElement("img");
  img.src = data_url;
  img.alt = "";
  const label = document.createElement("span");
  label.textContent = name;
  const action = document.createElement("button");
  action.type = "button";
  action.textContent = included ? "Remove" : "Add";
  action.addEventListener("click", included ? onRemove : onRestore);
  chip.append(img, label, action);
  return chip;
}

async function submitImagePrompt() {
  const prompt = imagePromptText.value.trim();
  if (!prompt) {
    setStatus("Type an image prompt first");
    return;
  }
  input.value = "";
  pendingAttachments = pendingAttachments.filter((item) => item.kind !== "image");
  renderAttachmentTray();
  const userPhotoReference = includeUserReference && settings?.user_profile?.photo
    ? [{
        kind: "image",
        name: `${settings.user_profile?.name || "User"} photo`,
        type: "image/*",
        size: 0,
        data_url: settings.user_profile.photo,
      }]
    : [];
  await generateImage({
    prompt,
    initiator: "user",
    directPrompt: true,
    referenceImages: [...userPhotoReference, ...imageDialogReferences],
    useCharacterReference: includeCharacterReference,
    previewOnly: true,
  });
}

function startImageDialogProgress(label) {
  stopImageDialogProgress();
  imageDialogProgressValue = 8;
  imageDialogProgress.hidden = false;
  updateImageDialogProgress(imageDialogProgressValue, label);
  const stages = [
    [22, "Reading references..."],
    [38, "Sending to OpenRouter..."],
    [62, "Rendering preview..."],
    [82, "Almost ready..."],
  ];
  let index = 0;
  imageDialogProgressTimer = setInterval(() => {
    if (index < stages.length) {
      updateImageDialogProgress(stages[index][0], stages[index][1]);
      index += 1;
      return;
    }
    imageDialogProgressValue = Math.min(90, imageDialogProgressValue + 1);
    updateImageDialogProgress(imageDialogProgressValue, "Still rendering...");
  }, 1400);
}

function updateImageDialogProgress(value, label) {
  imageDialogProgressValue = Math.max(imageDialogProgressValue, Math.min(100, Number(value) || 0));
  imageDialogProgressLabel.textContent = label;
  imageDialogProgressPercent.textContent = `${Math.round(imageDialogProgressValue)}%`;
  imageDialogProgressBar.style.width = `${imageDialogProgressValue}%`;
}

function finishImageDialogProgress(label) {
  updateImageDialogProgress(100, label);
  if (imageDialogProgressTimer) clearInterval(imageDialogProgressTimer);
  imageDialogProgressTimer = null;
}

function stopImageDialogProgress() {
  if (imageDialogProgressTimer) clearInterval(imageDialogProgressTimer);
  imageDialogProgressTimer = null;
  imageDialogProgressValue = 0;
  imageDialogProgress.hidden = true;
  imageDialogProgressBar.style.width = "0%";
  imageDialogProgressPercent.textContent = "0%";
}

function showGeneratedImagePreview(data) {
  const attachment = data.attachments?.find((item) => item.kind === "image" && item.data_url);
  if (!attachment) {
    setStatus("Image generated but no preview was returned");
    return;
  }
  pendingGeneratedImage = {
    prompt: data.prompt || imagePromptText.value.trim(),
    attachment: { ...attachment, prompt: data.prompt || attachment.prompt || imagePromptText.value.trim() },
  };
  imagePreviewImg.src = attachment.data_url;
  imagePreviewDownload.href = attachment.data_url;
  imagePreviewDownload.download = attachment.name || "generated-image.png";
  imagePreviewPanel.hidden = false;
  imagePromptGenerate.textContent = "Regenerate";
}

function clearGeneratedImagePreview() {
  pendingGeneratedImage = null;
  stopImageDialogProgress();
  setImagePosting(false);
  imagePreviewImg.removeAttribute("src");
  imagePreviewDownload.removeAttribute("href");
  imagePreviewDownload.removeAttribute("download");
  imagePreviewPanel.hidden = true;
  imagePromptGenerate.textContent = "Generate";
}

async function postGeneratedImage() {
  if (!pendingGeneratedImage || imagePosting) return;
  const postedImage = pendingGeneratedImage;
  resetSpeechState();
  speechRun += 1;
  ttsWarningShown = false;
  voiceHasStarted = false;
  pendingAssistantText = "";
  speechSanitizer = createSpeechSanitizer();
  const runId = speechRun;
  const shouldSpeak = voiceOn && Boolean(settings.cartesia_api_key);
  setBusy(true);
  setImagePosting(true);
  imagePromptDialog.close();
  clearGeneratedImagePreview();
  const placeholder = appendMessage("user", "Posting image", "image");
  placeholder.attachments = [postedImage.attachment];
  render();
  const assistant = appendMessage("assistant", "", shouldSpeak ? "voice" : "text");
  activeAssistantId = assistant.id;
  setStatus(shouldSpeak ? "Posting image - Maya is replying with voice..." : "Posting image...");
  if (shouldSpeak) startStreamingSpeech(runId);
  try {
    const res = await fetch("/api/post-generated-image-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: postedImage.prompt,
        attachments: [postedImage.attachment],
        speak: shouldSpeak,
      }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Could not post image");
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
        if (event.type === "user") {
          replaceMessage(placeholder.id, event.message);
        } else if (event.type === "delta") {
          assistantText += event.text;
          if (shouldSpeak && !voiceHasStarted) {
            pendingAssistantText = assistantText;
          } else {
            updateMessage(assistant.id, assistantText);
          }
          if (shouldSpeak) {
            const speakableText = speechSanitizer.push(event.text);
            if (speakableText) queueSpeech(speakableText, runId, false);
          }
        } else if (event.type === "done") {
          if (assistantText) updateMessage(assistant.id, assistantText);
          if (shouldSpeak) {
            const remainingSpeakableText = speechSanitizer.flush();
            if (remainingSpeakableText) queueSpeech(remainingSpeakableText, runId, true);
            flushSpeech(runId);
          }
          const index = store.messages.findIndex((item) => item.id === assistant.id);
          if (index >= 0) store.messages[index] = { ...event.message, content: assistantText || event.message.content || "" };
          render();
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }
    }
    setStatus("Image posted");
  } catch (error) {
    updateMessage(assistant.id, `${assistant.content || ""}\n\n[${error.message || "Could not post image"}]`.trim());
    setStatus(error.message || "Could not post image");
  } finally {
    setImagePosting(false);
    setBusy(false);
  }
}

function setImagePosting(posting) {
  imagePosting = posting;
  imagePreviewPost.disabled = posting;
  imagePreviewDelete.disabled = posting;
  imagePromptGenerate.disabled = posting;
  imageReferenceAdd.disabled = posting;
  imagePromptClose.disabled = posting;
  imagePreviewDownload.toggleAttribute("aria-disabled", posting);
  imagePreviewPost.textContent = posting ? "Posting..." : "Post";
}

function requestSelfieFromMessage(message) {
  const characterName = settings?.character_profile?.name || "Maya";
  const visibleText = formatForDisplay(message?.content || "");
  const promptSeed = [
    `Create a natural candid selfie of ${characterName} based on the current chat moment.`,
    visibleText ? `Use this recent message as the emotional cue: ${visibleText.slice(0, 700)}` : "",
  ].filter(Boolean).join("\n");
  generateImage({ prompt: promptSeed, initiator: "assistant", directPrompt: false });
}

function startImageProgress(label) {
  stopImageProgress();
  imageProgressValue = 8;
  imageProgress.classList.add("is-active");
  imageProgress.setAttribute("aria-hidden", "false");
  updateImageProgress(imageProgressValue, label);
  const stages = [
    [22, "Reading the moment..."],
    [38, "Writing image prompt..."],
    [56, "Sending to OpenRouter..."],
    [72, "Rendering image..."],
    [86, "Almost there..."],
  ];
  let index = 0;
  imageProgressTimer = setInterval(() => {
    if (index < stages.length) {
      updateImageProgress(stages[index][0], stages[index][1]);
      index += 1;
      return;
    }
    imageProgressValue = Math.min(90, imageProgressValue + 1);
    updateImageProgress(imageProgressValue, "Still rendering...");
  }, 1400);
}

function updateImageProgress(value, label) {
  imageProgressValue = Math.max(imageProgressValue, Math.min(100, Number(value) || 0));
  imageProgressLabel.textContent = label;
  imageProgressPercent.textContent = `${Math.round(imageProgressValue)}%`;
  imageProgressBar.style.width = `${imageProgressValue}%`;
}

function finishImageProgress(label) {
  updateImageProgress(100, label);
  if (imageProgressTimer) clearInterval(imageProgressTimer);
  imageProgressTimer = null;
  setTimeout(() => stopImageProgress(), 1200);
}

function stopImageProgress() {
  if (imageProgressTimer) clearInterval(imageProgressTimer);
  imageProgressTimer = null;
  imageProgressValue = 0;
  imageProgress.classList.remove("is-active");
  imageProgress.setAttribute("aria-hidden", "true");
  imageProgressBar.style.width = "0%";
  imageProgressPercent.textContent = "0%";
}

async function loadOpenRouterImageModels() {
  setStatus("Loading OpenRouter image models...");
  const res = await fetch("/api/openrouter-image-models");
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "Could not load image models");
  const list = document.querySelector("#openrouterImageModels");
  list.innerHTML = "";
  const models = Array.isArray(data.data) ? data.data : [];
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id || "";
    option.label = model.name ? `${model.name} (${model.id})` : model.id || "";
    list.append(option);
  }
  const grok = models.find((model) => {
    const text = `${model.id || ""} ${model.name || ""}`.toLowerCase();
    return text.includes("grok") || text.includes("x-ai") || text.includes("xai");
  });
  if (grok && !document.querySelector("#openrouterImageModel").value) {
    document.querySelector("#openrouterImageModel").value = grok.id || "";
  }
  setStatus(`Loaded ${models.length} image models`);
}

function renderAttachments(attachments, message = null) {
  if (!attachments.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "message-attachments";
  for (const item of attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    if (item.kind === "image" && item.data_url) {
      const img = document.createElement("img");
      img.src = item.data_url;
      img.alt = "";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "image-thumb";
      open.title = "Open image";
      open.append(img);
      open.addEventListener("click", () => openImageViewer(item.data_url, item.name || "image", promptForImage(item, message)));
      chip.append(open);
    }
    const label = document.createElement("span");
    label.textContent = item.name || "attachment";
    chip.append(label);
    wrap.append(chip);
  }
  return wrap;
}

function renderAttachmentTray() {
  attachmentTray.innerHTML = "";
  attachmentTray.classList.toggle("has-items", pendingAttachments.length > 0);
  for (const [index, item] of pendingAttachments.entries()) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    if (item.kind === "image" && item.data_url) {
      const img = document.createElement("img");
      img.src = item.data_url;
      img.alt = "";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "image-thumb";
      open.title = "Open image";
      open.append(img);
      open.addEventListener("click", () => openImageViewer(item.data_url, item.name || "image", promptForImage(item)));
      chip.append(open);
    }
    const label = document.createElement("span");
    label.textContent = item.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "X";
    remove.addEventListener("click", () => {
      pendingAttachments.splice(index, 1);
      renderAttachmentTray();
    });
    chip.append(label, remove);
    attachmentTray.append(chip);
  }
}

function openImageViewer(src, name, prompt = "") {
  imageDialogImg.src = src;
  imageDownload.href = src;
  imageDownload.download = name || "image";
  imageViewerPromptText.textContent = prompt;
  imageViewerPrompt.hidden = !prompt;
  imageDialog.showModal();
}

function promptForImage(item, message = null) {
  return String(item?.prompt || promptFromContext(item?.context) || promptFromContext(message?.context) || "").trim();
}

function promptFromContext(context) {
  const text = String(context || "");
  const generated = text.match(/generated and shared this image from this prompt:\s*([\s\S]*)$/i);
  if (generated) return generated[1].trim();
  const simple = text.match(/generated from this prompt:\s*([\s\S]*)$/i);
  return simple ? simple[1].trim() : "";
}

async function addFiles(files) {
  const selected = Array.from(files || []).slice(0, 6 - pendingAttachments.length);
  for (const file of selected) {
    pendingAttachments.push(await attachmentFromFile(file));
  }
  renderAttachmentTray();
  fileInput.value = "";
}

function attachmentFromFile(file) {
  if (file.type.startsWith("image/")) {
    return readAsDataUrl(file).then((dataUrl) => ({
      kind: "image",
      name: file.name,
      type: file.type,
      size: file.size,
      data_url: dataUrl,
    }));
  }
  if (isReadableTextFile(file)) {
    return readAsText(file).then((text) => ({
      kind: "text",
      name: file.name,
      type: file.type || "text/plain",
      size: file.size,
      text: text.slice(0, 120000),
    }));
  }
  return Promise.resolve({
    kind: "unsupported",
    name: file.name,
    type: file.type,
    size: file.size,
  });
}

function isReadableTextFile(file) {
  const name = file.name.toLowerCase();
  return file.type.startsWith("text/")
    || [
      ".txt", ".md", ".csv", ".json", ".html", ".css", ".js", ".ts", ".tsx", ".jsx",
      ".py", ".ps1", ".bat", ".xml", ".yaml", ".yml", ".log",
    ].some((ext) => name.endsWith(ext));
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function formatForDisplay(text) {
  return stripModelArtifacts(stripSpokenArtifacts(text))
    .replace(/\[\[SELFIE:[\s\S]*?\]\]/gi, " ")
    .replace(/\*([^*]*)\*/gs, (_, content) => shouldDropItalicSegment(content) ? " " : content.trim())
    .replace(/<\s*(?:emotion|speed|volume|break)\b[^>\]]*(?:>|\]|$)/gi, " ")
    .replace(/<pause\s*\/>/gi, " ")
    .replace(/\[(?!laughter\])[\s\S]*?\]/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePauseTags(text) {
  return String(text || "")
    .replace(/<pause\s*\/>/gi, pauseBreakTag)
    .replace(/<\s*break\b[^>\]]*(?:>|\]|$)/gi, pauseBreakTag);
}

function stripSpokenArtifacts(text) {
  return String(text || "").replace(/(^|[\s.,;:!?])\|(?=$|[\s.,;:!?])/gm, "$1 ");
}

function stripModelArtifacts(text) {
  return String(text || "")
    .replace(/<\|[^>]*\|>/gi, " ")
    .replace(/<\/?s>/gi, " ")
    .replace(/<\s*(?:end|eos|im_end)\s*\/?\s*>/gi, " ");
}

function isModelArtifact(text) {
  return /^(?:<\|[^>]*\|>|<\/?s>|<\s*(?:end|eos|im_end)\s*\/?\s*>)$/i.test(String(text || "").trim());
}

function createSpeechSanitizer() {
  return {
    inStageDirection: false,
    angleBuffer: "",
    italicBuffer: "",
    bracketBuffer: "",
    push(text) {
      let output = "";
      for (const char of text) {
        if (this.angleBuffer) {
          this.angleBuffer += char;
          if (char === ">" || (char === "]" && /^<\s*break\b/i.test(this.angleBuffer))) {
            if (!isModelArtifact(this.angleBuffer)) output += normalizePauseTags(this.angleBuffer);
            this.angleBuffer = "";
          }
          continue;
        }

        if (this.italicBuffer) {
          if (char === "*") {
            output += shouldDropItalicSegment(this.italicBuffer) ? " " : this.italicBuffer;
            this.italicBuffer = "";
          } else {
            this.italicBuffer += char;
          }
          continue;
        }

        if (this.bracketBuffer) {
          this.bracketBuffer += char;
          if (this.bracketBuffer.startsWith("[[") && !this.bracketBuffer.endsWith("]]")) {
            continue;
          }
          if (char === "]") {
            if (this.bracketBuffer.toLowerCase() === "[laughter]") output += this.bracketBuffer;
            this.bracketBuffer = "";
          }
          continue;
        }

        if (char === "<") {
          this.angleBuffer = "<";
          continue;
        }

        if (char === "*") {
          this.italicBuffer = "";
          continue;
        }

        if (char === "[") {
          this.bracketBuffer = "[";
          continue;
        }

        output += char;
      }
      return output;
    },
    flush() {
      const angleLeftover = this.angleBuffer;
      const italicLeftover = this.italicBuffer && !shouldDropItalicSegment(this.italicBuffer) ? this.italicBuffer : "";
      const leftover = this.bracketBuffer.toLowerCase() === "[laughter]" ? this.bracketBuffer : "";
      this.angleBuffer = "";
      this.italicBuffer = "";
      this.bracketBuffer = "";
      this.inStageDirection = false;
      return `${angleLeftover}${italicLeftover}${leftover}`;
    },
  };
}

function shouldDropItalicSegment(content) {
  const text = String(content || "").trim();
  const words = text.match(/[A-Za-z']+/g) || [];
  if (words.length > 8) return true;
  return /^(she |he |they |her voice|his voice|there is|there's|a pause|pause|silence|laughs|smiles|sighs|breathes|whispers|leans|looks|voice |softly$|quietly$|gently$|warmly$|tenderly$|playfully$|sadly$)/i.test(text);
}

function firstSelfiePrompt(text) {
  const match = String(text || "").match(/\[\[SELFIE:\s*([\s\S]*?)\]\]/i);
  return match ? match[1].trim().slice(0, 900) : "";
}

function canAutoGenerateSelfie() {
  const messages = store?.messages || [];
  let userTurnsSinceLastSelfie = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") userTurnsSinceLastSelfie += 1;
    if (isAssistantSelfieMessage(message)) {
      return userTurnsSinceLastSelfie >= automaticSelfieUserTurnCooldown;
    }
  }
  return true;
}

function isAssistantSelfieMessage(message) {
  if (!message || message.role !== "assistant") return false;
  if (message.mode === "image") return true;
  const content = String(message.content || "").toLowerCase();
  return content.includes("selfie") && (message.attachments || []).some((item) => item.kind === "image");
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

function stopListening(cancelBrowserRecognition = true) {
  setHandsFreeMic(false);
  stopActiveListening(cancelBrowserRecognition);
}

function stopActiveListening(cancelBrowserRecognition = true) {
  stopCartesiaStt(false);
  if (recognition && browserRecognitionActive) {
    suppressRecognitionEnd = true;
    if (cancelBrowserRecognition && typeof recognition.abort === "function") {
      recognition.abort();
    } else {
      recognition.stop();
    }
  }
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
  voiceHasStarted = true;
  chatPanel.classList.add("is-speaking");
  if (pendingAssistantText && activeAssistantId) {
    updateMessage(activeAssistantId, pendingAssistantText);
  }
}

function queueSpeech(delta, runId, force) {
  sentenceBuffer += delta;
  const chunk = takeSpeechChunk(force);
  if (chunk) speakChunk(chunk, runId, false);

  if (speechFlushTimer) clearTimeout(speechFlushTimer);
  speechFlushTimer = setTimeout(() => {
    const delayed = takeSpeechChunk(true);
    if (delayed) speakChunk(delayed, runId, false);
  }, 220);
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

  const soft = text.match(/^(.+?[,;:])(\s+|$)/s);
  if (soft && soft[1].trim().length >= 24) {
    sentenceBuffer = text.slice(soft[0].length);
    return soft[1].trim();
  }

  if (text.length >= 72) {
    const boundary = Math.max(text.lastIndexOf(" ", 72), text.lastIndexOf(",", 72));
    const cut = boundary > 36 ? boundary + 1 : 72;
    sentenceBuffer = text.slice(cut);
    return text.slice(0, cut).trim();
  }

  if (force && text.length >= 12) {
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

function enqueueSpeech(text, runId) {
  const audioPromise = fetchSpeech(text, runId);
  playbackQueue = playbackQueue.then(() => playSpeech(audioPromise, runId)).catch(reportTtsError);
}

function speakChunk(text, runId, final) {
  text = normalizePauseTags(text);
  text = stripModelArtifacts(text);
  text = stripSpokenArtifacts(text);
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
  const transcript = normalizeStreamingTranscript(text, final);
  socket.send(JSON.stringify({
    model_id: settings.cartesia_model_id || "sonic-3.5",
    transcript,
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

function normalizeStreamingTranscript(text, final) {
  if (!text) return "";
  text = normalizePauseTags(text);
  text = stripModelArtifacts(text);
  text = stripSpokenArtifacts(text);
  if (final) return text;
  return /\s$/.test(text) ? text : `${text} `;
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
  if (message.type === "chunk" && message.data && streamingPlayer) {
    streamingPlayer.playBase64(message.data);
  }
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
    this.startupDelay = 0.16;
    this.scheduleLead = 0.05;
    this.fadeInSeconds = 0.06;
    this.sources = new Set();
  }

  ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.meterData = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.audioContext.destination);
      this.nextStartTime = this.audioContext.currentTime + this.startupDelay;
    }
    this.audioContext.resume?.();
  }

  playBase64(base64) {
    this.ensureContext();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const samples = new Float32Array(bytes.length / 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }

    const buffer = this.audioContext.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.analyser);

    const startAt = Math.max(this.audioContext.currentTime + this.scheduleLead, this.nextStartTime);
    if (!this.started) {
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(1, startAt + this.fadeInSeconds);
    } else {
      gain.gain.setValueAtTime(1, startAt);
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
  text = stripModelArtifacts(text);
  text = stripSpokenArtifacts(text);
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: normalizePauseTags(text) }),
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

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    if (!navigator.mediaDevices?.getUserMedia) {
      callMicButton.disabled = true;
      callMicButton.title = "Microphone input is not available in this browser";
    } else {
      callMicButton.disabled = false;
      callMicButton.title = "Start voice input";
    }
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  let finalText = "";
  recognition.onstart = () => {
    browserRecognitionActive = true;
    setMicActive(true);
    setStatus("Listening...");
  };
  recognition.onresult = (event) => {
    let interim = "";
    finalText = "";
    for (const result of event.results) {
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    input.value = finalText || interim;
  };
  recognition.onend = () => {
    browserRecognitionActive = false;
    if (suppressRecognitionEnd) {
      suppressRecognitionEnd = false;
      setMicActive(false);
      setStatus("Ready");
      return;
    }
    const text = input.value.trim();
    setMicActive(false);
    setStatus("Ready");
    if (text) {
      sendMessage(text, "voice");
    } else {
      scheduleHandsFreeListening(speechRun, 350);
    }
  };
  recognition.onerror = (event) => {
    browserRecognitionActive = false;
    if (event?.error === "aborted") {
      suppressRecognitionEnd = true;
      setMicActive(false);
      setStatus("Ready");
      return;
    }
    setMicActive(false);
    setStatus("Mic error");
  };
}

async function startCartesiaStt() {
  if (cartesiaStt) {
    stopCartesiaStt(false);
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
  cartesiaStt = {
    socket,
    stream,
    audioContext,
    source,
    processor,
    finalTranscript: "",
    ending: false,
  };

  socket.onopen = () => {
    setStatus("Listening with Ink-2...");
  };
  socket.onerror = () => {
    setStatus("Ink-2 mic error");
    stopCartesiaStt(false);
  };
  socket.onclose = () => {
    stopCartesiaStt(false);
  };
  socket.onmessage = (event) => handleCartesiaSttMessage(event);

  processor.onaudioprocess = (event) => {
    if (!cartesiaStt || socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    setOrbAudioLevel(audioLevelFromFloat32(input));
    socket.send(input.slice().buffer);
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

  if (message.type === "connected") {
    setStatus("Listening with Ink-2...");
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
  if (message.type === "turn.resume") {
    setStatus("Listening...");
    return;
  }
  if (message.type === "turn.end") {
    const transcript = String(message.transcript || input.value || "").trim();
    cartesiaStt.finalTranscript = transcript;
    cartesiaStt.ending = true;
    stopCartesiaStt(false);
    if (transcript) {
      sendMessage(transcript, "voice");
    } else {
      scheduleHandsFreeListening(speechRun, 350);
    }
    return;
  }
  if (message.type === "error") {
    setStatus(message.message || "Ink-2 mic error");
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
  if (sendClose && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "close" }));
  } else if (state.socket.readyState === WebSocket.OPEN) {
    state.socket.close();
  }
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
  if (settings.use_cartesia_stt !== false && settings.cartesia_api_key) {
    startCartesiaStt().catch((error) => {
      setStatus(error.message || "Ink-2 mic unavailable");
      stopCartesiaStt(false);
      if (recognition && !browserRecognitionActive) recognition.start();
    });
    return;
  }
  if (recognition) {
    try {
      recognition.start();
    } catch {
      browserRecognitionActive = false;
    }
    return;
  }
  setStatus("Browser mic transcription is not available here");
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

textToggle.addEventListener("click", () => {
  setCallMode(false);
});

callToggle.addEventListener("click", () => {
  setCallMode(true);
});

imageClose.addEventListener("click", () => imageDialog.close());

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

attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (event) => addFiles(event.target.files).catch((error) => setStatus(error.message)));
imageButton.addEventListener("click", () => openImagePromptDialog());
imageReferenceAdd.addEventListener("click", () => imageReferenceInput.click());
imageReferenceInput.addEventListener("change", (event) => addImageReferenceFiles(event.target.files).catch((error) => setStatus(error.message)));
imagePromptGenerate.addEventListener("click", () => submitImagePrompt().catch((error) => setStatus(error.message)));
imagePreviewDownload.addEventListener("click", (event) => {
  if (imagePosting) event.preventDefault();
});
imagePreviewDelete.addEventListener("click", () => {
  clearGeneratedImagePreview();
  setStatus("Generated image deleted");
});
imagePreviewPost.addEventListener("click", () => postGeneratedImage().catch((error) => setStatus(error.message)));
imagePromptText.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    submitImagePrompt().catch((error) => setStatus(error.message));
  }
});
loadImageModels.addEventListener("click", () => loadOpenRouterImageModels().catch((error) => setStatus(error.message)));

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

importButton.addEventListener("click", async () => {
  const file = document.querySelector("#importFile").files[0];
  if (!file) return;
  const payload = JSON.parse(await file.text());
  const replace = document.querySelector("#replaceImport").checked;
  const res = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, replace }),
  });
  const data = await res.json();
  if (data.error) {
    setStatus(data.error);
    return;
  }
  store = data.store;
  render();
  setStatus(`Imported ${data.imported} messages`);
});

setupSpeechRecognition();
loadState().catch((error) => setStatus(error.message));

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === tab.dataset.tab));
  });
});

document.querySelector("#userPhoto").addEventListener("change", async (event) => {
  const dataUrl = await readImageFile(event.target.files?.[0]);
  if (!dataUrl) return;
  settings.user_profile = settings.user_profile || {};
  settings.user_profile.photo = dataUrl;
  document.querySelector("#userPhotoPreview").src = dataUrl;
  render();
});

document.querySelector("#characterAvatar").addEventListener("change", async (event) => {
  const dataUrl = await readImageFile(event.target.files?.[0]);
  if (!dataUrl) return;
  settings.character_profile = settings.character_profile || {};
  settings.character_profile.avatar = dataUrl;
  document.querySelector("#characterAvatarPreview").src = dataUrl;
  updateCallIdentity();
  render();
});

function readImageFile(file) {
  if (!file) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
