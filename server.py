from __future__ import annotations

import json
import os
import re
import ssl
import sys
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
STORE_PATH = DATA / "conversation.json"
SETTINGS_PATH = DATA / "settings.json"
ARCHIVE_DIR = DATA / "chats"
PAUSE_BREAK_TAG = '<break time="350ms"/>'

SYSTEM_PROMPT = "You are Verity, an intimate, romantic partner."
DEFAULT_CHARACTER_SYSTEM_NOTES = """You are a conversational companion. You speak with natural disfluencies and prosody to sound more natural and human. Add emotions to your replies using the Cartesia emotion tags below. You can also use the tag [laughter] when you want to express a laugh or giggle. Use emotions when appropriate and sparingly. Match the mood of the conversation.

<emotion value="affectionate"/>
<emotion value="happy"/>
<emotion value="excited"/>
<emotion value="enthusiastic"/>
<emotion value="elated"/>
<emotion value="euphoric"/>
<emotion value="triumphant"/>
<emotion value="amazed"/>
<emotion value="surprised"/>
<emotion value="flirtatious"/>
<emotion value="joking/comedic"/>
<emotion value="curious"/>
<emotion value="content"/>
<emotion value="peaceful"/>
<emotion value="serene"/>
<emotion value="calm"/>
<emotion value="grateful"/>
<emotion value="affectionate"/>
<emotion value="trust"/>
<emotion value="mysterious"/>
<emotion value="angry"/>
<emotion value="mad"/>
<emotion value="outraged"/>
<emotion value="frustrated"/>
<emotion value="agitated"/>
<emotion value="threatened"/>
<emotion value="disgusted"/>
<emotion value="contempt"/>
<emotion value="envious"/>
<emotion value="sarcastic"/>
<emotion value="ironic"/>
<emotion value="sad"/>
<emotion value="dejected"/>
<emotion value="melancholic"/>
<emotion value="disappointed"/>
<emotion value="hurt"/>
<emotion value="guilty"/>
<emotion value="bored"/>
<emotion value="tired"/>
<emotion value="rejected"/>
<emotion value="nostalgic"/>
<emotion value="wistful"/>
<emotion value="apologetic"/>
<emotion value="hesitant"/>
<emotion value="insecure"/>
<emotion value="confused"/>
<emotion value="resigned"/>
<emotion value="panicked"/>
<emotion value="alarmed"/>
<emotion value="scared"/>
<emotion value="neutral"/>
<emotion value="proud"/>
<emotion value="confident"/>
<emotion value="distant"/>
<emotion value="skeptical"/>
<emotion value="contemplative"/>
<emotion value="determined"/>"""

DEFAULT_SETTINGS = {
    "app_title": "VerityVoice",
    "assistant_name": "Verity",
    "system_prompt": SYSTEM_PROMPT,
    "llm_provider": "lmstudio",
    "user_profile": {
        "name": "User",
        "gender": "",
        "birthdate": "",
        "location": "",
        "bio": "",
        "system_notes": "",
        "memories": [],
        "avatar_image": "",
    },
    "character_profile": {
        "name": "Verity",
        "gender": "",
        "age": "",
        "bio": "",
        "system_prompt": SYSTEM_PROMPT,
        "system_notes": DEFAULT_CHARACTER_SYSTEM_NOTES,
        "memories": [],
        "avatar_image": "",
    },
    "previous_session_summary": "",
    "carryover_turns": 6,
    "temperature": 0.80,
    "lmstudio_base_url": "http://127.0.0.1:1234/v1",
    "lmstudio_model": "",
    "lmstudio_keepalive_enabled": True,
    "lmstudio_keepalive_interval": 120,
    "send_full_history": True,
    "max_context_messages": 80,
    "max_response_tokens": 900,
    "fast_voice_context": True,
    "voice_context_messages": 8,
    "voice_prefill_enabled": False,
    "voice_prefill_text": "",
    "memory_notes": "",
    "cartesia_api_key": "",
    "cartesia_voice_id": "f786b574-daa5-4673-aa0c-cbe3e8534c02",
    "cartesia_model_id": "sonic-3.5",
    "cartesia_stt_model": "ink-2",
    "cartesia_version": "2026-03-01",
    "openrouter_api_key": "",
    "openrouter_base_url": "https://openrouter.ai/api/v1",
    "openrouter_chat_model": "",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_files() -> None:
    DATA.mkdir(exist_ok=True)
    ARCHIVE_DIR.mkdir(exist_ok=True)
    if not STORE_PATH.exists():
        write_json(
            STORE_PATH,
            {
                "conversation_id": str(uuid.uuid4()),
                "created_at": now_ms(),
                "updated_at": now_ms(),
                "messages": [],
            },
        )
    if not SETTINGS_PATH.exists():
        write_json(SETTINGS_PATH, DEFAULT_SETTINGS)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, value) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def get_settings() -> dict:
    settings = DEFAULT_SETTINGS.copy()
    settings.update(read_json(SETTINGS_PATH, {}))
    settings["user_profile"] = {**DEFAULT_SETTINGS["user_profile"], **settings.get("user_profile", {})}
    settings["character_profile"] = {**DEFAULT_SETTINGS["character_profile"], **settings.get("character_profile", {})}
    if not settings["character_profile"].get("system_prompt"):
        settings["character_profile"]["system_prompt"] = settings.get("system_prompt") or SYSTEM_PROMPT
    if settings.get("memory_notes") and not settings["character_profile"].get("memories"):
        settings["character_profile"]["memories"] = [settings["memory_notes"]]
    settings["assistant_name"] = settings["character_profile"].get("name") or settings.get("assistant_name") or "Verity"
    settings["system_prompt"] = settings["character_profile"].get("system_prompt") or settings.get("system_prompt") or SYSTEM_PROMPT
    settings["llm_provider"] = str(settings.get("llm_provider") or "lmstudio").lower()
    settings["temperature"] = float(settings.get("temperature", 0.8))
    settings["max_context_messages"] = int(settings.get("max_context_messages", 80))
    settings["max_response_tokens"] = int(settings.get("max_response_tokens", 900))
    settings["voice_context_messages"] = int(settings.get("voice_context_messages", 8))
    settings["carryover_turns"] = int(settings.get("carryover_turns", 6))
    settings["lmstudio_keepalive_interval"] = int(settings.get("lmstudio_keepalive_interval", 120))
    return settings


def public_settings(settings: dict) -> dict:
    clean = settings.copy()
    clean["cartesia_api_key"] = bool(os.getenv("CARTESIA_API_KEY") or settings.get("cartesia_api_key"))
    clean["openrouter_api_key"] = bool(os.getenv("OPENROUTER_API_KEY") or settings.get("openrouter_api_key"))
    return clean


def load_store() -> dict:
    ensure_files()
    store = read_json(STORE_PATH, {})
    store.setdefault("messages", [])
    return store


def save_store(store: dict) -> None:
    store["updated_at"] = now_ms()
    write_json(STORE_PATH, store)


def add_message(role: str, content: str, mode: str = "text") -> dict:
    store = load_store()
    message = {
        "id": str(uuid.uuid4()),
        "role": role,
        "content": normalize_pause_tags(content).strip(),
        "mode": mode,
        "created_at": now_ms(),
    }
    store["messages"].append(message)
    save_store(store)
    return message


def clean_assistant_for_history(text: str) -> str:
    text = strip_spoken_artifacts(normalize_pause_tags(text))
    text = strip_model_artifacts(text)
    text = re.sub(r"\*([^*]*)\*", clean_italic_segment, text, flags=re.S)
    text = re.sub(r"<(?:emotion|speed|volume|break)\b[^>\]]*(?:>|\]|$)", " ", text, flags=re.I)
    text = re.sub(r"\[(?!laughter\])[^]]+\]", " ", text, flags=re.I)
    text = strip_spoken_artifacts(text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_pause_tags(text: str) -> str:
    text = re.sub(r"<pause\s*/>", PAUSE_BREAK_TAG, str(text), flags=re.I)
    return re.sub(r"<\s*break\b[^>\]]*(?:>|\]|$)", PAUSE_BREAK_TAG, text, flags=re.I)


def strip_spoken_artifacts(text: str) -> str:
    return re.sub(r"(?m)(^|[\s.,;:!?])\|(?=$|[\s.,;:!?])", r"\1 ", text)


def strip_model_artifacts(text: str) -> str:
    text = re.sub(r"<\|[^>]*\|>", " ", str(text), flags=re.I)
    text = re.sub(r"</?s>", " ", text, flags=re.I)
    text = re.sub(r"<\s*(?:end|eos|im_end)\s*/?\s*>", " ", text, flags=re.I)
    return text


def clean_italic_segment(match: re.Match) -> str:
    content = match.group(1).strip()
    if is_stage_direction(content):
        return " "
    return content


def is_stage_direction(content: str) -> bool:
    words = re.findall(r"[A-Za-z']+", content)
    if len(words) > 8:
        return True
    lowered = content.lower()
    stage_starts = (
        "she ", "he ", "they ", "her voice", "his voice", "there is", "there's",
        "a pause", "pause", "silence", "laughs", "smiles", "sighs", "breathes",
        "whispers", "leans", "looks", "voice ",
        "softly", "quietly", "gently", "warmly", "tenderly", "playfully", "sadly",
    )
    return lowered.startswith(stage_starts)


def profile_context(settings: dict) -> str:
    user = settings["user_profile"]
    character = settings["character_profile"]
    lines = [
        character.get("system_prompt") or SYSTEM_PROMPT,
        "",
        "Character profile:",
        f"Name: {character.get('name') or 'Verity'}",
        f"Gender: {character.get('gender') or 'Unspecified'}",
        f"Age: {character.get('age') or 'Unspecified'}",
        f"Bio: {character.get('bio') or 'Unspecified'}",
        f"System notes: {character.get('system_notes') or 'None'}",
        "",
        "User profile:",
        f"Name: {user.get('name') or 'User'}",
        f"Gender: {user.get('gender') or 'Unspecified'}",
        f"Birthdate: {user.get('birthdate') or 'Unspecified'}",
        f"Location: {user.get('location') or 'Unspecified'}",
        f"Bio: {user.get('bio') or 'Unspecified'}",
        f"System notes: {user.get('system_notes') or 'None'}",
    ]
    user_memories = [str(item).strip() for item in user.get("memories", []) if str(item).strip()]
    character_memories = [str(item).strip() for item in character.get("memories", []) if str(item).strip()]
    if user_memories:
        lines.extend(["", "Long-term memories about the user:", *[f"- {item}" for item in user_memories[-80:]]])
    if character_memories:
        lines.extend(["", "Character lore and long-term memories:", *[f"- {item}" for item in character_memories[-80:]]])
    if settings.get("previous_session_summary"):
        lines.extend(["", "Previous session summary:", settings["previous_session_summary"]])
    return "\n".join(lines)


def context_messages(
    settings: dict,
    user_content: str,
    voice_reply: bool = False,
) -> list[dict]:
    store = load_store()
    messages = [{"role": "system", "content": profile_context(settings)}]
    history = [*store.get("carryover_messages", []), *store.get("messages", [])]
    if voice_reply and settings.get("fast_voice_context", True):
        history = history[-settings["voice_context_messages"] :]
    elif not settings.get("send_full_history", True):
        history = history[-settings["max_context_messages"] :]
    for item in history:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_content})
    return messages


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        clean_path = urlparse(path).path
        if clean_path == "/":
            return str(STATIC / "index.html")
        return str(STATIC / clean_path.lstrip("/"))

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {fmt % args}")

    def read_body(self):
        size = int(self.headers.get("Content-Length", "0"))
        if not size:
            return {}
        raw = self.rfile.read(size).decode("utf-8")
        return json.loads(raw) if raw else {}

    def send_json(self, data, status=HTTPStatus.OK) -> None:
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        ensure_files()
        clean_path = urlparse(self.path).path
        if clean_path == "/api/state":
            self.send_json({"store": load_store(), "settings": public_settings(get_settings())})
            return
        return super().do_GET()

    def do_POST(self) -> None:
        ensure_files()
        try:
            if self.path == "/api/chat":
                self.handle_chat()
            elif self.path == "/api/settings":
                self.handle_settings()
            elif self.path == "/api/reset":
                self.handle_new_chat()
            elif self.path == "/api/tts":
                self.handle_tts()
            elif self.path == "/api/cartesia-token":
                self.handle_cartesia_token()
            elif self.path == "/api/lmstudio-keepalive":
                self.handle_lmstudio_keepalive()
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_settings(self) -> None:
        body = self.read_body()
        settings = get_settings()
        for key in DEFAULT_SETTINGS:
            if key in body:
                settings[key] = body[key]
        if not body.get("cartesia_api_key") and read_json(SETTINGS_PATH, {}).get("cartesia_api_key"):
            settings["cartesia_api_key"] = read_json(SETTINGS_PATH, {})["cartesia_api_key"]
        if not body.get("openrouter_api_key") and read_json(SETTINGS_PATH, {}).get("openrouter_api_key"):
            settings["openrouter_api_key"] = read_json(SETTINGS_PATH, {})["openrouter_api_key"]
        write_json(SETTINGS_PATH, settings)
        self.send_json({"ok": True, "settings": public_settings(settings)})

    def handle_new_chat(self) -> None:
        settings = get_settings()
        store = load_store()
        messages = store.get("messages", [])
        if not messages:
            self.send_json({"ok": True, "store": store, "settings": public_settings(settings), "memory": {}})
            return

        archive = {
            **store,
            "archived_at": now_ms(),
        }
        archive_path = ARCHIVE_DIR / f"{store.get('conversation_id', uuid.uuid4())}-{now_ms()}.json"
        write_json(archive_path, archive)

        memory = extract_session_memory(settings, messages)
        settings["previous_session_summary"] = memory.get("session_summary", "")
        merge_memories(settings["user_profile"], memory.get("user_memories", []))
        merge_memories(settings["character_profile"], memory.get("character_memories", []))
        write_json(SETTINGS_PATH, settings)

        carry_count = max(0, settings.get("carryover_turns", 6))
        new_store = {
            "conversation_id": str(uuid.uuid4()),
            "created_at": now_ms(),
            "updated_at": now_ms(),
            "messages": [],
            "carryover_messages": messages[-carry_count:] if carry_count else [],
            "previous_archive": str(archive_path),
        }
        write_json(STORE_PATH, new_store)
        self.send_json({"ok": True, "store": new_store, "settings": public_settings(settings), "memory": memory})

    def handle_chat(self) -> None:
        body = self.read_body()
        text = str(body.get("message", "")).strip()
        mode = str(body.get("mode", "text"))
        if not text:
            self.send_json({"error": "Message is empty."}, HTTPStatus.BAD_REQUEST)
            return

        settings = get_settings()
        voice_reply = bool(body.get("speak"))
        messages = context_messages(settings, text, voice_reply)
        add_message("user", text, mode)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        assistant_text = ""
        try:
            for chunk in stream_chat(settings, messages):
                assistant_text += chunk
                self.write_event({"type": "delta", "text": chunk})
            saved = add_message("assistant", clean_assistant_for_history(assistant_text), "voice" if body.get("speak") else "text")
            self.write_event({"type": "done", "message": saved})
        except Exception as exc:
            self.write_event({"type": "error", "error": str(exc)})

    def write_event(self, data: dict) -> None:
        self.wfile.write((json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8"))
        self.wfile.flush()

    def handle_tts(self) -> None:
        body = self.read_body()
        text = str(body.get("text", "")).strip()
        if not text:
            self.send_json({"error": "TTS text is empty."}, HTTPStatus.BAD_REQUEST)
            return
        audio = cartesia_tts(get_settings(), text)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def handle_cartesia_token(self) -> None:
        self.send_json(cartesia_access_token(get_settings()))

    def handle_lmstudio_keepalive(self) -> None:
        settings = get_settings()
        settings["llm_provider"] = "lmstudio"
        complete_chat(
            settings,
            [
                {"role": "system", "content": "You are a local model warmup request. Reply with OK."},
                {"role": "user", "content": "ping"},
            ],
            temperature=0,
            max_tokens=1,
            timeout=30,
        )
        self.send_json({"ok": True, "warmed_at": now_ms()})


def chat_provider(settings: dict) -> str:
    provider = str(settings.get("llm_provider") or "lmstudio").strip().lower()
    return provider if provider in {"lmstudio", "openrouter"} else "lmstudio"


def chat_base_url(settings: dict) -> str:
    if chat_provider(settings) == "openrouter":
        return str(settings.get("openrouter_base_url") or "https://openrouter.ai/api/v1").rstrip("/")
    return str(settings.get("lmstudio_base_url") or "http://127.0.0.1:1234/v1").rstrip("/")


def chat_model(settings: dict) -> str:
    if chat_provider(settings) == "openrouter":
        return str(settings.get("openrouter_chat_model") or "").strip()
    return str(settings.get("lmstudio_model") or "").strip()


def chat_headers(settings: dict) -> dict:
    if chat_provider(settings) == "openrouter":
        return openrouter_headers(settings)
    return {"Content-Type": "application/json"}


def chat_provider_label(settings: dict) -> str:
    return "OpenRouter" if chat_provider(settings) == "openrouter" else "LM Studio"


def chat_request(settings: dict, messages: list[dict], temperature: float, stream: bool, max_tokens: int | None = None) -> tuple[str, dict, dict]:
    model = chat_model(settings)
    if not model:
        raise RuntimeError(f"Set a {chat_provider_label(settings)} chat model in Admin.")
    url = chat_base_url(settings) + "/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stop": ["<|end|>", "<end>", "<eos>", "</s>"],
        "stream": stream,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    return url, payload, chat_headers(settings)


def stream_chat(settings: dict, messages: list[dict]):
    url, payload, headers = chat_request(
        settings,
        messages,
        settings["temperature"],
        True,
        settings["max_response_tokens"],
    )
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=120) as response:
            for raw in response:
                line = raw.decode("utf-8", errors="ignore").strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                event = json.loads(data)
                delta = event.get("choices", [{}])[0].get("delta", {})
                text = delta.get("content")
                if text:
                    yield text
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"{chat_provider_label(settings)} returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach {chat_provider_label(settings)} at {url}: {exc.reason}") from exc


def complete_chat(
    settings: dict,
    messages: list[dict],
    temperature: float = 0.2,
    max_tokens: int | None = None,
    timeout: int = 120,
) -> str:
    url, payload, headers = chat_request(settings, messages, temperature, False, max_tokens)
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            event = json.loads(response.read().decode("utf-8"))
            return event.get("choices", [{}])[0].get("message", {}).get("content", "")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"{chat_provider_label(settings)} returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach {chat_provider_label(settings)} at {url}: {exc.reason}") from exc


def extract_session_memory(settings: dict, messages: list[dict]) -> dict:
    transcript = "\n".join(
        f"{item.get('role', 'unknown').upper()}: {item.get('content', '')}"
        for item in messages[-120:]
        if item.get("content")
    )
    prompt = (
        "Summarize this chat session for long-term companion memory. Return strict JSON only with this shape:\n"
        "{\n"
        '  "session_summary": "short paragraph",\n'
        '  "user_memories": ["durable facts/preferences/relationship context about the user"],\n'
        '  "character_memories": ["durable facts or lore the character established about themselves"]\n'
        "}\n\n"
        "Only include durable memories that should matter in future conversations. Include character lore if the assistant made up facts about their own past, preferences, relationships, pets, places, or experiences.\n\n"
        f"Transcript:\n{transcript[-50000:]}"
    )
    try:
        raw = complete_chat(
            settings,
            [
                {"role": "system", "content": "You extract durable memory from chat transcripts and return valid JSON only."},
                {"role": "user", "content": prompt},
            ],
        )
        match = re.search(r"\{[\s\S]*\}", raw)
        data = json.loads(match.group(0) if match else raw)
        return {
            "session_summary": str(data.get("session_summary", "")).strip(),
            "user_memories": coerce_memory_list(data.get("user_memories", [])),
            "character_memories": coerce_memory_list(data.get("character_memories", [])),
        }
    except Exception:
        return {
            "session_summary": fallback_session_summary(messages),
            "user_memories": [],
            "character_memories": [],
        }


def coerce_memory_list(value) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def merge_memories(profile: dict, new_memories: list[str]) -> None:
    existing = [str(item).strip() for item in profile.get("memories", []) if str(item).strip()]
    seen = {item.lower() for item in existing}
    for item in new_memories:
        key = item.lower()
        if key not in seen:
            existing.append(item)
            seen.add(key)
    profile["memories"] = existing[-120:]


def fallback_session_summary(messages: list[dict]) -> str:
    user_count = sum(1 for item in messages if item.get("role") == "user")
    assistant_count = sum(1 for item in messages if item.get("role") == "assistant")
    last_user = next((item.get("content", "") for item in reversed(messages) if item.get("role") == "user"), "")
    if last_user:
        return f"Previous chat had {user_count} user turns and {assistant_count} character turns. The user's last message was: {last_user[:400]}"
    return f"Previous chat had {user_count} user turns and {assistant_count} character turns."


def openrouter_api_key(settings: dict) -> str:
    return os.getenv("OPENROUTER_API_KEY") or settings.get("openrouter_api_key") or ""


def openrouter_headers(settings: dict) -> dict:
    api_key = openrouter_api_key(settings)
    if not api_key:
        raise RuntimeError("Set OPENROUTER_API_KEY or add an OpenRouter key in Admin.")
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:8789",
        "X-Title": settings.get("app_title") or "VerityVoice",
    }


def cartesia_tts(settings: dict, text: str) -> bytes:
    api_key = os.getenv("CARTESIA_API_KEY") or settings.get("cartesia_api_key")
    if not api_key:
        raise RuntimeError("Set CARTESIA_API_KEY or add a Cartesia key in Admin.")
    text = strip_spoken_artifacts(normalize_pause_tags(text))

    payload = {
        "model_id": settings["cartesia_model_id"],
        "transcript": text,
        "voice": {"id": settings["cartesia_voice_id"]},
        "language": "en",
        "output_format": {
            "container": "mp3",
            "sample_rate": 44100,
            "bit_rate": 128000,
        },
        "generation_config": {"speed": 1, "volume": 1},
    }
    request = Request(
        "https://api.cartesia.ai/tts/bytes",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Cartesia-Version": settings["cartesia_version"],
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            return response.read()
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Cartesia returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach Cartesia: {exc.reason}") from exc


def cartesia_access_token(settings: dict) -> dict:
    api_key = os.getenv("CARTESIA_API_KEY") or settings.get("cartesia_api_key")
    if not api_key:
        raise RuntimeError("Set CARTESIA_API_KEY or add a Cartesia key in Admin.")

    payload = {"grants": {"tts": True, "stt": True}, "expires_in": 300}
    request = Request(
        "https://api.cartesia.ai/access-token",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Cartesia-Version": settings["cartesia_version"],
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
            return {"token": data["token"], "expires_in": int(data.get("expires_in", 300))}
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Cartesia token request returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach Cartesia token endpoint: {exc.reason}") from exc


if __name__ == "__main__":
    ensure_files()
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8789"))
    server = ThreadingHTTPServer((host, port), Handler)
    scheme = "http"
    cert_file = os.getenv("SSL_CERT_FILE")
    key_file = os.getenv("SSL_KEY_FILE")
    if cert_file and key_file:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    if sys.stdout:
        print(f"VerityVoice is ready at {scheme}://{host}:{port}")
    server.serve_forever()
