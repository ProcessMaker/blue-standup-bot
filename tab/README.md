# Standups tab (Fluent UI)

React + Vite + `@fluentui/react-components` + `@microsoft/teams-js`.

## Local

```bash
cp .env.example .env
# VITE_API_BASE_URL + VITE_TEAMS_APP_RESOURCE
npm install
npm run dev
```

## Production

GitHub Action `.github/workflows/deploy-tab.yml` builds and deploys `dist/` to GitHub Pages for `ProcessMaker/blue-standup-bot`.

Set repo Variables:

- `VITE_API_BASE_URL`
- `VITE_TEAMS_APP_RESOURCE` (`api://botid-<appId>`)
