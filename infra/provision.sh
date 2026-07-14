#!/usr/bin/env bash
# Idempotent Azure provisioning for Blue Standup Bot.
# Safe to re-run after partial failures.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_FILE="${ROOT_DIR}/src/db/schema.sql"

# --- defaults (override via env) ---
SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-b50be7c5-e7ac-4de6-8e1a-3f1773e2a6f7}"
LOCATION="${AZURE_LOCATION:-eastus}"
# SQL often has regional capacity limits separate from Functions/Storage
SQL_LOCATION="${AZURE_SQL_LOCATION:-westus2}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-rg-blue-standup-bot}"
STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-bluestandupbotstore}"
BOT_NAME="${AZURE_BOT_NAME:-blue-standup-bot}"
FUNCTION_APP="${AZURE_FUNCTION_APP:-blue-standup-bot-fn}"
SQL_SERVER="${AZURE_SQL_SERVER:-bluestandupbotsql3centralus}"
SQL_DB="${AZURE_SQL_DB:-blue-standup-free-db}"
SQL_ADMIN_USER="${AZURE_SQL_ADMIN_USER:-sqladmin}"
# Set AZURE_SQL_RESET_PASSWORD=1 to rotate admin password on an existing server
SQL_RESET_PASSWORD="${AZURE_SQL_RESET_PASSWORD:-0}"
APP_DISPLAY_NAME="${AZURE_APP_DISPLAY_NAME:-Blue Standup Bot}"
APP_INSIGHTS="${AZURE_APP_INSIGHTS:-blue-standup-bot-ai}"
# Comma-separated fallbacks when a region refuses new SQL servers
SQL_LOCATION_FALLBACKS="${AZURE_SQL_LOCATION_FALLBACKS:-westus2,centralus,southcentralus,westus3,northeurope}"

log() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

wait_until() {
  local description="$1"
  local attempts="${2:-60}"
  local sleep_secs="${3:-10}"
  shift 3
  local i=1
  while (( i <= attempts )); do
    if "$@"; then
      log "${description}: ready"
      return 0
    fi
    printf '  waiting for %s (%d/%d)...\n' "${description}" "${i}" "${attempts}"
    sleep "${sleep_secs}"
    ((i++)) || true
  done
  warn "${description}: timed out"
  return 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd az
require_cmd python3
require_cmd openssl

log "Using subscription ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

TENANT_ID="$(az account show --query tenantId -o tsv)"
log "Tenant: ${TENANT_ID}"

# --- Resource group ---
log "Ensure resource group ${RESOURCE_GROUP}"
az group create \
  --name "${RESOURCE_GROUP}" \
  --location "${LOCATION}" \
  --output none

# --- Storage (reuse existing if present) ---
log "Ensure storage account ${STORAGE_ACCOUNT}"
if ! az storage account show --name "${STORAGE_ACCOUNT}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  az storage account create \
    --name "${STORAGE_ACCOUNT}" \
    --resource-group "${RESOURCE_GROUP}" \
    --location "${LOCATION}" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --output none
fi
STORAGE_CONNECTION="$(az storage account show-connection-string \
  --name "${STORAGE_ACCOUNT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query connectionString -o tsv)"

# --- Application Insights (optional free-tier) ---
log "Ensure Application Insights ${APP_INSIGHTS}"
# App Insights needs OperationalInsights registered (workspace-based components)
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null 2>&1 || true
az provider register --namespace Microsoft.Insights --wait >/dev/null 2>&1 || true
if ! az monitor app-insights component show --app "${APP_INSIGHTS}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  az monitor app-insights component create \
    --app "${APP_INSIGHTS}" \
    --location "${LOCATION}" \
    --resource-group "${RESOURCE_GROUP}" \
    --application-type web \
    --output none || warn "Application Insights create failed (continuing)"
fi
APPINSIGHTS_KEY="$(az monitor app-insights component show \
  --app "${APP_INSIGHTS}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query instrumentationKey -o tsv 2>/dev/null || true)"

# --- Function App (Consumption plan is created implicitly; Y1 is not a valid
#     az appservice plan / az functionapp plan SKU) ---
log "Ensure Function App ${FUNCTION_APP} (Consumption in ${LOCATION})"
if ! az functionapp show --name "${FUNCTION_APP}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  az functionapp create \
    --name "${FUNCTION_APP}" \
    --resource-group "${RESOURCE_GROUP}" \
    --storage-account "${STORAGE_ACCOUNT}" \
    --consumption-plan-location "${LOCATION}" \
    --runtime node \
    --runtime-version 20 \
    --functions-version 4 \
    --os-type Linux \
    --output none
fi

wait_until "function app" 30 10 bash -c \
  "az functionapp show --name '${FUNCTION_APP}' --resource-group '${RESOURCE_GROUP}' &>/dev/null"

FUNCTION_HOSTNAME="$(az functionapp show \
  --name "${FUNCTION_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query defaultHostName -o tsv)"
MESSAGING_ENDPOINT="https://${FUNCTION_HOSTNAME}/api/messages"
log "Messaging endpoint: ${MESSAGING_ENDPOINT}"

# --- Entra app registration ---
log "Ensure Entra app registration"
EXISTING_APP_ID="$(az ad app list --display-name "${APP_DISPLAY_NAME}" --query "[0].appId" -o tsv 2>/dev/null || true)"
if [[ -z "${EXISTING_APP_ID}" || "${EXISTING_APP_ID}" == "null" ]]; then
  # Also try matching existing bot's MSA app id if bot already exists
  if az bot show --name "${BOT_NAME}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
    CANDIDATE_APP_ID="$(az bot show --name "${BOT_NAME}" --resource-group "${RESOURCE_GROUP}" --query "properties.msaAppId" -o tsv 2>/dev/null || true)"
    # Bot may reference a deleted Entra app — only reuse if it still exists
    if [[ -n "${CANDIDATE_APP_ID}" && "${CANDIDATE_APP_ID}" != "null" ]] \
      && az ad app show --id "${CANDIDATE_APP_ID}" &>/dev/null; then
      EXISTING_APP_ID="${CANDIDATE_APP_ID}"
    else
      warn "Bot references missing Entra app ${CANDIDATE_APP_ID}; will recreate bot with a new app"
      RECREATE_BOT=1
    fi
  fi
fi

if [[ -z "${EXISTING_APP_ID}" || "${EXISTING_APP_ID}" == "null" ]]; then
  log "Creating Entra application ${APP_DISPLAY_NAME}"
  APP_ID="$(az ad app create \
    --display-name "${APP_DISPLAY_NAME}" \
    --sign-in-audience AzureADMultipleOrgs \
    --query appId -o tsv)"
  # Create service principal
  az ad sp create --id "${APP_ID}" --output none 2>/dev/null || true
else
  APP_ID="${EXISTING_APP_ID}"
  log "Reusing Entra app id ${APP_ID}"
  az ad sp create --id "${APP_ID}" --output none 2>/dev/null || true
  # Keep multi-tenant so the bot can be installed in other orgs (e.g. company Teams).
  az ad app update --id "${APP_ID}" \
    --sign-in-audience AzureADMultipleOrgs \
    --output none 2>/dev/null \
    || warn "Could not set sign-in audience to multi-tenant (may need portal)"
fi

# Reuse MicrosoftAppPassword from the environment when present so re-runs do
# not stack client secrets on the app registration. Create one only if missing.
if [[ -n "${MicrosoftAppPassword:-}" ]]; then
  APP_SECRET="${MicrosoftAppPassword}"
  log "Reusing existing MicrosoftAppPassword from environment (not creating a new secret)"
else
  log "Creating client secret"
  APP_SECRET="$(az ad app credential reset \
    --id "${APP_ID}" \
    --append \
    --display-name "blue-standup-bot-$(date +%Y%m%d%H%M%S)" \
    --years 2 \
    --query password -o tsv)"
fi

TAB_BASE_URL="${TAB_BASE_URL:-https://processmaker.github.io/blue-standup-bot}"
TAB_ORIGIN="${TAB_ORIGIN:-https://processmaker.github.io}"

# No Microsoft Graph application permissions — configurator is the Teams installer
# (recorded on install / first configure). People picker is client-side Adaptive Card.

# --- Azure Bot Service ---
log "Ensure Azure Bot ${BOT_NAME}"
# msaAppId cannot be changed in place — recreate if it doesn't match the Entra app.
# Note: Azure no longer allows creating MultiTenant bots; use SingleTenant + a
# multi-tenant Entra app so the bot can be sideloaded into other orgs.
if az bot show --name "${BOT_NAME}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  CURRENT_BOT_APP_ID="$(az bot show --name "${BOT_NAME}" --resource-group "${RESOURCE_GROUP}" --query "properties.msaAppId" -o tsv 2>/dev/null || true)"
  if [[ "${RECREATE_BOT:-0}" == "1" || "${CURRENT_BOT_APP_ID}" != "${APP_ID}" ]]; then
    log "Deleting bot ${BOT_NAME} (msaAppId ${CURRENT_BOT_APP_ID:-none} != ${APP_ID})"
    az bot delete --name "${BOT_NAME}" --resource-group "${RESOURCE_GROUP}" --output none
    wait_until "bot deleted" 30 2 bash -c \
      "! az bot show --name '${BOT_NAME}' --resource-group '${RESOURCE_GROUP}' &>/dev/null"
  fi
fi
if ! az bot show --name "${BOT_NAME}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  az bot create \
    --name "${BOT_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --sku F0 \
    --location global \
    --appid "${APP_ID}" \
    --app-type SingleTenant \
    --tenant-id "${TENANT_ID}" \
    --endpoint "${MESSAGING_ENDPOINT}" \
    --output none
else
  az bot update \
    --name "${BOT_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --endpoint "${MESSAGING_ENDPOINT}" \
    --output none || true
fi

# Application ID URI must include the tab host for getAuthToken() (iframe origin match).
TAB_HOST="$(python3 -c "from urllib.parse import urlparse; print(urlparse('${TAB_ORIGIN}'.split(',')[0].strip()).netloc)")"
APP_ID_URI="api://${TAB_HOST}/botid-${APP_ID}"
log "Ensure Entra Application ID URI ${APP_ID_URI}"
az ad app update --id "${APP_ID}" --identifier-uris "${APP_ID_URI}" --output none 2>/dev/null \
  || warn "Could not set identifier URI (may already be set or need portal)"

log "Ensure Entra exposed API scope access_as_user (Teams tab getAuthToken)"
python3 - <<PY || warn "Could not expose access_as_user scope (configure in Entra portal if needed)"
import json, subprocess, uuid

app_id = "${APP_ID}"
scope_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"access_as_user.{app_id}"))
app = json.loads(subprocess.check_output(
    ["az", "ad", "app", "show", "--id", app_id, "-o", "json"], text=True
))
object_id = app["id"]
api = app.get("api") or {}
scopes = list(api.get("oauth2PermissionScopes") or [])
existing = next((s for s in scopes if s.get("value") == "access_as_user"), None)
if existing:
    access_id = existing["id"]
else:
    access_id = scope_id
    scopes.append({
        "adminConsentDescription": "Allow the Teams tab to call the standup API as the signed-in user.",
        "adminConsentDisplayName": "Access standup API",
        "id": access_id,
        "isEnabled": True,
        "type": "User",
        "userConsentDescription": "Allow this app to call the standup API as you.",
        "userConsentDisplayName": "Access standup API",
        "value": "access_as_user",
    })

client_ids = [
    app_id,
    "1fec8e78-bce4-4aaf-ab1b-5451cc387264",  # Teams desktop/mobile
    "5e3ce6c0-2b1f-4285-8d4b-75ee78787346",  # Teams web
]
pre = [{"appId": cid, "delegatedPermissionIds": [access_id]} for cid in client_ids]
body = {
    "api": {
        "oauth2PermissionScopes": scopes,
        "preAuthorizedApplications": pre,
        "requestedAccessTokenVersion": 2,
    }
}
subprocess.check_call([
    "az", "rest",
    "--method", "PATCH",
    "--uri", f"https://graph.microsoft.com/v1.0/applications/{object_id}",
    "--headers", "Content-Type=application/json",
    "--body", json.dumps(body),
], stdout=subprocess.DEVNULL)
print("access_as_user scope ensured")
PY

# Ensure Teams channel
log "Ensure MS Teams channel on bot"
if ! az bot msteams show --name "${BOT_NAME}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  az bot msteams create \
    --name "${BOT_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --output none || warn "Could not create Teams channel (may already exist or need portal)"
fi

# --- SQL Server + Database (Always Free offer) ---
# Password handling: never silently rotate an existing server's admin password.
# - New server: generate a password if AZURE_SQL_ADMIN_PASSWORD is unset.
# - Existing server: require AZURE_SQL_ADMIN_PASSWORD; only rotate when AZURE_SQL_RESET_PASSWORD=1.
maybe_reset_sql_password() {
  local server_name="$1"
  if [[ "${SQL_RESET_PASSWORD}" == "1" ]]; then
    log "Resetting SQL admin password on ${server_name} (AZURE_SQL_RESET_PASSWORD=1)"
    az sql server update \
      --name "${server_name}" \
      --resource-group "${RESOURCE_GROUP}" \
      --admin-password "${SQL_ADMIN_PASSWORD}" \
      --output none
  fi
}

log "Ensure SQL server (preferred location ${SQL_LOCATION})"
az provider register --namespace Microsoft.Sql --wait >/dev/null 2>&1 || true
if az sql server show --name "${SQL_SERVER}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  if [[ -z "${AZURE_SQL_ADMIN_PASSWORD:-}" ]]; then
    echo "ERROR: SQL server ${SQL_SERVER} already exists. Set AZURE_SQL_ADMIN_PASSWORD to the known admin password." >&2
    echo "To rotate it instead, set AZURE_SQL_ADMIN_PASSWORD=<new> AZURE_SQL_RESET_PASSWORD=1." >&2
    exit 1
  fi
  SQL_ADMIN_PASSWORD="${AZURE_SQL_ADMIN_PASSWORD}"
  maybe_reset_sql_password "${SQL_SERVER}"
  SQL_LOCATION="$(az sql server show --name "${SQL_SERVER}" --resource-group "${RESOURCE_GROUP}" --query location -o tsv)"
else
  if [[ -z "${AZURE_SQL_ADMIN_PASSWORD:-}" ]]; then
    # Generate a strong password for new servers; persist to .envrc
    SQL_ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)Aa1!"
  else
    SQL_ADMIN_PASSWORD="${AZURE_SQL_ADMIN_PASSWORD}"
  fi
  SQL_CREATED=0
  CANDIDATE_LOCATIONS="${SQL_LOCATION}"
  IFS=',' read -ra _FALLBACKS <<< "${SQL_LOCATION_FALLBACKS}"
  for loc in "${_FALLBACKS[@]}"; do
    loc="$(echo "${loc}" | tr -d '[:space:]')"
    [[ -z "${loc}" || "${loc}" == "${SQL_LOCATION}" ]] && continue
    CANDIDATE_LOCATIONS="${CANDIDATE_LOCATIONS},${loc}"
  done
  IFS=',' read -ra _LOCS <<< "${CANDIDATE_LOCATIONS}"
  BASE_SQL_SERVER="${SQL_SERVER}"
  for loc in "${_LOCS[@]}"; do
    loc="$(echo "${loc}" | tr -d '[:space:]')"
    [[ -z "${loc}" ]] && continue
    # Failed creates leave a name locked to that region — use a per-region name
    CANDIDATE_SERVER="${BASE_SQL_SERVER}${loc//[^a-z0-9]/}"
    # Azure SQL server names: lowercase alphanumeric, 1-63 chars
    CANDIDATE_SERVER="$(echo "${CANDIDATE_SERVER}" | tr '[:upper:]' '[:lower:]' | cut -c1-63)"
    if az sql server show --name "${CANDIDATE_SERVER}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
      if [[ -z "${AZURE_SQL_ADMIN_PASSWORD:-}" ]]; then
        echo "ERROR: SQL server ${CANDIDATE_SERVER} already exists. Set AZURE_SQL_ADMIN_PASSWORD to the known admin password." >&2
        echo "To rotate it instead, set AZURE_SQL_ADMIN_PASSWORD=<new> AZURE_SQL_RESET_PASSWORD=1." >&2
        exit 1
      fi
      SQL_ADMIN_PASSWORD="${AZURE_SQL_ADMIN_PASSWORD}"
      SQL_SERVER="${CANDIDATE_SERVER}"
      SQL_LOCATION="$(az sql server show --name "${SQL_SERVER}" --resource-group "${RESOURCE_GROUP}" --query location -o tsv)"
      maybe_reset_sql_password "${SQL_SERVER}"
      SQL_CREATED=1
      break
    fi
    log "Trying SQL server ${CANDIDATE_SERVER} in ${loc}"
    if az sql server create \
      --name "${CANDIDATE_SERVER}" \
      --resource-group "${RESOURCE_GROUP}" \
      --location "${loc}" \
      --admin-user "${SQL_ADMIN_USER}" \
      --admin-password "${SQL_ADMIN_PASSWORD}" \
      --output none; then
      SQL_SERVER="${CANDIDATE_SERVER}"
      SQL_LOCATION="${loc}"
      SQL_CREATED=1
      break
    fi
    warn "SQL create failed in ${loc}"
  done
  if [[ "${SQL_CREATED}" != "1" ]]; then
    echo "ERROR: Could not create SQL server in any of: ${CANDIDATE_LOCATIONS}" >&2
    echo "Set AZURE_SQL_LOCATION / AZURE_SQL_SERVER and re-run, or delete failed SQL shells in the portal." >&2
    exit 1
  fi
fi
log "Using SQL server ${SQL_SERVER} (${SQL_LOCATION})"

wait_until "sql server" 30 10 bash -c \
  "az sql server show --name '${SQL_SERVER}' --resource-group '${RESOURCE_GROUP}' &>/dev/null"

log "Ensure SQL firewall rules"
az sql server firewall-rule create \
  --resource-group "${RESOURCE_GROUP}" \
  --server "${SQL_SERVER}" \
  --name AllowAzureServices \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0 \
  --output none 2>/dev/null || true

# Allow current public IP for schema apply
PUBLIC_IP="$(curl -s https://api.ipify.org || true)"
if [[ -n "${PUBLIC_IP}" ]]; then
  az sql server firewall-rule create \
    --resource-group "${RESOURCE_GROUP}" \
    --server "${SQL_SERVER}" \
    --name AllowCurrentIp \
    --start-ip-address "${PUBLIC_IP}" \
    --end-ip-address "${PUBLIC_IP}" \
    --output none 2>/dev/null || \
  az sql server firewall-rule update \
    --resource-group "${RESOURCE_GROUP}" \
    --server "${SQL_SERVER}" \
    --name AllowCurrentIp \
    --start-ip-address "${PUBLIC_IP}" \
    --end-ip-address "${PUBLIC_IP}" \
    --output none 2>/dev/null || true
fi

log "Ensure SQL database ${SQL_DB} (Always Free offer)"
if ! az sql db show --name "${SQL_DB}" --server "${SQL_SERVER}" --resource-group "${RESOURCE_GROUP}" &>/dev/null; then
  az sql db create \
    --name "${SQL_DB}" \
    --server "${SQL_SERVER}" \
    --resource-group "${RESOURCE_GROUP}" \
    --edition GeneralPurpose \
    --family Gen5 \
    --capacity 2 \
    --compute-model Serverless \
    --use-free-limit true \
    --free-limit-exhaustion-behavior AutoPause \
    --backup-storage-redundancy Local \
    --output none
fi

wait_until "sql database" 40 15 \
  bash -c "az sql db show --name '${SQL_DB}' --server '${SQL_SERVER}' --resource-group '${RESOURCE_GROUP}' --query status -o tsv | grep -qi online"

SQL_CONNECTION_STRING="Server=tcp:${SQL_SERVER}.database.windows.net,1433;Database=${SQL_DB};User ID=${SQL_ADMIN_USER};Password=${SQL_ADMIN_PASSWORD};Encrypt=true;TrustServerCertificate=false;Connection Timeout=30;"

# Apply schema with sqlcmd if available, else python pymssql/pyodbc fallback via az
log "Apply database schema"
if [[ -f "${ROOT_DIR}/node_modules/mssql/package.json" ]] || [[ -d "${ROOT_DIR}/node_modules/mssql" ]]; then
  (
    cd "${ROOT_DIR}"
    npm run build >/dev/null
    SQL_CONNECTION_STRING="${SQL_CONNECTION_STRING}" node dist/src/db/apply-schema.js
  ) || warn "node schema apply failed — run: npm run apply-schema"
elif command -v sqlcmd >/dev/null 2>&1; then
  sqlcmd -S "${SQL_SERVER}.database.windows.net" -d "${SQL_DB}" -U "${SQL_ADMIN_USER}" -P "${SQL_ADMIN_PASSWORD}" -i "${SCHEMA_FILE}" || warn "sqlcmd schema apply failed"
else
  warn "Install npm deps (mssql) or sqlcmd, then run: npm run apply-schema"
fi

# --- Function App settings ---
log "Configure Function App settings"
FUNCTION_HOST="${FUNCTION_APP}.azurewebsites.net"
SETTINGS=(
  "AzureWebJobsStorage=${STORAGE_CONNECTION}"
  "FUNCTIONS_WORKER_RUNTIME=node"
  "MicrosoftAppId=${APP_ID}"
  "MicrosoftAppPassword=${APP_SECRET}"
  "MicrosoftAppType=SingleTenant"
  "MicrosoftAppTenantId=${TENANT_ID}"
  "SQL_CONNECTION_STRING=${SQL_CONNECTION_STRING}"
  "BotServiceUrl=https://smba.trafficmanager.net/amer/"
  "TAB_ORIGIN=${TAB_ORIGIN},http://localhost:5173"
  "ALLOWED_TENANT_IDS=${TENANT_ID}"
)
if [[ -n "${APPINSIGHTS_KEY}" ]]; then
  SETTINGS+=("APPINSIGHTS_INSTRUMENTATIONKEY=${APPINSIGHTS_KEY}")
fi

az functionapp config appsettings set \
  --name "${FUNCTION_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --settings "${SETTINGS[@]}" \
  --output none

# --- Function App CORS ---
# Azure answers OPTIONS at the host. Without allowed origins here, preflight
# returns 204 with no Access-Control-Allow-Origin → browser "Failed to fetch".
# TAB_ORIGIN app setting still drives ACAO on non-OPTIONS responses from code.
log "Configure Function App CORS"
CORS_ORIGINS=()
IFS=',' read -ra _CORS_PARTS <<< "${TAB_ORIGIN},http://localhost:5173,http://127.0.0.1:5173"
for _o in "${_CORS_PARTS[@]}"; do
  _o="${_o#"${_o%%[![:space:]]*}"}"
  _o="${_o%"${_o##*[![:space:]]}"}"
  [[ -z "${_o}" ]] && continue
  _seen=0
  for _existing in "${CORS_ORIGINS[@]+"${CORS_ORIGINS[@]}"}"; do
    if [[ "${_existing}" == "${_o}" ]]; then
      _seen=1
      break
    fi
  done
  [[ "${_seen}" -eq 0 ]] && CORS_ORIGINS+=("${_o}")
done
az functionapp cors add \
  --name "${FUNCTION_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --allowed-origins "${CORS_ORIGINS[@]}" \
  --output none \
  || warn "Could not set Function App CORS — tab API may fail OPTIONS preflight"

# --- Write .envrc ---
log "Updating .envrc"
cat > "${ROOT_DIR}/.envrc" <<EOF
# Generated by infra/provision.sh — do not commit secrets.
export AZURE_SUBSCRIPTION_ID="${SUBSCRIPTION_ID}"
export AZURE_TENANT_ID="${TENANT_ID}"
export AZURE_RESOURCE_GROUP="${RESOURCE_GROUP}"
export AZURE_LOCATION="${LOCATION}"
export AZURE_SQL_LOCATION="${SQL_LOCATION}"
export AZURE_STORAGE_ACCOUNT="${STORAGE_ACCOUNT}"
export AZURE_FUNCTION_APP="${FUNCTION_APP}"
export AZURE_BOT_NAME="${BOT_NAME}"
export AZURE_SQL_SERVER="${SQL_SERVER}"
export AZURE_SQL_DB="${SQL_DB}"
export AZURE_SQL_ADMIN_USER="${SQL_ADMIN_USER}"
export AZURE_SQL_ADMIN_PASSWORD="${SQL_ADMIN_PASSWORD}"
export MicrosoftAppId="${APP_ID}"
export MicrosoftAppPassword="${APP_SECRET}"
export MicrosoftAppType="SingleTenant"
export MicrosoftAppTenantId="${TENANT_ID}"
export SQL_CONNECTION_STRING="${SQL_CONNECTION_STRING}"
export BotServiceUrl="https://smba.trafficmanager.net/amer/"
export MESSAGING_ENDPOINT="${MESSAGING_ENDPOINT}"
export TAB_BASE_URL="${TAB_BASE_URL}"
export TAB_ORIGIN="${TAB_ORIGIN}"
export ALLOWED_TENANT_IDS="${TENANT_ID}"
export VITE_API_BASE_URL="https://${FUNCTION_HOST}"
EOF

# local.settings.json for Functions Core Tools
cat > "${ROOT_DIR}/local.settings.json" <<EOF
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "MicrosoftAppId": "${APP_ID}",
    "MicrosoftAppPassword": "${APP_SECRET}",
    "MicrosoftAppType": "SingleTenant",
    "MicrosoftAppTenantId": "${TENANT_ID}",
    "SQL_CONNECTION_STRING": "${SQL_CONNECTION_STRING}",
    "BotServiceUrl": "https://smba.trafficmanager.net/amer/",
    "TAB_ORIGIN": "${TAB_ORIGIN},http://localhost:5173",
    "ALLOWED_TENANT_IDS": "${TENANT_ID}"
  }
}
EOF

# Update Teams manifest placeholders if present
MANIFEST="${ROOT_DIR}/teams/manifest.json"
if [[ -f "${MANIFEST}" ]]; then
  log "Patching teams/manifest.json with app id and tab/API domains"
  python3 - <<PY
import json
path = "${MANIFEST}"
app_id = "${APP_ID}"
tab_base = "${TAB_BASE_URL}".rstrip("/")
fn_host = "${FUNCTION_HOST}"
with open(path) as f:
    m = json.load(f)
m["id"] = app_id
if m.get("bots"):
    m["bots"][0]["botId"] = app_id
from urllib.parse import urlparse
tab_host = urlparse("${TAB_ORIGIN}".split(",")[0].strip()).netloc or "processmaker.github.io"
m["webApplicationInfo"] = {
    "id": app_id,
    "resource": f"api://{tab_host}/botid-{app_id}",
}
if m.get("configurableTabs"):
    m["configurableTabs"][0]["configurationUrl"] = f"{tab_base}/#/config"
domains = {
    "processmaker.github.io",
    "token.botframework.com",
    fn_host,
}
for d in m.get("validDomains") or []:
    domains.add(d)
m["validDomains"] = sorted(domains)
with open(path, "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
print("manifest updated")
PY
fi

log "Provisioning complete"
echo "Function endpoint: ${MESSAGING_ENDPOINT}"
echo "App Id: ${APP_ID}"
echo "Tab base URL: ${TAB_BASE_URL}"
echo "Next steps:"
echo "  1. direnv allow  (or source .envrc)"
echo "  2. npm install && npm run build"
echo "  3. Deploy: func azure functionapp publish ${FUNCTION_APP}"
echo "  4. Push tab/ to main (or run Deploy tab workflow); set repo var VITE_API_BASE_URL=https://${FUNCTION_HOST}"
echo "  5. npm run package:teams  then sideload the zip in Teams"
echo ""
echo "Manual steps that may be required are listed in README.md"
