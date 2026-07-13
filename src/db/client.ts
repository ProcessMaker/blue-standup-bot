import sql from "mssql";
import {
  DEFAULT_MESSAGE,
  DEFAULT_NOTIFY_TIME_UTC,
  formatTimeUtc,
  getSqlConnectionString,
} from "../config";

let poolPromise: Promise<sql.ConnectionPool> | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(getSqlConnectionString())
      .connect()
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

export type StandupConfig = {
  id: string;
  tenantId: string;
  teamId: string;
  teamName: string | null;
  name: string;
  createdByAadId: string | null;
  updatedByAadId: string | null;
  notifyTimeUtc: string | Date;
  message: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  userCount?: number;
};

export type StandupUser = {
  id: string;
  configId: string;
  userAadId: string;
  displayName: string | null;
};

function mapConfig(row: Record<string, unknown>): StandupConfig {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    teamId: String(row.team_id),
    teamName: row.team_name == null ? null : String(row.team_name),
    name: row.name == null ? "Default" : String(row.name),
    createdByAadId:
      row.created_by_aad_id == null ? null : String(row.created_by_aad_id),
    updatedByAadId:
      row.updated_by_aad_id == null ? null : String(row.updated_by_aad_id),
    notifyTimeUtc: row.notify_time_utc as string | Date,
    message: String(row.message),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    userCount:
      row.user_count == null ? undefined : Number(row.user_count),
  };
}

function mapUser(row: Record<string, unknown>): StandupUser {
  return {
    id: String(row.id),
    configId: String(row.config_id),
    userAadId: String(row.user_aad_id),
    displayName: row.display_name == null ? null : String(row.display_name),
  };
}

export async function listConfigsByTeam(
  teamId: string
): Promise<StandupConfig[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("teamId", sql.NVarChar(128), teamId)
    .query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM dbo.standup_users u WHERE u.config_id = c.id) AS user_count
       FROM dbo.standup_configs c
       WHERE c.team_id = @teamId
       ORDER BY c.name, c.created_at`
    );
  return result.recordset.map(mapConfig);
}

export async function getConfigById(
  configId: string
): Promise<StandupConfig | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, configId)
    .query(`SELECT * FROM dbo.standup_configs WHERE id = @id`);
  if (result.recordset.length === 0) {
    return null;
  }
  return mapConfig(result.recordset[0]);
}

export async function getConfigByTeamAndId(
  teamId: string,
  configId: string
): Promise<StandupConfig | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("teamId", sql.NVarChar(128), teamId)
    .input("id", sql.UniqueIdentifier, configId)
    .query(
      `SELECT * FROM dbo.standup_configs
       WHERE id = @id AND team_id = @teamId`
    );
  if (result.recordset.length === 0) {
    return null;
  }
  return mapConfig(result.recordset[0]);
}

export async function createConfig(params: {
  tenantId: string;
  teamId: string;
  teamName?: string | null;
  name: string;
  createdByAadId?: string | null;
  notifyTimeUtc?: string;
  message?: string;
  enabled?: boolean;
}): Promise<StandupConfig> {
  const pool = await getPool();
  const time =
    params.notifyTimeUtc ?? `${DEFAULT_NOTIFY_TIME_UTC}:00`;
  const result = await pool
    .request()
    .input("tenantId", sql.NVarChar(64), params.tenantId)
    .input("teamId", sql.NVarChar(128), params.teamId)
    .input("teamName", sql.NVarChar(256), params.teamName ?? null)
    .input("name", sql.NVarChar(128), params.name)
    .input(
      "createdByAadId",
      sql.NVarChar(64),
      params.createdByAadId ?? null
    )
    .input("notifyTimeUtc", sql.NVarChar(16), time)
    .input("message", sql.NVarChar(2000), params.message ?? DEFAULT_MESSAGE)
    .input("enabled", sql.Bit, params.enabled ?? false)
    .query(
      `INSERT INTO dbo.standup_configs
         (tenant_id, team_id, team_name, name, created_by_aad_id, updated_by_aad_id,
          notify_time_utc, message, enabled)
       OUTPUT INSERTED.*
       VALUES
         (@tenantId, @teamId, @teamName, @name, @createdByAadId, @createdByAadId,
          CAST(@notifyTimeUtc AS TIME), @message, @enabled)`
    );
  return mapConfig(result.recordset[0]);
}

export async function updateConfig(params: {
  teamId: string;
  configId: string;
  updatedByAadId?: string | null;
  name?: string;
  teamName?: string | null;
  notifyTimeUtc?: string;
  message?: string;
  enabled?: boolean;
}): Promise<StandupConfig | null> {
  const existing = await getConfigByTeamAndId(params.teamId, params.configId);
  if (!existing) {
    return null;
  }

  const name = params.name ?? existing.name;
  const teamName =
    params.teamName !== undefined ? params.teamName : existing.teamName;
  const notifyTimeSql = params.notifyTimeUtc
    ? params.notifyTimeUtc.length === 5
      ? `${params.notifyTimeUtc}:00`
      : params.notifyTimeUtc
    : `${formatTimeUtc(existing.notifyTimeUtc)}:00`;
  const message = params.message ?? existing.message;
  const enabled =
    params.enabled !== undefined ? params.enabled : existing.enabled;

  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, params.configId)
    .input("teamId", sql.NVarChar(128), params.teamId)
    .input("name", sql.NVarChar(128), name)
    .input("teamName", sql.NVarChar(256), teamName)
    .input("message", sql.NVarChar(2000), message)
    .input("enabled", sql.Bit, enabled)
    .input("notifyTimeUtc", sql.NVarChar(16), notifyTimeSql)
    .input(
      "updatedByAadId",
      sql.NVarChar(64),
      params.updatedByAadId ?? null
    )
    .query(
      `UPDATE dbo.standup_configs
       SET name = @name,
           team_name = @teamName,
           message = @message,
           enabled = @enabled,
           notify_time_utc = CAST(@notifyTimeUtc AS TIME),
           updated_by_aad_id = @updatedByAadId,
           updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id AND team_id = @teamId`
    );
  if (result.recordset.length === 0) {
    return null;
  }
  return mapConfig(result.recordset[0]);
}

export async function deleteConfig(
  teamId: string,
  configId: string
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, configId)
    .input("teamId", sql.NVarChar(128), teamId)
    .query(
      `DELETE FROM dbo.standup_configs
       WHERE id = @id AND team_id = @teamId;
       SELECT @@ROWCOUNT AS deleted;`
    );
  return Number(result.recordset[0]?.deleted ?? 0) > 0;
}

export async function listUsers(configId: string): Promise<StandupUser[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("configId", sql.UniqueIdentifier, configId)
    .query(
      `SELECT * FROM dbo.standup_users
       WHERE config_id = @configId
       ORDER BY display_name, user_aad_id`
    );
  return result.recordset.map(mapUser);
}

export async function replaceUsers(
  configId: string,
  users: { userAadId: string; displayName?: string | null }[]
): Promise<StandupUser[]> {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input("configId", sql.UniqueIdentifier, configId)
      .query(`DELETE FROM dbo.standup_users WHERE config_id = @configId`);

    for (const user of users) {
      await new sql.Request(tx)
        .input("configId", sql.UniqueIdentifier, configId)
        .input("userAadId", sql.NVarChar(64), user.userAadId)
        .input("displayName", sql.NVarChar(256), user.displayName ?? null)
        .query(
          `INSERT INTO dbo.standup_users (config_id, user_aad_id, display_name)
           VALUES (@configId, @userAadId, @displayName)`
        );
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return listUsers(configId);
}

export async function upsertConversationRef(params: {
  userAadId: string;
  tenantId: string;
  conversationRef: string;
}): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("userAadId", sql.NVarChar(64), params.userAadId)
    .input("tenantId", sql.NVarChar(64), params.tenantId)
    .input("conversationRef", sql.NVarChar(sql.MAX), params.conversationRef)
    .query(
      `MERGE dbo.conversation_refs AS target
       USING (SELECT @userAadId AS user_aad_id, @tenantId AS tenant_id) AS source
       ON target.user_aad_id = source.user_aad_id AND target.tenant_id = source.tenant_id
       WHEN MATCHED THEN
         UPDATE SET conversation_ref = @conversationRef, updated_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (user_aad_id, tenant_id, conversation_ref)
         VALUES (@userAadId, @tenantId, @conversationRef);`
    );
}

export async function getConversationRef(
  userAadId: string,
  tenantId: string
): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("userAadId", sql.NVarChar(64), userAadId)
    .input("tenantId", sql.NVarChar(64), tenantId)
    .query(
      `SELECT conversation_ref FROM dbo.conversation_refs
       WHERE user_aad_id = @userAadId AND tenant_id = @tenantId`
    );
  if (result.recordset.length === 0) {
    return null;
  }
  return String(result.recordset[0].conversation_ref);
}

export type DueConfig = StandupConfig & { users: StandupUser[] };

export async function listDueConfigs(hhmm: string): Promise<DueConfig[]> {
  const pool = await getPool();
  const timeSql = `${hhmm}:00`;
  const configs = await pool
    .request()
    .input("notifyTime", sql.NVarChar(16), timeSql)
    .query(
      `SELECT * FROM dbo.standup_configs
       WHERE enabled = 1
         AND CONVERT(varchar(5), notify_time_utc, 108) = CONVERT(varchar(5), CAST(@notifyTime AS TIME), 108)`
    );

  const due: DueConfig[] = [];
  for (const row of configs.recordset) {
    const config = mapConfig(row);
    const users = await listUsers(config.id);
    due.push({ ...config, users });
  }
  return due;
}
