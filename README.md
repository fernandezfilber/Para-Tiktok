# Filber

Filber is a Spanish-language, troll-flavored AI chat demo built with React, Express, Prisma, and MySQL. It searches the web, stores chat history, accepts voice recordings for transcription, and offers WhatsApp phone verification after the anonymous free-message allowance.

## Deploy with existing MySQL, Redis, and Traefik containers

1. Copy `.env.example` to `.env` on the Docker host. Do not commit `.env`.
2. Set a unique `APP_SECRET` (at least 32 characters) and a fresh `GROQ_API_KEY`. The API key pasted into the original chat is exposed: revoke it with its provider and create a replacement.
3. Set `DATABASE_URL` to the existing Filber database and its least-privilege application user. The URL example uses the published MySQL port and `host.docker.internal`; URL-encode special characters in the credentials.
4. Set `REDIS_URL` using the existing Redis password. URL-encode special characters in the password. Redis stores the shared rate limits for chat, login, and OTP routes.
5. Set `DOCKER_NETWORK` to the Docker network Traefik shares with the app. The provided `bridge` default works with the default bridge network. MySQL and Redis use their published host ports via `host.docker.internal`; their ports must not be exposed publicly.
6. Ensure the existing Traefik instance has Docker discovery enabled, `web` and `websecure` entrypoints, and a certificate resolver matching `TRAEFIK_CERT_RESOLVER`. Configure its ACME account email in Traefik's own static configuration; the Filber container cannot change an already-running Traefik instance. Point the domain's DNS A/AAAA records at the server.
7. Ensure the MySQL application user can run Prisma migrations (create/alter/index tables) as well as read and write application data.
8. Optionally set `TAVILY_API_KEY` for richer web search. Without it, Filber uses DuckDuckGo Instant Answers, which may return fewer sources.
9. Configure WhatsApp Cloud API credentials and an approved `filber_otp` message template before enabling phone verification. The template must include one body text parameter for the code. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_OTP_TEMPLATE`.
10. `CONTACT_WHATSAPP` is prefilled with the support number supplied for suggestions; it must use international digits-only format. Change it if that number is not the intended public contact.
11. Run `docker compose up --build -d`, then visit `https://filber.tech`.

Compose does not create, migrate, or delete the existing MySQL/Redis containers. On startup, the app runs checked-in Prisma migrations against the existing MySQL database. Ensure the database exists and is backed up first.

## Local development

With MySQL and Redis available, copy `.env.example` to `.env`, set `DATABASE_URL` and `REDIS_URL` to reachable services, and run:

```sh
npm install
npx prisma migrate deploy
npm run server
npm run dev
```

Vite serves the React client and proxies `/api` to Express. The production Docker image serves both through Express on port 3001.

## Product and privacy notes

- Login by username alone is intentionally an anonymous demo profile, not secure authentication: anyone who loses the browser session cannot recover it, and a username is not proof of identity. WhatsApp verification binds a number to the active profile.
- New profiles have 50 AI messages. Verified profiles are limited to 30 messages per UTC day to control abuse and provider cost.
- User messages, assistant responses, source links, consent timestamps, and a verified phone number are stored in MySQL. Users can delete their profile and associated chat data in the app.
- Consent text is a starter summary, not legal advice or a substitute for reviewed terms/privacy disclosures. Adapt it to your service, retention policy, and local law before public launch.
- Audio is held in memory only for transcription and is not saved; its transcription is stored as the user's chat message.
- Never commit `.env`. For a public deployment, terminate TLS at a reverse proxy, use strong unique database credentials, configure backups and retention, and use a persistent rate-limit store.
