import { Link, Route, Routes } from "react-router-dom";
import { AppShell, pages } from "./layout/AppShell";
import { PlaceholderPage } from "./pages/PlaceholderPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {pages.map(({ path, title }) => (
          <Route key={path} path={path} element={<PlaceholderPage title={title} />} />
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
