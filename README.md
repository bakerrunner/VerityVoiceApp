# VerityVoice

A local-first AI companion chat app with persistent memory, media sharing, voice call mode, hands-free mic flow, and optional API-backed image generation.

VerityVoice is designed to run on your own machine with LM Studio as the language model server. Runtime conversations, profile settings, memories, and API keys are stored locally in `data/` and are intentionally excluded from Git.

## Features

- Text chat with saved conversation history.
- Phone-style Call mode with hands-free turn taking after the user clicks `Mic`.
- Cartesia streaming TTS and optional Cartesia Ink-2 mic transcription.
- Browser speech-recognition fallback when Cartesia STT is disabled or unavailable.
- Local profile, character, memory, and conversation JSON storage.
- Optional OpenRouter image generation.
- Windows launcher for desktop, LAN, or WireGuard access.

## Requirements

- Python 3.11 or newer.
- LM Studio with the OpenAI-compatible local server enabled.
- A loaded chat model available at `http://127.0.0.1:1234/v1`.
- Optional: Cartesia API key for voice output and Ink-2 transcription.
- Optional: OpenRouter API key for image generation.

## Run Locally

1. Start LM Studio's local server.
2. Load a model and note the exact model ID shown by LM Studio.
3. Start VerityVoice:

```powershell
python server.py
```

4. Open `http://127.0.0.1:8790`.
5. Open Admin in the app and set the LM Studio model name.

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

- Server PC: `http://127.0.0.1:8790`
- LAN/WireGuard device: `http://YOUR-PC-IP:8790`

Use a private network such as WireGuard. Do not expose the app directly to the public internet.

## Voice

Voice output uses Cartesia when a Cartesia key is configured in Admin or through `CARTESIA_API_KEY`.

Mic transcription works in two modes:

- Cartesia Ink-2 when `Use Cartesia Ink-2 mic` is enabled.
- Browser speech recognition when Cartesia STT is disabled or unavailable.

In Call mode, the user clicks `Mic` once to start voice chat. The mic and voice loop stay active until the user clicks `End`, even if they switch back to the Text tab.

## Images

Image generation is configured for OpenRouter. Add an OpenRouter key in Admin or set `OPENROUTER_API_KEY`, then pick an image model or leave the model field blank to auto-select.

## Private Data

The following are intentionally ignored by Git:

- `data/settings.json`
- `data/conversation.json`
- `data/chats/`
- local generated audio and cache files

Do not commit local runtime data. It may contain personal conversations, profile details, embedded images, memories, and API keys.

## Release Prep Checklist

- Review default app name, profile, and character copy.
- Add screenshots or a short demo video.
- Add a license before publishing a public release.
- Test on a clean clone with no `data/settings.json`.
- Confirm voice works with both Cartesia STT and browser fallback.
