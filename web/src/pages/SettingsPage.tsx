import { useEffect } from "react";
import type { HouseholdHttpResponse } from "../../../src/contracts/http";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { useHousehold } from "../hooks/useHousehold";

const weekdays = [
  ["monday", "Mandag"],
  ["tuesday", "Tirsdag"],
  ["wednesday", "Onsdag"],
  ["thursday", "Torsdag"],
  ["friday", "Fredag"],
  ["saturday", "Lørdag"],
  ["sunday", "Søndag"],
] as const;

function Schedule({
  schedule,
}: {
  schedule: HouseholdHttpResponse["people"][number]["defaultSchedule"];
}) {
  if (Object.keys(schedule).length === 0) return <EmptyState message="Ingen ugeplan angivet." />;
  // Missing weekdays are unknown, not false. Preserve non-standard keys from the contract too.
  const extraDays = Object.keys(schedule).filter((key) => !weekdays.some(([day]) => day === key));
  const days = [...weekdays, ...extraDays.map((key) => [key, key] as const)];
  return (
    <ul className="schedule-list">
      {days.map(([key, label]) => (
        <li key={key}>
          <span>{label}</span>
          <span className={schedule[key] === true ? "home-day" : "muted"}>
            {schedule[key] === true
              ? "Hjemme"
              : schedule[key] === false
                ? "Ikke hjemme"
                : "Ikke angivet"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HouseholdDetails({ household }: { household: HouseholdHttpResponse }) {
  return (
    <div className="settings-sections">
      <section aria-labelledby="settings-defaults">
        <h2 id="settings-defaults">Standarder</h2>
        <dl className="settings-facts">
          <div>
            <dt>Land / marked</dt>
            <dd>{household.country || "Ikke angivet"}</dd>
          </div>
          <div>
            <dt>Standardportioner</dt>
            <dd>{household.defaultServings}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="settings-people">
        <h2 id="settings-people">Personer</h2>
        {household.people.length === 0 ? (
          <EmptyState message="Ingen personer angivet." />
        ) : (
          <ul className="settings-records">
            {household.people.map((person, index) => (
              // Names are not unique IDs; this read-only snapshot preserves duplicates and order.
              // biome-ignore lint/suspicious/noArrayIndexKey: The contract has no person ID and this list is never edited.
              <li key={index}>
                <h3>{person.name || "Navn ikke angivet"}</h3>
                <h4>Kostrestriktioner</h4>
                {person.dietaryRestrictions.length === 0 ? (
                  <EmptyState message="Ingen restriktioner angivet." />
                ) : (
                  <ul>
                    {person.dietaryRestrictions.map((restriction, restrictionIndex) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Preserve duplicate entries in the read-only snapshot.
                      <li key={restrictionIndex}>{restriction || "Ikke angivet"}</li>
                    ))}
                  </ul>
                )}
                <h4>Ugeplan / hjemme-dage</h4>
                <Schedule schedule={person.defaultSchedule} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="settings-stores">
        <h2 id="settings-stores">Foretrukne butikker</h2>
        {household.stores.length === 0 ? (
          <EmptyState message="Ingen butikker angivet." />
        ) : (
          <ul className="settings-records">
            {household.stores.map((store, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Even dealer IDs may repeat; preserve the backend snapshot exactly.
              <li key={index}>
                <h3>{store.name || "Navn ikke angivet"}</h3>
                <dl className="settings-facts">
                  <div>
                    <dt>Dealer-ID</dt>
                    <dd>{store.dealerId || "Ikke angivet"}</dd>
                  </div>
                  <div>
                    <dt>Prioritet</dt>
                    <dd>{store.priority}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function SettingsPage() {
  const state = useHousehold();
  useEffect(() => {
    document.title = "Indstillinger · Tilbudstrolden";
  }, []);
  return (
    <section className="page-card settings-page">
      <h1>Indstillinger</h1>
      <p className="muted">Din husstand. Oplysningerne kan kun læses her.</p>
      {state.status === "loading" && <LoadingState message="Henter husstand…" />}
      {state.status === "error" && (
        <ErrorState message={`Husstanden kunne ikke hentes. ${state.error.message}`} />
      )}
      {state.status === "success" && <HouseholdDetails household={state.household} />}
    </section>
  );
}
