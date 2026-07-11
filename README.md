# VerityVoice

VerityVoice is a local-first AI companion chat app with text chat, a phone-style voice call mode, configurable character and user profiles, and persistent local memory.

The app can use LM Studio for local OpenAI-compatible chat models or OpenRouter for hosted chat models. Cartesia is currently used for both speech-to-text and text-to-speech. Users provide their own API keys in Admin or through environment variables.

Runtime conversations, settings, memories, avatars, and API keys are stored locally in `data/` and are intentionally excluded from Git.

## Features

- Streaming text chat with a thinking indicator while the character is replying.
- Phone-style Call mode with hands-free turn taking after the user clicks `Mic`.
- Cartesia streaming TTS and Cartesia Ink-2 mic transcription.
- User photo and character avatar uploads for chat and call views.
- Configurable user profile, character profile, system prompt, and long-term memory.
- LM Studio or OpenRouter chat completions configured in Admin.
- Local JSON storage for profiles, conversations, memories, and settings.
- Windows launcher for local, LAN, or private WireGuard access.

## Requirements

- Python 3.11 or newer.
- A chat model provider:
  - LM Studio with the OpenAI-compatible local server enabled, or
  - an OpenRouter API key and chat model.
- Optional for voice: Cartesia API key.
- A modern browser with microphone permission enabled for voice chat.

## Run Locally

1. Start LM Studio's local server, or have an OpenRouter API key ready.
2. If using LM Studio, load a model and note the exact model ID shown by LM Studio.
3. Start VerityVoice:

```powershell
python server.py
```

4. Open `http://127.0.0.1:8789`.
5. Open Admin and configure the app.

On first run, VerityVoice creates:

- `data/settings.json`
- `data/conversation.json`
- `data/chats/`

You can also copy `data/settings.example.json` to `data/settings.json` and customize it before launch.

## Windows Launcher

Double-click `Start-VerityVoice.bat`, or run:

```powershell
.\Start-VerityVoice.ps1
```

The launcher binds to all local interfaces so you can use:

- Server PC: `http://127.0.0.1:8789`
- LAN or WireGuard device: `http://YOUR-PC-IP:8789`

Use a private network such as WireGuard. Do not expose the app directly to the public internet.

## Admin Setup

Admin has three sections:

- User Settings: user name, profile details, notes, and user photo.
- Character Settings: character name, avatar, bio, system prompt, notes, and long-term memory/lore.
- Technical: LLM provider, LM Studio settings, OpenRouter settings, Cartesia voice settings, and context controls.

The default system prompt is intentionally thin:

```text
You are Verity, an intimate, romantic partner.
```

Users are expected to replace or expand the character system prompt in Admin.

## LLM Providers

For LM Studio:

- Choose `LM Studio` as the LLM provider.
- Set `LM Studio URL`, usually `http://127.0.0.1:1234/v1`.
- Set `LM Studio model` to the exact model ID loaded in LM Studio.

For OpenRouter:

- Choose `OpenRouter` as the LLM provider.
- Set `OpenRouter API URL`, usually `https://openrouter.ai/api/v1`.
- Add an `OpenRouter API key`.
- Set `OpenRouter chat model`, such as `openai/gpt-4.1-mini` or another model available to your account.

API keys can also be supplied with environment variables:

- `OPENROUTER_API_KEY`
- `CARTESIA_API_KEY`

## Voice

Voice uses Cartesia only for now:

- TTS: Cartesia streaming text-to-speech.
- STT: Cartesia Ink-2 mic transcription.

In Call mode, the user clicks `Mic` once to start voice chat. The mic and voice loop stay active until the user clicks `End`, even if they switch back to the Text tab or minimize the browser window.

## Private Data

The following are intentionally ignored by Git:

- `data/settings.json`
- `data/conversation.json`
- `data/chats/`
- `data/*.tmp`
- local audio and log files

Do not commit local runtime data. It may contain personal conversations, profile details, memories, avatar images, and API keys.

## Clean Testing

To test the first-run experience, stop the app and remove local runtime files from `data/`:

- `settings.json`
- `conversation.json`
- files inside `chats/`

Keep `data/settings.example.json` and `data/.gitkeep`.

## Release Prep Checklist

- Test a clean clone with no local `data/settings.json`.
- Confirm LM Studio setup works.
- Confirm OpenRouter setup works.
- Confirm Cartesia STT and TTS work.
- Add screenshots or a short demo video.
- Add a license before publishing a public release.
