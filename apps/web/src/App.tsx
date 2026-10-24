import { ProjectScreen, TABS, type TabId } from "./features/project/ProjectScreen";
import { ProjectsScreen } from "./features/projects/ProjectsScreen";
import { useHashRoute, useVisualViewport } from "./lib/hooks";

export const App = () => {
  useVisualViewport();
  const [root, id, tab] = useHashRoute();
  return (
    <div className="app">
      {root === "p" && id ? (
        <ProjectScreen key={id} id={id} tab={(TABS.find((t) => t.id === tab)?.id ?? "audio") as TabId} />
      ) : (
        <ProjectsScreen />
      )}
    </div>
  );
};
