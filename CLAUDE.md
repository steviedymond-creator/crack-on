# Crack On: notes for Claude Code

Crack On is a demo: plain HTML, CSS and JavaScript in the browser (index.html, app.js, style.css), a Node server using only built-in modules (server.js), and Supabase for conversation storage.

## Working rules

- Work only inside this folder, with each edit and command approved one at a time.
- Use .env.example for setting names. Keep .env and all keys out of every read, search and output.
- The owner runs the server and any script that calls a live service.
- Start with a read-only report, and show each edit before making it.
- Check syntax with node --check.
- Stage files by name only. Before a commit, show git diff --cached --stat and review the added lines. Commit only when asked.
- Log status codes and short reason codes only, never response bodies, keys, URLs or model reasoning.
- detectAddressedCompanion exists in both server.js and app.js. Keep the two in sync.

## Content rules

Code, comments, commit messages and repo text use Crack On branding, the five companions (Klimt, Edison, Nebius, Tavily, Auren), and the providers, services and model names already used in the code: Anthropic, NVIDIA, Nebius, Tavily, OpenAI, Supabase and ElevenLabs.
