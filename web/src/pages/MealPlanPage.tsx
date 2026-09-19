import { type FormEvent, useEffect, useRef, useState } from "react";
import type { SuccessfulPlanAndShopHttpResponse } from "../../../src/contracts/http";
import { ErrorState, LoadingState } from "../components/States";
import { useMealPlan } from "../hooks/useMealPlan";

// First UI covers up to one week. These are UI bounds, not HTTP validation limits.
const MIN_PLAN_DAYS = 1;
const MAX_PLAN_DAYS = 7;

function PlanDetails({ result }: { result: SuccessfulPlanAndShopHttpResponse }) {
  const money = new Intl.NumberFormat("da-DK", { style: "currency", currency: result.currency });
  const estimate = result.planningEstimate;
  return (
    <>
      <p>
        {result.days} dage · {result.householdSize} personer
      </p>
      <p className="muted">
        Beløbene dækker kun ingredienser med matchede tilbud og kan inkludere usikre match. Det er
        ikke et fuldt madbudget eller en indkøbspris. Varer uden matchet tilbudspris er ikke gratis.
      </p>
      <dl className="plan-facts">
        <div>
          <dt>Tilbudsmatchet estimat for planen</dt>
          <dd>
            {estimate.uniqueMatchedDealIngredientCount === 0
              ? "Ingen matchede tilbud med pris."
              : money.format(estimate.matchedDealPlanningEstimate)}
          </dd>
        </div>
        <div>
          <dt>Estimeret besparelse ved delte tilbudsmatchede ingredienser</dt>
          <dd>{money.format(estimate.sharedMatchedDealEstimateSavings)}</dd>
        </div>
        <div>
          <dt>Unikke ingredienser med matchet tilbud</dt>
          <dd>{estimate.uniqueMatchedDealIngredientCount}</dd>
        </div>
      </dl>
      <ol className="plan-days">
        {result.plan.map((day) => (
          <li key={day.day}>
            <h3>Dag {day.day}</h3>
            <p className="plan-recipe-name">{day.recipeName}</p>
            <p>
              Tilbudsmatchet estimat:{" "}
              {day.recipe.matchSummary.confirmedMatchCount +
                day.recipe.matchSummary.lowConfidenceMatchCount ===
              0
                ? "Ingen matchede tilbud med pris."
                : money.format(day.matchedDealEstimate)}
            </p>
            <dl className="plan-facts">
              <div>
                <dt>Bekræftede tilbudsmatch</dt>
                <dd>{day.recipe.matchSummary.confirmedMatchCount}</dd>
              </div>
              <div>
                <dt>Usikre tilbudsmatch</dt>
                <dd>{day.recipe.matchSummary.lowConfidenceMatchCount}</dd>
              </div>
              <div>
                <dt>Ingredienser uden matchet tilbudspris</dt>
                <dd>{day.recipe.matchSummary.unmatchedItemCount}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </>
  );
}

export function MealPlanPage() {
  const { state, generate, cancel } = useMealPlan();
  const [days, setDays] = useState("7"); // Documented backend default.
  const [people, setPeople] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const focusAfterCancel = useRef(false);
  const pending = state.status === "loading";

  useEffect(() => {
    document.title = "Madplan · Tilbudstrolden";
  }, []);
  useEffect(() => {
    if (state.status === "result" || state.status === "error") resultHeading.current?.focus();
    if (state.status === "idle" && focusAfterCancel.current) {
      submitButton.current?.focus();
      focusAfterCancel.current = false;
    }
  }, [state]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !event.currentTarget.reportValidity()) return;
    const requestedDays = Number(days);
    const requestedPeople = people === "" ? undefined : Number(people);
    if (
      !Number.isSafeInteger(requestedDays) ||
      requestedDays < MIN_PLAN_DAYS ||
      requestedDays > MAX_PLAN_DAYS ||
      (requestedPeople !== undefined &&
        (!Number.isSafeInteger(requestedPeople) || requestedPeople < 1))
    ) {
      setInputError(
        "Angiv 1–7 hele dage og et positivt helt antal personer, eller lad personfeltet være tomt.",
      );
      return;
    }
    setInputError(null);
    void generate({
      days: requestedDays,
      ...(requestedPeople === undefined ? {} : { people: requestedPeople }),
    });
  }

  return (
    <section className="page-card meal-plan-page">
      <h1>Madplan</h1>
      <form onSubmit={submit} aria-label="Generér madplan">
        <div className="plan-inputs">
          <div>
            <label htmlFor="plan-days">Antal dage</label>
            <input
              id="plan-days"
              type="number"
              min={MIN_PLAN_DAYS}
              max={MAX_PLAN_DAYS}
              step="1"
              required
              value={days}
              onChange={(event) => setDays(event.target.value)}
              disabled={pending}
              aria-describedby="plan-days-help"
            />
            <p id="plan-days-help" className="muted">
              Vælg 1–7 dage.
            </p>
          </div>
          <div>
            <label htmlFor="plan-people">Antal personer (valgfrit)</label>
            <input
              id="plan-people"
              type="number"
              min="1"
              step="1"
              value={people}
              onChange={(event) => setPeople(event.target.value)}
              disabled={pending}
              aria-describedby="plan-people-help"
            />
            <p id="plan-people-help" className="muted">
              Tomt felt bruger husstandens indstilling.
            </p>
          </div>
        </div>
        {inputError && <ErrorState message={inputError} />}
        <div className="plan-actions">
          <button ref={submitButton} type="submit" disabled={pending}>
            {pending ? "Genererer…" : "Generér madplan"}
          </button>
          {pending && (
            <button
              type="button"
              onClick={() => {
                focusAfterCancel.current = true;
                cancel();
              }}
            >
              Afbryd
            </button>
          )}
        </div>
      </form>
      {state.status === "idle" && (
        <p className="muted">Vælg antal dage og generér et forslag til din madplan.</p>
      )}
      {pending && <LoadingState message="Finder tilbud og sammensætter madplanen…" />}
      {(state.status === "result" || state.status === "error") && (
        <section className="plan-result" aria-labelledby="plan-result-title">
          <h2 id="plan-result-title" ref={resultHeading} tabIndex={-1}>
            {state.status === "result" && state.result.status === "ok"
              ? "Din madplan"
              : "Madplanen kunne ikke genereres"}
          </h2>
          {state.status === "error" && <ErrorState message={state.error.message} />}
          {state.status === "result" && state.result.status === "ok" && (
            <PlanDetails result={state.result} />
          )}
          {state.status === "result" && state.result.status === "insufficient-recipes" && (
            <p role="status">
              Der er ikke nok opskrifter til {state.result.days} dage. Der er{" "}
              {state.result.availableRecipeCount} tilgængelige opskrifter. Prøv færre dage.
            </p>
          )}
          {state.status === "result" && state.result.status === "no-valid-plan" && (
            <p role="status">
              Der kunne ikke sammensættes en plan for {state.result.days} dage med de gældende krav
              til variation og opskrifter. Prøv færre dage.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
