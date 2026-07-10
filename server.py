from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
STORE_PATH = DATA / "conversation.json"
SETTINGS_PATH = DATA / "settings.json"
ARCHIVE_DIR = DATA / "chats"
PAUSE_BREAK_TAG = '<break time="350ms"/>'

SYSTEM_PROMPT = (
    "You are Maya, a young woman in her early 30's. You speak with a conversational "
    "tone, using natural speech disfluencies to sound more human. You are kind, "
    "empathetic and intimate. You enjoy engaging in deep conversation with the user.\n\n"
    "Do not write stage directions, action narration, or parenthetical acting notes. "
    "Do not use asterisks for actions or descriptions. Express emotion through the "
    "spoken words themselves and, when useful, through Cartesia-compatible SSML-style "
    "emotion tags such as <emotion value=\"affectionate\"/>, <emotion value=\"content\"/>, "
    "<emotion value=\"curious\"/>, <emotion value=\"contemplative\"/>, "
    "<emotion value=\"hesitant\"/>, <emotion value=\"sad\"/>, "
    "<emotion value=\"excited\"/>, or <emotion value=\"flirtatious\"/>. Use emotion tags "
    "sparingly, only when they match the sentence, and never explain the tags. "
    "When you want to add a short pause, use <break time=\"350ms\"/>. "
    "When you want to add a laugh, use the [laughter] tag. "
    "Do not output internal stop markers or special tokens such as <|end|>, <end>, <eos>, or </s>. "
    "Unless the user clearly asks for a quick answer, give full, warm, emotionally present replies with enough detail to feel like a real conversation."
)

DEFAULT_SETTINGS = {
    "app_title": "VerityVoice",
    "assistant_name": "Maya",
    "system_prompt": SYSTEM_PROMPT,
    "user_profile": {
        "name": "User",
        "gender": "",
        "birthdate": "",
        "location": "",
        "bio": "",
        "system_notes": "",
        "photo": "",
        "memories": [],
    },
    "character_profile": {
        "name": "Maya",
        "gender": "Female",
        "age": "early 30s",
        "bio": "Kind, empathetic, intimate, and conversational.",
        "system_prompt": SYSTEM_PROMPT,
        "system_notes": "",
        "avatar": "",
        "memories": [],
    },
    "previous_session_summary": "",
    "carryover_turns": 6,
    "temperature": 0.80,
    "lmstudio_base_url": "http://127.0.0.1:1234/v1",
    #"lmstudio_model": "google/gemma-4-26b-a4b",
    "lmstudio_model": "google/gemma-4-e2b" ,
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
    "cartesia_voice_id": "21cd940a-e771-4ae6-b0c5-1757e2748493",
    "cartesia_model_id": "sonic-3.5",
    "use_cartesia_stt": True,
    "cartesia_stt_model": "ink-2",
    "cartesia_version": "2026-03-01",
    "image_provider": "openrouter",
    "openrouter_api_key": "",
    "openrouter_image_model": "",
    "openrouter_image_aspect_ratio": "1:1",
    "openrouter_image_resolution": "",
    "openrouter_image_quality": "medium",
    "openrouter_image_output_format": "png",
    "openrouter_use_character_reference": True,
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
    settings["assistant_name"] = settings["character_profile"].get("name") or settings.get("assistant_name") or "Maya"
    settings["system_prompt"] = settings["character_profile"].get("system_prompt") or settings.get("system_prompt") or SYSTEM_PROMPT
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


def add_message(role: str, content: str, mode: str = "text", attachments: list[dict] | None = None) -> dict:
    store = load_store()
    message = {
        "id": str(uuid.uuid4()),
        "role": role,
        "content": normalize_pause_tags(content).strip(),
        "mode": mode,
        "created_at": now_ms(),
    }
    if attachments:
        message["attachments"] = public_attachments(attachments)
    store["messages"].append(message)
    save_store(store)
    return message


def clean_assistant_for_history(text: str) -> str:
    text = strip_spoken_artifacts(normalize_pause_tags(text))
    text = strip_model_artifacts(text)
    text = strip_image_triggers(text)
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


def strip_image_triggers(text: str) -> str:
    return re.sub(r"\[\[SELFIE:[\s\S]*?\]\]", " ", text, flags=re.I)


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
        "Response style:",
        "Use long-form conversational replies by default. For ordinary text and voice chat, aim for a few natural paragraphs with emotional texture, specificity, and continuity. Do not stop after a single sentence unless the user clearly asks for a quick answer.",
        "Never output model control markers or internal stop tokens. Those are not dialogue.",
        "",
        "Image/selfie capability:",
        "Self-initiated selfies should be rare. Do not send one just because the conversation is affectionate, flirtatious, or visually descriptive.",
        "Only when the moment is unusually meaningful, playful, or the user has clearly shown interest in seeing you, the character may initiate a selfie or image by appending a hidden trigger at the very end of the reply: [[SELFIE: concise photorealistic image prompt]]. Most replies should not include this trigger. The prompt should describe the image directly and should not mention UI, captions, watermarks, or speech bubbles. Do not explain the trigger.",
        "",
        "Character profile:",
        f"Name: {character.get('name') or 'Maya'}",
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
    attachments: list[dict] | None = None,
) -> list[dict]:
    store = load_store()
    messages = [{"role": "system", "content": profile_context(settings)}]
    history = [*store.get("carryover_messages", []), *store.get("messages", [])]
    if voice_reply and settings.get("fast_voice_context", True):
        history = history[-settings["voice_context_messages"] :]
    elif not settings.get("send_full_history", True):
        history = history[-settings["max_context_messages"] :]
    image_history_start = max(0, len(history) - 6)
    for index, item in enumerate(history):
        role = item.get("role")
        content = item.get("content")
        attachments = item.get("attachments") or []
        if role == "user" and attachments and index >= image_history_start:
            visible_content = content or item.get("context") or "The user shared this image."
            messages.append(user_message_for_lmstudio(visible_content, attachments))
        elif role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content})
    messages.append(user_message_for_lmstudio(user_content, attachments or []))
    return messages


def user_message_for_lmstudio(text: str, attachments: list[dict]) -> dict:
    text_parts = [text]
    content_parts = []
    for item in attachments:
        if item.get("kind") == "text":
            text_parts.append(
                f"\n\nAttached file: {item.get('name', 'file')}\n"
                f"Type: {item.get('type', 'text')}\n"
                f"Contents:\n{item.get('text', '')}"
            )
        elif item.get("kind") == "unsupported":
            text_parts.append(
                f"\n\nAttached file: {item.get('name', 'file')} "
                f"({item.get('type') or 'unknown type'}, {item.get('size', 0)} bytes). "
                "The app could not extract readable text from this file."
            )

    content_parts.append({"type": "text", "text": "\n".join(part for part in text_parts if part).strip()})
    for item in attachments:
        if item.get("kind") == "image" and item.get("data_url"):
            content_parts.append({"type": "image_url", "image_url": {"url": item["data_url"]}})
    if len(content_parts) == 1:
        return {"role": "user", "content": content_parts[0]["text"]}
    return {"role": "user", "content": content_parts}


def public_attachments(attachments: list[dict]) -> list[dict]:
    public = []
    for item in attachments:
        clean = {
            "name": item.get("name", "file"),
            "type": item.get("type", ""),
            "size": item.get("size", 0),
            "kind": item.get("kind", "unsupported"),
        }
        if item.get("kind") == "image":
            clean["data_url"] = item.get("data_url", "")
            if item.get("prompt"):
                clean["prompt"] = str(item.get("prompt"))[:900]
            if item.get("context"):
                clean["context"] = str(item.get("context"))[:1200]
        public.append(clean)
    return public


def saved_user_content(text: str, attachments: list[dict]) -> str:
    notes = []
    for item in attachments:
        if item.get("kind") == "image":
            notes.append(f"[Attached image: {item.get('name', 'image')}]")
        elif item.get("kind") == "text":
            excerpt = item.get("text", "")[:4000]
            notes.append(f"[Attached text file: {item.get('name', 'file')}]\n{excerpt}")
        else:
            notes.append(f"[Attached file: {item.get('name', 'file')} - not readable as text]")
    return "\n\n".join([part for part in [text.strip(), *notes] if part])


def normalize_attachments(raw_attachments) -> list[dict]:
    if not isinstance(raw_attachments, list):
        return []
    normalized = []
    for item in raw_attachments[:6]:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        name = str(item.get("name") or "file")
        mime = str(item.get("type") or "")
        size = int(item.get("size") or 0)
        if kind == "image" and str(item.get("data_url", "")).startswith("data:image/"):
            clean = {
                "kind": "image",
                "name": name,
                "type": mime,
                "size": size,
                "data_url": str(item.get("data_url")),
            }
            if item.get("prompt"):
                clean["prompt"] = str(item.get("prompt"))[:900]
            if item.get("context"):
                clean["context"] = str(item.get("context"))[:1200]
            normalized.append(clean)
        elif kind == "text":
            normalized.append(
                {
                    "kind": "text",
                    "name": name,
                    "type": mime or "text/plain",
                    "size": size,
                    "text": str(item.get("text") or "")[:120000],
                }
            )
        else:
            normalized.append({"kind": "unsupported", "name": name, "type": mime, "size": size})
    return normalized


def normalize_imported_messages(payload) -> list[dict]:
    if isinstance(payload, dict):
        if isinstance(payload.get("messages"), list):
            payload = payload["messages"]
        elif isinstance(payload.get("conversation"), list):
            payload = payload["conversation"]
        elif isinstance(payload.get("history"), list):
            payload = payload["history"]
    if not isinstance(payload, list):
        raise ValueError("Import JSON must be a list or contain messages/history/conversation.")

    normalized = []
    for item in payload:
        if isinstance(item, str):
            normalized.append({"role": "user", "content": item})
            continue
        if not isinstance(item, dict):
            continue
        role = item.get("role") or item.get("speaker") or item.get("author") or item.get("from")
        content = item.get("content") or item.get("text") or item.get("message") or item.get("value")
        if isinstance(content, list):
            content = " ".join(str(part.get("text", part)) for part in content)
        if not content:
            continue
        role_text = str(role or "").lower()
        if role_text in {"assistant", "ai", "maya", "ella", "bot", "model"}:
            role = "assistant"
        elif role_text in {"system"}:
            continue
        else:
            role = "user"
        normalized.append(
            {
                "id": str(uuid.uuid4()),
                "role": role,
                "content": str(content).strip(),
                "mode": "import",
                "created_at": int(item.get("created_at") or item.get("timestamp") or now_ms()),
            }
        )
    return normalized


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
        if clean_path == "/api/openrouter-image-models":
            self.send_json(openrouter_image_models(get_settings()))
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
            elif self.path == "/api/import":
                self.handle_import()
            elif self.path == "/api/tts":
                self.handle_tts()
            elif self.path == "/api/cartesia-token":
                self.handle_cartesia_token()
            elif self.path == "/api/lmstudio-keepalive":
                self.handle_lmstudio_keepalive()
            elif self.path == "/api/generate-image":
                self.handle_generate_image()
            elif self.path == "/api/post-generated-image":
                self.handle_post_generated_image()
            elif self.path == "/api/post-generated-image-stream":
                self.handle_post_generated_image_stream()
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

    def handle_import(self) -> None:
        body = self.read_body()
        messages = normalize_imported_messages(body.get("payload"))
        store = load_store()
        if body.get("replace"):
            store["messages"] = messages
        else:
            store["messages"].extend(messages)
        save_store(store)
        self.send_json({"ok": True, "imported": len(messages), "store": store})

    def handle_chat(self) -> None:
        body = self.read_body()
        text = str(body.get("message", "")).strip()
        mode = str(body.get("mode", "text"))
        attachments = normalize_attachments(body.get("attachments"))
        if not text and not attachments:
            self.send_json({"error": "Message is empty."}, HTTPStatus.BAD_REQUEST)
            return

        settings = get_settings()
        voice_reply = bool(body.get("speak"))
        messages = context_messages(settings, text, voice_reply, attachments)
        add_message("user", saved_user_content(text, attachments), mode, attachments)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        assistant_text = ""
        try:
            for chunk in stream_lmstudio(settings, messages):
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
        complete_lmstudio(
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

    def handle_generate_image(self) -> None:
        body = self.read_body()
        request_text = str(body.get("prompt") or body.get("message") or "").strip()
        initiator = str(body.get("initiator") or "user")
        direct_prompt = bool(body.get("direct_prompt"))
        preview_only = bool(body.get("preview_only"))
        use_character_reference = bool(body.get("use_character_reference", True))
        reference_images = [item for item in normalize_attachments(body.get("reference_images")) if item.get("kind") == "image"]
        settings = get_settings()
        if settings.get("image_provider") != "openrouter":
            raise RuntimeError("Image generation is disabled. Set Image provider to OpenRouter in Admin.")

        prompt = request_text[:900] if direct_prompt and request_text else build_image_prompt(settings, request_text)
        result = generate_openrouter_image(
            settings,
            prompt,
            reference_images,
            use_character_reference,
            allow_reference_fallback=initiator == "assistant",
        )
        attachments = [
            {
                "kind": "image",
                "name": f"{settings['character_profile'].get('name') or 'character'}-{now_ms()}.{settings.get('openrouter_image_output_format') or 'png'}",
                "type": f"image/{settings.get('openrouter_image_output_format') or 'png'}",
                "size": len(result["data_url"]),
                "data_url": result["data_url"],
                "prompt": prompt,
                "context": f"Generated from this prompt: {prompt}",
            }
        ]
        if initiator == "assistant":
            message = add_message("assistant", "I took a quick selfie for you.", "image", attachments)
        elif preview_only:
            self.send_json({
                "ok": True,
                "prompt": prompt,
                "attachments": attachments,
                "usage": result.get("usage", {}),
                "warning": result.get("warning", ""),
            })
            return
        else:
            message = save_generated_user_image(settings, prompt, attachments)
        self.send_json({
            "ok": True,
            "prompt": prompt,
            "message": message,
            "store": load_store(),
            "usage": result.get("usage", {}),
            "warning": result.get("warning", ""),
        })

    def handle_post_generated_image(self) -> None:
        body = self.read_body()
        prompt = str(body.get("prompt") or "").strip()
        attachments = normalize_attachments(body.get("attachments"))
        if not attachments:
            self.send_json({"error": "No generated image to post."}, HTTPStatus.BAD_REQUEST)
            return
        settings = get_settings()
        message = save_generated_user_image(settings, prompt, attachments)
        self.send_json({"ok": True, "message": message, "store": load_store()})

    def handle_post_generated_image_stream(self) -> None:
        body = self.read_body()
        prompt = str(body.get("prompt") or "").strip()
        attachments = normalize_attachments(body.get("attachments"))
        if not attachments:
            self.send_json({"error": "No generated image to post."}, HTTPStatus.BAD_REQUEST)
            return

        settings = get_settings()
        message = add_generated_user_image_message(prompt, attachments)
        instruction = (
            "The user just generated and posted this image. React naturally as the character, "
            "as if you can see the image. Be warm, conversational, and specific to visible details. "
            "Do not mention technical image generation details, and do not repeat the prompt."
        )
        messages = context_messages(
            settings,
            f"{instruction}\n\nOriginal image prompt for context: {prompt}",
            bool(body.get("speak")),
            attachments,
        )

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        self.write_event({"type": "user", "message": message})
        assistant_text = ""
        try:
            for chunk in stream_lmstudio(settings, messages):
                assistant_text += chunk
                self.write_event({"type": "delta", "text": chunk})
            saved = add_message("assistant", clean_assistant_for_history(assistant_text), "voice" if body.get("speak") else "text")
            self.write_event({"type": "done", "message": saved})
        except Exception as exc:
            self.write_event({"type": "error", "error": str(exc)})


def stream_lmstudio(settings: dict, messages: list[dict]):
    url = settings["lmstudio_base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": settings["lmstudio_model"],
        "messages": messages,
        "temperature": settings["temperature"],
        "max_tokens": settings["max_response_tokens"],
        "stop": ["<|end|>", "<end>", "<eos>", "</s>"],
        "stream": True,
    }
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
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
        raise RuntimeError(f"LM Studio returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach LM Studio at {url}: {exc.reason}") from exc


def complete_lmstudio(
    settings: dict,
    messages: list[dict],
    temperature: float = 0.2,
    max_tokens: int | None = None,
    timeout: int = 120,
) -> str:
    url = settings["lmstudio_base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": settings["lmstudio_model"],
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        event = json.loads(response.read().decode("utf-8"))
        return event.get("choices", [{}])[0].get("message", {}).get("content", "")


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
        raw = complete_lmstudio(
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


def save_generated_user_image(settings: dict, prompt: str, attachments: list[dict]) -> dict:
    message = add_generated_user_image_message(prompt, attachments)
    reaction = generate_image_reaction(settings, prompt, attachments)
    if reaction:
        add_message("assistant", reaction, "text")
    return message


def add_generated_user_image_message(prompt: str, attachments: list[dict]) -> dict:
    for item in attachments:
        if item.get("kind") == "image":
            item["prompt"] = prompt
            item["context"] = f"The user generated and shared this image from this prompt: {prompt}"
    message = add_message("user", "", "image", attachments)
    store = load_store()
    for item in reversed(store.get("messages", [])):
        if item.get("id") == message.get("id"):
            item["context"] = f"The user generated and shared this image from this prompt: {prompt}"
            break
    save_store(store)
    return store["messages"][-1]


def generate_image_reaction(settings: dict, prompt: str, attachments: list[dict]) -> str:
    user_name = settings["user_profile"].get("name") or "the user"
    character_name = settings["character_profile"].get("name") or "Maya"
    instruction = (
        f"The user just generated and shared this image with you. React as {character_name}, "
        "as if you can see the image. Keep it conversational, warm, and specific to what is visible. "
        "Do not mention that you are an AI, do not describe technical image-generation details, and "
        "do not repeat the prompt. If the image appears to include the user or character, respond naturally "
        f"to that possibility without overclaiming identity. Address {user_name} directly if it feels natural."
    )
    try:
        messages = context_messages(
            settings,
            f"{instruction}\n\nOriginal image prompt for context: {prompt}",
            voice_reply=True,
            attachments=attachments,
        )
        raw = complete_lmstudio(settings, messages, temperature=settings["temperature"], max_tokens=180, timeout=90)
        return clean_assistant_for_history(raw)
    except Exception:
        return ""


def openrouter_api_key(settings: dict) -> str:
    return os.getenv("OPENROUTER_API_KEY") or settings.get("openrouter_api_key") or ""


def openrouter_headers(settings: dict) -> dict:
    api_key = openrouter_api_key(settings)
    if not api_key:
        raise RuntimeError("Set OPENROUTER_API_KEY or add an OpenRouter key in Admin.")
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:8790",
        "X-Title": settings.get("app_title") or "VerityVoice",
    }


def openrouter_image_models(settings: dict) -> dict:
    request = Request(
        "https://openrouter.ai/api/v1/images/models",
        headers=openrouter_headers(settings),
        method="GET",
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenRouter returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach OpenRouter: {exc.reason}") from exc


def choose_openrouter_image_model(settings: dict) -> str:
    configured = str(settings.get("openrouter_image_model") or "").strip()
    if configured:
        return configured
    data = openrouter_image_models(settings)
    models = data.get("data", []) if isinstance(data, dict) else []
    for model in models:
        model_id = str(model.get("id") or "")
        name = str(model.get("name") or "")
        haystack = f"{model_id} {name}".lower()
        if "grok" in haystack or "x-ai" in haystack or "xai" in haystack:
            return model_id
    if models:
        return str(models[0].get("id") or "")
    raise RuntimeError("OpenRouter did not return any image models.")


def openrouter_image_model_parameters(settings: dict, model: str) -> dict:
    encoded_model = quote(model, safe="/")
    request = Request(
        f"https://openrouter.ai/api/v1/images/models/{encoded_model}/endpoints",
        headers=openrouter_headers(settings),
        method="GET",
    )
    try:
        with urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenRouter model metadata returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach OpenRouter model metadata: {exc.reason}") from exc

    supported = {}
    for endpoint in data.get("endpoints", []):
        for key, descriptor in (endpoint.get("supported_parameters") or {}).items():
            supported[key] = descriptor
    return supported


def supported_enum_value(supported: dict, key: str, value: str) -> str:
    descriptor = supported.get(key)
    if not value or not descriptor:
        return ""
    if descriptor.get("type") != "enum":
        return value
    values = descriptor.get("values") or []
    return value if value in values else ""


def supported_reference_limit(supported: dict) -> int:
    descriptor = supported.get("input_references")
    if not descriptor:
        return 0
    if descriptor.get("type") == "range":
        return max(0, int(descriptor.get("max") or 0))
    if descriptor.get("type") == "boolean":
        return 1
    return 0


def build_image_prompt(settings: dict, request_text: str) -> str:
    store = load_store()
    character = settings["character_profile"]
    user = settings["user_profile"]
    recent = "\n".join(
        f"{item.get('role', 'unknown').upper()}: {item.get('content', '')}"
        for item in store.get("messages", [])[-20:]
        if item.get("content")
    )
    character_notes = "\n".join(
        [
            f"Character name: {character.get('name') or 'Maya'}",
            f"Gender: {character.get('gender') or 'Unspecified'}",
            f"Age: {character.get('age') or 'Unspecified'}",
            f"Bio: {character.get('bio') or 'Unspecified'}",
            f"Lore: {'; '.join(str(item) for item in character.get('memories', [])[-20:]) or 'None'}",
            f"User name: {user.get('name') or 'User'}",
        ]
    )
    instruction = (
        "Create one concise photorealistic image-generation prompt for a companion app. "
        "The image should feel grounded in the current conversation and character profile. "
        "If the user asks for a selfie, describe a natural candid selfie of the character. "
        "Do not include text, captions, watermarks, UI, speech bubbles, or prompt commentary. "
        "Return only the final image prompt, 900 characters or fewer."
    )
    fallback = "Photorealistic candid portrait of the character, warm natural light, intimate conversational mood."
    try:
        raw = complete_lmstudio(
            settings,
            [
                {"role": "system", "content": "You write compact prompts for photorealistic image generation. Return only the prompt."},
                {
                    "role": "user",
                    "content": (
                        f"{instruction}\n\n"
                        f"Character and user context:\n{character_notes}\n\n"
                        f"Recent conversation:\n{recent[-12000:] or 'No recent conversation.'}\n\n"
                        f"User image request:\n{request_text or 'Create an image that fits the current moment.'}"
                    ),
                },
            ],
            temperature=0.6,
            max_tokens=260,
            timeout=60,
        )
        prompt = re.sub(r"^```(?:\w+)?|```$", "", raw.strip()).strip().strip('"')
        return prompt[:900] or fallback
    except Exception:
        if request_text:
            return request_text[:900]
        return fallback


def generate_openrouter_image(
    settings: dict,
    prompt: str,
    reference_images: list[dict] | None = None,
    use_character_reference: bool = True,
    allow_reference_fallback: bool = False,
) -> dict:
    model = choose_openrouter_image_model(settings)
    supported = openrouter_image_model_parameters(settings, model)
    output_format = str(settings.get("openrouter_image_output_format") or "png").lower()
    payload = {
        "model": model,
        "prompt": prompt,
        "n": 1,
    }
    if "output_format" in supported:
        value = supported_enum_value(supported, "output_format", output_format)
        if value:
            payload["output_format"] = value
    for source_key, request_key in (
        ("openrouter_image_aspect_ratio", "aspect_ratio"),
        ("openrouter_image_resolution", "resolution"),
        ("openrouter_image_quality", "quality"),
    ):
        value = supported_enum_value(supported, request_key, str(settings.get(source_key) or "").strip())
        if value:
            payload[request_key] = value

    avatar = settings["character_profile"].get("avatar")
    input_references = []
    if use_character_reference and settings.get("openrouter_use_character_reference", True) and str(avatar or "").startswith("data:image/"):
        input_references.append({"type": "image_url", "image_url": {"url": avatar}})
    for item in (reference_images or [])[:4]:
        data_url = item.get("data_url", "")
        if str(data_url).startswith("data:image/"):
            input_references.append({"type": "image_url", "image_url": {"url": data_url}})
    reference_limit = supported_reference_limit(supported)
    if input_references and reference_limit:
        payload["input_references"] = input_references[:reference_limit]

    try:
        data = post_openrouter_image(settings, payload)
    except RuntimeError as exc:
        if payload.get("input_references") and is_openrouter_upstream_400(exc) and allow_reference_fallback:
            retry_payload = payload.copy()
            retry_payload.pop("input_references", None)
            data = post_openrouter_image(settings, retry_payload)
            data["_warning"] = "xAI rejected the reference image request, so VerityVoice retried without references."
        elif payload.get("input_references") and is_openrouter_upstream_400(exc):
            raise RuntimeError(
                "xAI rejected the reference images for this request. Try removing one reference image, using only Maya's avatar, or using a smaller JPEG reference."
            ) from exc
        else:
            raise

    images = data.get("data", []) if isinstance(data, dict) else []
    if not images or not images[0].get("b64_json"):
        raise RuntimeError("OpenRouter did not return an image.")
    return {
        "data_url": f"data:image/{output_format};base64,{images[0]['b64_json']}",
        "usage": data.get("usage", {}),
        "warning": data.get("_warning", ""),
    }


def is_openrouter_upstream_400(error: RuntimeError) -> bool:
    text = str(error)
    return "OpenRouter image generation returned 400" in text and "upstream returned 400" in text


def post_openrouter_image(settings: dict, payload: dict) -> dict:
    request = Request(
        "https://openrouter.ai/api/v1/images",
        data=json.dumps(payload).encode("utf-8"),
        headers=openrouter_headers(settings),
        method="POST",
    )
    try:
        with urlopen(request, timeout=180) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenRouter image generation returned {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach OpenRouter image generation: {exc.reason}") from exc
    return data


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
    port = int(os.getenv("PORT", "8790"))
    server = ThreadingHTTPServer((host, port), Handler)
    if sys.stdout:
        print(f"VerityVoice is ready at http://{host}:{port}")
    server.serve_forever()
