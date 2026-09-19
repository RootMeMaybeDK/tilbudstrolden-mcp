import { Link, Route, Routes } from "react-router-dom";
import { AppShell, pages } from "./layout/AppShell";
import { MealPlanPage } from "./pages/MealPlanPage";
import { PantryPage } from "./pages/PantryPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {pages.map(({ path, title }) => (
          <Route
            key={path}
            path={path}
            element={
              path === "/settings" ? (
                <SettingsPage />
              ) : path === "/pantry" ? (
                <PantryPage />
              ) : path === "/plan" ? (
                <MealPlanPage />
              ) : (
                <PlaceholderPage title={title} />
              )
            }
          />
        ))}
        <Route
          path="*"
          element={
            <section className="page-card">
              <h1>Siden findes ikke</h1>
              <Link to="/">Tilbage til overblik</Link>
            </section>
          }
        />
      </Route>
    </Routes>
  );
}
