# Blue Standup Bot

Microsoft Teams bot that sends weekday standup reminder DMs. Configuration is **per team**, managed in a **channel tab** — anyone on the team can create and edit standups (no installer/owner gate). Multiple standups per team are supported.

Repo: [ProcessMaker/blue-standup-bot](https://github.com/ProcessMaker/blue-standup-bot)

## Features

- Team-only Teams app (sideload zip)
- Configurable channel tab (Fluent UI React) hosted on GitHub Pages
- Multiple standups per team (name, UTC time, message, users, enabled)
- Timer (every minute) DMs configured users on weekdays at the configured UTC time
- Azure Functions (TypeScript) + Azure SQL
- Tab calls Functions with Teams `getAuthToken` Bearer JWT (validated server-side)

## Prerequisites

- Node.js 20+
- Azure CLI (`az`) logged in
- [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/developer/azure-functions/functions-core-tools-overview) v4
- [direnv](https://direnv.net/) (optional, for `.envrc`)
- `sqlcmd` **or** Python `pyodbc` + ODBC Driver 18 (for schema apply during provision)
- GitHub repo with Pages + Actions enabled (for the tab)

## Quick start

```bash
# 1. Provision Azure resources (idempotent)
./infra/provision.sh

# 2. Load env
direnv allow   # or: source .envrc

# 3. Install & build Functions
npm install
npm run build
npm run apply-schema

# 4. Deploy function code
func azure functionapp publish "$AZURE_FUNCTION_APP"

# 5. Deploy tab (GitHub Action) — set repo Variables:
#    VITE_API_BASE_URL=https://<function-app>.azurewebsites.net
#    VITE_TEAMS_APP_RESOURCE=api://processmaker.github.io/botid-<MicrosoftAppId>
# Then push to main (or run "Deploy tab to GitHub Pages" manually).

# 6. Package and sideload the Teams app
npm run package:teams
npm run validate:teams
# In Teams: Manage team → Apps → Upload a custom app → blue-standup-bot.zip
```

After install, open a channel → **+** → add **Blue Standup Bot** / **Standups** tab → Save. Configure standups in that tab.

## Local development

### Functions API / bot

```bash
cp local.settings.json.example local.settings.json
# Fill MicrosoftApp* / SQL_CONNECTION_STRING / TAB_ORIGIN

npm install
npm start
```

Point the Azure Bot messaging endpoint at a public tunnel ending in `/api/messages`.

### Tab (Fluent UI)

```bash
cd tab
cp .env.example .env
# Set VITE_API_BASE_URL (tunnel or Azure Function URL)
# Set VITE_TEAMS_APP_RESOURCE=api://processmaker.github.io/botid-<appId>
# (local: api://localhost:5173/botid-<appId> — also add that URI in Entra)
npm install
npm run dev
```

Tab URLs (production Pages):

- Content: `https://processmaker.github.io/blue-standup-bot/#/`
- Config: `https://processmaker.github.io/blue-standup-bot/#/config`

## Architecture

| Piece | Role |
|--------|------|
| `src/functions/messages.ts` | Bot Framework HTTP endpoint |
| `src/functions/notify.ts` | Timer trigger (every minute) |
| `src/functions/api.ts` | Standup CRUD (JWT + CORS) |
| `src/bot/` | Thin bot (install welcome + help; proactive DMs) |
| `src/db/` | Azure SQL schema + access layer |
| `tab/` | Fluent UI React SPA (Vite) |
| `.github/workflows/deploy-tab.yml` | Build/deploy tab to GitHub Pages |
| `teams/` | Manifest + icons for sideload |
| `infra/provision.sh` | Idempotent `az` provisioning |

### Auth model

1. Tab calls `microsoftTeams.authentication.getAuthToken()`.
2. SPA sends `Authorization: Bearer <token>` to `/api/teams/{teamId}/standups…`.
3. Functions validate the Entra JWT (`aud` / JWKS / optional `ALLOWED_TENANT_IDS`).
4. There is **no owner/admin** role — any valid token may manage standups for the `teamId` in the path.

Set Function App setting `TAB_ORIGIN` to allowed CORS origins (e.g. `https://processmaker.github.io,http://localhost:5173`).

## API (authenticated)

| Method | Route |
|--------|--------|
| GET/POST | `/api/teams/{teamId}/standups` |
| GET/PATCH/DELETE | `/api/teams/{teamId}/standups/{id}` |
| PUT | `/api/teams/{teamId}/standups/{id}/users` |

`teamId` should be the Teams **AAD group id** (`team.groupId` from the tab context).

## Debugging Teams zip upload (`BadRequest`)

1. `npm run validate:teams`
2. [Teams Developer Portal](https://dev.teams.microsoft.com/) → Import/upload app package
3. Browser Network tab while uploading (`validate` / `appPackage`)
4. Confirm custom app sideload is allowed in Teams Admin Center

## Manual steps

1. **Entra** — Supported accounts multi-tenant + Application ID URI `api://processmaker.github.io/botid-{appId}` (tab host must match the iframe origin); exposed scope `access_as_user` pre-authorized for Teams clients (`provision.sh` attempts this).
2. **Sideload** the Teams app zip into each team (Manage team → Apps).
3. **GitHub Pages** — Repo Settings → Pages → Source: GitHub Actions. Set Variables `VITE_API_BASE_URL` and `VITE_TEAMS_APP_RESOURCE`.
4. **Privacy / Terms URLs** in `teams/manifest.json` still point at `https://example.com/...` — replace before wider distribution.
5. **Schema** — `npm run apply-schema` if provision did not apply it.
6. First proactive DM works best after creating a 1:1 conversation (notify will create one when needed).
7. Confirm Azure Bot `msaAppId` matches `MicrosoftAppId` / manifest `botId` / `webApplicationInfo.id`.

## Environment variables

See `.envrc` (from `provision.sh`) and `local.settings.json.example`:

- `MicrosoftAppId` / `MicrosoftAppPassword` / `MicrosoftAppType=SingleTenant`
- `MicrosoftAppTenantId` — publisher home tenant
- `SQL_CONNECTION_STRING`
- `BotServiceUrl`
- `TAB_ORIGIN` — CORS allowlist for the tab
- `ALLOWED_TENANT_IDS` — optional comma-separated tenant restrict list

Tab build:

- `VITE_API_BASE_URL`
- `VITE_TEAMS_APP_RESOURCE` (e.g. `api://processmaker.github.io/botid-<appId>`)

## Cost notes

- Bot Service **F0**
- Functions **Consumption (Y1)**
- SQL Database **serverless** with auto-pause

Monitor Azure Cost Management; serverless SQL and Functions still bill beyond free allowances.
