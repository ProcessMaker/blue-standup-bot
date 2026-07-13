import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Body1,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Text,
  Textarea,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  Add24Regular,
  Delete24Regular,
  Edit24Regular,
} from "@fluentui/react-icons";
import {
  apiConfigured,
  createStandup,
  deleteStandup,
  getStandup,
  listStandups,
  putStandupUsers,
  updateStandup,
  type Standup,
  type StandupUser,
} from "./api";
import { getAuthToken, getTeamsContext, openPeoplePicker } from "./teams";

const useStyles = makeStyles({
  root: {
    padding: tokens.spacingVerticalL,
    maxWidth: "720px",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: tokens.spacingVerticalL,
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular,
  },
});

type Draft = {
  name: string;
  notifyTimeUtc: string;
  message: string;
  enabled: boolean;
  users: StandupUser[];
};

const emptyDraft = (): Draft => ({
  name: "",
  notifyTimeUtc: "15:00",
  message:
    "Reminder: please post your standup update in your standup channel.",
  enabled: false,
  users: [],
});

function teamIdFromQuery(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const q = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  return new URLSearchParams(q).get("teamId");
}

function teamIdFromContext(
  ctx: Awaited<ReturnType<typeof getTeamsContext>>
): string {
  const fromQuery = teamIdFromQuery();
  if (fromQuery) {
    return fromQuery;
  }
  return (
    ctx.team?.groupId ||
    (ctx.team as { internalId?: string } | undefined)?.internalId ||
    ctx.channel?.ownerGroupId ||
    ""
  );
}

export function ContentPage() {
  const styles = useStyles();
  const [teamId, setTeamId] = useState("");
  const [standups, setStandups] = useState<Standup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    if (!apiConfigured()) {
      setError("API base URL is not configured (VITE_API_BASE_URL).");
      setLoading(false);
      return;
    }
    try {
      const ctx = await getTeamsContext();
      const id = teamIdFromContext(ctx);
      if (!id) {
        throw new Error("Could not resolve team id");
      }
      setTeamId(id);
      const token = await getAuthToken();
      const result = await listStandups(id, token);
      setStandups(result.standups);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setCreating(true);
    setDraft(emptyDraft());
  };

  const openEdit = async (standup: Standup) => {
    setCreating(false);
    setEditingId(standup.id);
    setError(null);
    try {
      const token = await getAuthToken();
      const detailed = await getStandup(teamId, standup.id, token);
      const s = detailed.standup;
      setDraft({
        name: s.name,
        notifyTimeUtc: s.notifyTimeUtc,
        message: s.message,
        enabled: s.enabled,
        users: s.users ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEditingId(null);
    }
  };

  const closeEditor = () => {
    setCreating(false);
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const token = await getAuthToken();
      if (creating) {
        const created = await createStandup(teamId, token, {
          name: draft.name.trim(),
          notifyTimeUtc: draft.notifyTimeUtc,
          message: draft.message,
          enabled: draft.enabled,
        });
        await putStandupUsers(teamId, created.standup.id, token, draft.users);
      } else if (editingId) {
        await updateStandup(teamId, editingId, token, {
          name: draft.name.trim(),
          notifyTimeUtc: draft.notifyTimeUtc,
          message: draft.message,
          enabled: draft.enabled,
        });
        await putStandupUsers(teamId, editingId, token, draft.users);
      }
      closeEditor();
      setLoading(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (standup: Standup) => {
    setError(null);
    try {
      const token = await getAuthToken();
      await deleteStandup(teamId, standup.id, token);
      setLoading(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addPeople = async () => {
    setError(null);
    try {
      const picked = await openPeoplePicker({
        setSelected: draft.users.map((u) => u.userAadId),
      });
      if (picked.length === 0) {
        return;
      }
      // selectPeople returns the full selection (including preselected), so replace.
      setDraft((prev) => ({ ...prev, users: picked }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeUser = (userAadId: string) => {
    setDraft((prev) => ({
      ...prev,
      users: prev.users.filter((u) => u.userAadId !== userAadId),
    }));
  };

  const editing = creating || editingId != null;

  const title = useMemo(() => {
    if (creating) {
      return "New standup";
    }
    if (editingId) {
      return "Edit standup";
    }
    return "Standups";
  }, [creating, editingId]);

  if (loading) {
    return (
      <div className={styles.root}>
        <Spinner label="Loading standups…" />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>{title}</Title2>
        {!editing ? (
          <Button
            appearance="primary"
            icon={<Add24Regular />}
            onClick={openCreate}
          >
            New standup
          </Button>
        ) : null}
      </div>

      {error ? (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}

      {editing ? (
        <div className={styles.form}>
          <Field label="Name" required>
            <Input
              value={draft.name}
              onChange={(_, d) => setDraft({ ...draft, name: d.value })}
            />
          </Field>
          <Field label="Notify time (UTC, weekdays)" required>
            <Input
              value={draft.notifyTimeUtc}
              placeholder="15:00"
              onChange={(_, d) =>
                setDraft({ ...draft, notifyTimeUtc: d.value })
              }
            />
          </Field>
          <Field label="Reminder message">
            <Textarea
              value={draft.message}
              rows={4}
              onChange={(_, d) => setDraft({ ...draft, message: d.value })}
            />
          </Field>
          <Switch
            label="Enabled"
            checked={draft.enabled}
            onChange={(_, d) => setDraft({ ...draft, enabled: d.checked })}
          />
          <div>
            <Title3>People</Title3>
            <Body1>
              These users receive a DM at the notify time on weekdays.
            </Body1>
            <div className={styles.chipRow} style={{ marginTop: 8 }}>
              {draft.users.length === 0 ? (
                <Text>No users yet</Text>
              ) : (
                draft.users.map((u) => (
                  <span key={u.userAadId} className={styles.chip}>
                    {u.displayName || u.userAadId}
                    <Button
                      size="small"
                      appearance="transparent"
                      icon={<Delete24Regular />}
                      onClick={() => removeUser(u.userAadId)}
                      aria-label="Remove user"
                    />
                  </span>
                ))
              )}
            </div>
            <Button style={{ marginTop: 8 }} onClick={() => void addPeople()}>
              Add people
            </Button>
          </div>
          <div className={styles.actions}>
            <Button
              appearance="primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              appearance="secondary"
              disabled={saving}
              onClick={closeEditor}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.list}>
          {standups.length === 0 ? (
            <Body1>
              No standups yet. Create one to start sending reminders.
            </Body1>
          ) : (
            standups.map((s) => (
              <div key={s.id} className={styles.row}>
                <div>
                  <Title3>{s.name}</Title3>
                  <Body1>
                    {s.enabled ? "Enabled" : "Disabled"} · {s.notifyTimeUtc} UTC
                    · {s.userCount ?? 0} user(s)
                  </Body1>
                </div>
                <div className={styles.actions}>
                  <Button
                    icon={<Edit24Regular />}
                    onClick={() => void openEdit(s)}
                  >
                    Edit
                  </Button>
                  <Dialog>
                    <DialogTrigger disableButtonEnhancement>
                      <Button
                        appearance="secondary"
                        icon={<Delete24Regular />}
                      >
                        Delete
                      </Button>
                    </DialogTrigger>
                    <DialogSurface>
                      <DialogBody>
                        <DialogTitle>Delete standup?</DialogTitle>
                        <DialogContent>
                          Anyone on the team can delete standups. This cannot be
                          undone.
                        </DialogContent>
                        <DialogActions>
                          <DialogTrigger disableButtonEnhancement>
                            <Button appearance="secondary">Cancel</Button>
                          </DialogTrigger>
                          <Button
                            appearance="primary"
                            onClick={() => void remove(s)}
                          >
                            Delete
                          </Button>
                        </DialogActions>
                      </DialogBody>
                    </DialogSurface>
                  </Dialog>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
