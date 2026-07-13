import { useEffect, useMemo, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import {
  FluentProvider,
  Spinner,
  teamsDarkTheme,
  teamsHighContrastTheme,
  teamsLightTheme,
  type Theme,
} from "@fluentui/react-components";
import { ConfigPage } from "./ConfigPage";
import { ContentPage } from "./ContentPage";
import { ensureTeamsApp, getTeamsContext } from "./teams";
import * as microsoftTeams from "@microsoft/teams-js";

function themeFromTeams(theme?: string): Theme {
  switch (theme) {
    case "dark":
      return teamsDarkTheme;
    case "contrast":
      return teamsHighContrastTheme;
    default:
      return teamsLightTheme;
  }
}

export default function App() {
  const location = useLocation();
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<Theme>(teamsLightTheme);
  const [bootError, setBootError] = useState<string | null>(null);

  const isConfig = useMemo(
    () =>
      location.pathname.endsWith("/config") ||
      location.pathname.includes("/config/"),
    [location.pathname]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureTeamsApp();
        const ctx = await getTeamsContext();
        if (!cancelled) {
          setTheme(themeFromTeams(ctx.app.theme));
          setReady(true);
        }
        microsoftTeams.app.registerOnThemeChangeHandler((t) => {
          setTheme(themeFromTeams(t));
        });
      } catch (err) {
        // Allow local browser preview outside Teams with a soft warning.
        if (!cancelled) {
          setBootError(
            err instanceof Error
              ? err.message
              : "Failed to initialize Microsoft Teams"
          );
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <FluentProvider theme={teamsLightTheme}>
        <div style={{ padding: 24 }}>
          <Spinner label="Starting…" />
        </div>
      </FluentProvider>
    );
  }

  return (
    <FluentProvider theme={theme}>
      {bootError && !isConfig ? (
        <div style={{ padding: 12, fontSize: 12, opacity: 0.7 }}>
          Teams host unavailable ({bootError}). Open this page inside Teams for
          full functionality.
        </div>
      ) : null}
      <Routes>
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/*" element={<ContentPage />} />
      </Routes>
    </FluentProvider>
  );
}
