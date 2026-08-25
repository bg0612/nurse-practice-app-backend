# Nursing AI Patient Dialogue Simulator API

The Express backend loads versioned cases, owns ephemeral active-session state,
generates patient replies and feedback through a replaceable LLM provider, and
synthesizes patient speech through a replaceable TTS provider. The dialogue and End endpoints share one
session registry, so accepted-turn counts, TTS reply binding, and the 30-turn cap
are enforced consistently. End freezes the authoritative transcript, generates
feedback, and immediately scrubs the server session.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

The default `PROVIDER_MODE=mock` is deterministic and makes no provider
network calls. It is suitable for local UI work and automated tests. Set
`PROVIDER_MODE=live` only after configuring both providers; live startup fails
fast when required values are missing or invalid.

The checked-in example temporarily selects OpenRouter for both services:

- `LLM_PROVIDER=openrouter`
- `TTS_PROVIDER=openrouter`
- `OPENROUTER_API_KEY` (one server-side key is shared by both adapters)
- `OPENROUTER_LLM_MODEL`
- `OPENROUTER_TTS_MODEL`, `OPENROUTER_TTS_VOICE`, and `OPENROUTER_TTS_FORMAT`
- optional `OPENROUTER_BASE_URL`, timeout, and TTS speed settings

The OpenRouter code is isolated in `src/clients/openRouterClient.js` and provider
composition. It uses `/chat/completions` for LLM calls and `/audio/speech` for
TTS. Its TTS voice and format settings override the Azure-specific voice values
in existing case files, so the case schema and application flow remain unchanged.

To switch the retained Azure path back on, use these Foundry settings:

- `LLM_PROVIDER=microsoft-foundry`
- `FOUNDRY_ENDPOINT`
- `FOUNDRY_DEPLOYMENT_NAME` for a Direct-from-Azure deployment
- `FOUNDRY_MODEL=DeepSeek-V4-Flash`
- `FOUNDRY_MODEL_VERSION=2026-04-23`
- `FOUNDRY_DEPLOYMENT_TYPE=pay-as-you-go`
- `FOUNDRY_AUTH_MODE=api-key|managed-identity`
- `FOUNDRY_API_KEY` when using API-key authentication
- optional `FOUNDRY_TIMEOUT_MS`

and these Azure Speech settings:

- `AZURE_SPEECH_ENDPOINT`
- `AZURE_SPEECH_AUTH_MODE=api-key|managed-identity`
- `AZURE_SPEECH_KEY` when using API-key authentication
- optional `AZURE_SPEECH_REGION`
- `AZURE_SPEECH_DEFAULT_FORMAT`
- optional `AZURE_SPEECH_TIMEOUT_MS`

Managed-identity hosting must inject narrow token-provider functions into the
provider composition. No identity SDK or credential is bundled into browser
code. `LLM_ENABLED` and `SPEECH_ENABLED` can disable a service deliberately.
Set `CORS_ORIGINS` to comma-separated explicit frontend origins; wildcards are
rejected.

Never commit `.env`, keys, access tokens, or real secret-bearing URLs. The
checked-in `.env.example` contains names and placeholders only.

## Privacy and external processing

Only the role-specific patient or assessment projection of CaseConfig is sent to
the selected LLM provider. Patient calls receive dialogue history; final feedback
receives the authoritative transcript once. Generated patient reply text is sent
to the selected TTS provider for synthesis. Browser speech
recognition handles student dictation; microphone audio is not sent to this API
by that path. No transcript is written to disk, browser storage, or a database.
After End finishes, the backend immediately deletes the entire session whether
feedback completed or returned a terminal unavailable result.

## Verification

```bash
npm test
```

Tests inject mock providers and do not require paid network calls.
