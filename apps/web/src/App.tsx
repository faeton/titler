import { useCallback, useEffect, useState } from "react";
import { api, AUTH_EVENT } from "./api";
import { AccessScreen, LoginScreen } from "./features/access/AccessScreen";
import { ProjectScreen, TABS, type TabId } from "./features/project/ProjectScreen";
import { ProjectsScreen } from "./features/projects/ProjectsScreen";
import { useHashRoute, useVisualViewport } from "./lib/hooks";

export const App = () => {
  useVisualViewport();
  const [root, id, tab] = useHashRoute();
  // Only through the public gateway does the server ask for a login; tailnet use is unchanged.
  const [login, setLogin] = useState(false);
  const check = useCallback(() => {
    api.authMe().then(
      (m) => setLogin(m.required && !m.authenticated),
      () => {},
    );
  }, []);
  useEffect(() => {
    check();
    const on = () => setLogin(true);
    window.addEventListener(AUTH_EVENT, on);
    return () => window.removeEventListener(AUTH_EVENT, on);
  }, [check]);
  return (
    <div className="app">
      {login ? (
        <LoginScreen onDone={() => (setLogin(false), check())} />
      ) : root === "p" && id ? (
        <ProjectScreen key={id} id={id} tab={(TABS.find((t) => t.id === tab)?.id ?? "audio") as TabId} />
      ) : root === "access" ? (
        <AccessScreen />
      ) : (
        <ProjectsScreen />
      )}
    </div>
  );
};
