import { useEffect, useState } from "react";
import {
  Body1,
  Spinner,
  Title2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { getTeamsContext, registerTabConfig } from "./teams";

const useStyles = makeStyles({
  root: {
    padding: tokens.spacingVerticalXXL,
    maxWidth: "480px",
  },
});

export function ConfigPage() {
  const styles = useStyles();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctx = await getTeamsContext();
        const teamId = ctx.team?.groupId || ctx.channel?.ownerGroupId || "";
        // Prefer teamId from Teams context; fall back to channel/team id fields.
        const resolvedTeamId =
          teamId ||
          (ctx.team as { internalId?: string } | undefined)?.internalId ||
          "";
        if (!resolvedTeamId) {
          throw new Error("Could not resolve team id for this tab");
        }
        await registerTabConfig({
          teamId: resolvedTeamId,
          teamName: ctx.team?.displayName,
        });
        if (!cancelled) {
          setReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.root}>
      <Title2>Configure Standups tab</Title2>
      {error ? (
        <Body1>{error}</Body1>
      ) : ready ? (
        <Body1>
          Click <strong>Save</strong> to add this tab. Anyone on the team can
          manage standup reminders from here.
        </Body1>
      ) : (
        <Spinner label="Preparing tab…" />
      )}
    </div>
  );
}
