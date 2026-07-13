-- Blue Standup Bot schema
-- Safe to re-run: creates objects only if missing; migrates toward multi-standup per team.

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'standup_configs')
BEGIN
    CREATE TABLE dbo.standup_configs (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        tenant_id NVARCHAR(64) NOT NULL,
        team_id NVARCHAR(128) NOT NULL,
        team_name NVARCHAR(256) NULL,
        name NVARCHAR(128) NOT NULL DEFAULT N'Default',
        created_by_aad_id NVARCHAR(64) NULL,
        updated_by_aad_id NVARCHAR(64) NULL,
        notify_time_utc TIME NOT NULL DEFAULT '15:00:00',
        message NVARCHAR(2000) NOT NULL
            DEFAULT N'Reminder: please post your standup update in your standup channel.',
        enabled BIT NOT NULL DEFAULT 0,
        created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- Migrate older DBs: one config per team (installer), not per team-owner pair.
IF EXISTS (
    SELECT 1 FROM sys.key_constraints
    WHERE name = 'UQ_standup_configs_team_owner' AND parent_object_id = OBJECT_ID('dbo.standup_configs')
)
BEGIN
    ;WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY created_at ASC) AS rn
        FROM dbo.standup_configs
    )
    DELETE FROM dbo.standup_configs
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

    ALTER TABLE dbo.standup_configs DROP CONSTRAINT UQ_standup_configs_team_owner;
END
GO

-- Multi-standup: drop unique(team_id) so many standups can share a team.
IF EXISTS (
    SELECT 1 FROM sys.key_constraints
    WHERE name = 'UQ_standup_configs_team' AND parent_object_id = OBJECT_ID('dbo.standup_configs')
)
BEGIN
    ALTER TABLE dbo.standup_configs DROP CONSTRAINT UQ_standup_configs_team;
END
GO

IF COL_LENGTH('dbo.standup_configs', 'name') IS NULL
BEGIN
    ALTER TABLE dbo.standup_configs
        ADD name NVARCHAR(128) NOT NULL
            CONSTRAINT DF_standup_configs_name DEFAULT N'Default';
END
GO

IF COL_LENGTH('dbo.standup_configs', 'created_by_aad_id') IS NULL
AND COL_LENGTH('dbo.standup_configs', 'owner_aad_id') IS NOT NULL
BEGIN
    EXEC sp_rename 'dbo.standup_configs.owner_aad_id', 'created_by_aad_id', 'COLUMN';
END
GO

IF COL_LENGTH('dbo.standup_configs', 'created_by_aad_id') IS NULL
BEGIN
    ALTER TABLE dbo.standup_configs ADD created_by_aad_id NVARCHAR(64) NULL;
END
GO

IF COL_LENGTH('dbo.standup_configs', 'updated_by_aad_id') IS NULL
BEGIN
    ALTER TABLE dbo.standup_configs ADD updated_by_aad_id NVARCHAR(64) NULL;
END
GO

-- Allow null created_by for audit-only model (legacy NOT NULL owner column).
IF COL_LENGTH('dbo.standup_configs', 'created_by_aad_id') IS NOT NULL
BEGIN
    DECLARE @nullable BIT;
    SELECT @nullable = is_nullable
    FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.standup_configs') AND name = 'created_by_aad_id';
    IF @nullable = 0
    BEGIN
        ALTER TABLE dbo.standup_configs ALTER COLUMN created_by_aad_id NVARCHAR(64) NULL;
    END
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'standup_users')
BEGIN
    CREATE TABLE dbo.standup_users (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        config_id UNIQUEIDENTIFIER NOT NULL,
        user_aad_id NVARCHAR(64) NOT NULL,
        display_name NVARCHAR(256) NULL,
        created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_standup_users_config
            FOREIGN KEY (config_id) REFERENCES dbo.standup_configs(id) ON DELETE CASCADE,
        CONSTRAINT UQ_standup_users_config_user UNIQUE (config_id, user_aad_id)
    );
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'conversation_refs')
BEGIN
    CREATE TABLE dbo.conversation_refs (
        user_aad_id NVARCHAR(64) NOT NULL,
        tenant_id NVARCHAR(64) NOT NULL,
        conversation_ref NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_conversation_refs PRIMARY KEY (user_aad_id, tenant_id)
    );
END
GO

-- Reserved for a future "reply with standup update" feature.
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'standup_responses')
BEGIN
    CREATE TABLE dbo.standup_responses (
        id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        config_id UNIQUEIDENTIFIER NOT NULL,
        user_aad_id NVARCHAR(64) NOT NULL,
        response_text NVARCHAR(MAX) NULL,
        response_date DATE NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
        created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_standup_responses_config
            FOREIGN KEY (config_id) REFERENCES dbo.standup_configs(id) ON DELETE CASCADE
    );
END
GO
