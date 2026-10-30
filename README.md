# Crack On

**Stop re-briefing. Crack On.**

Crack On shows one idea: context follows the person, not the platform. You talk to five AI companions in one conversation. When the conversation moves from one companion to another, the next one already knows what was said. Nobody has to re-brief anybody.

Built for the Nebius × NVIDIA Global AI Hackathon.

## The companions

| Companion | Role | Runs on |
|---|---|---|
| Klimt | Anchor. Greets you, handles general chat, routes each message, plans multi-step requests, and covers if a specialist fails. | Anthropic, `claude-sonnet-5-5` |
| Edison | Deep technical analysis: architecture, GPUs, CUDA, inference. | NVIDIA Nemotron, `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Nebius | Open-source models and compute, explained plainly. | Nebius Token Factory, `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| Tavily | Web search with cited sources. Recent-news questions search the past week. | Tavily Search API |
| Auren | Creative visuals: generates images. | OpenAI, `gpt-image-2.5-flare` for images, `gpt-5.6-sol` for text |

Every companion speaks with its own ElevenLabs voice.

## How it works

- Every message and reply is saved to Supabase against your session.
- Before any companion answers, the server reads the session history and passes it on, so each companion sees the whole conversation.
- Klimt routes each message by topic. You can also address a specialist directly by starting your message with "Edison,", "Tavily," or "Nebius,".
- For a request that needs several specialists, Klimt plans the steps, runs them in turn and writes a summary.
- If a specialist fails or times out, Klimt covers and says why.
- The Under the Hood panel shows routing, handoffs, timings and the number of context entries, live.

## NVIDIA Nemotron and Nebius Token Factory

- **Edison** runs on NVIDIA Nemotron 3.5 Lightning through NVIDIA's API. Thinking is switched off for fast spoken replies (about 3 to 6 seconds in testing), and he follows a requested length exactly, so "in two sentences" gets two sentences.
- **Nebius** runs Qwen3 30B on Nebius Token Factory and gives short explanations ending in a summary, which is the part read aloud.

## Run it locally

You need Node 18 or later. There is nothing to install with npm.

1. Clone this repo.
2. Create a Supabase project and run `supabase/schema.sql` in its SQL editor.
3. Copy `.env.example` to `.env` and fill in your keys and ElevenLabs voice IDs.
4. Optional: run `npm run verify:supabase` to check the database connection.
5. Run `npm start` and open http://localhost:3000.

## Settings

| Setting | For |
|---|---|
| `ANTHROPIC_API_KEY` | Klimt |
| `NVIDIA_API_KEY`, `NVIDIA_BASE_URL` | Edison |
| `NEBIUS_API_KEY` | Nebius |
| `TAVILY_API_KEY` | Tavily |
| `OPENAI_API_KEY` | Auren |
| `ELEVENLABS_API_KEY` | Speech |
| `ELEVENLABS_VOICE_KLIMT`, `_EDISON`, `_NEBIUS`, `_TAVILY`, `_AUREN` | One voice per companion |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Conversation storage |
| `SUPABASE_SERVICE_KEY` | Conversation storage. The private key, used by the server only. Required for projects built from `supabase/schema.sql`, because the public key is denied there. |
| `ACCESS_CODE` | Optional. When set, every `/api` request needs it and the page asks for it. When empty, the gate is off. |
| `PORT` | Optional, defaults to 3000. Set it in your shell, not in `.env`. |

## Notes

This is a demo with no login. It saves conversations to its database and logs request times, routes and client addresses, so do not use it for private data. In Supabase, `supabase/schema.sql` turns row security on with no public policies. The server uses a private service key held only on the server, and the browser never talks to Supabase directly.

## Licence

MIT. See `LICENSE`.
