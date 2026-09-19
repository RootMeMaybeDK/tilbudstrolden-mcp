import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makePlan } from "../test/planning";
import { MealPlanPage } from "./MealPlanPage";

function respond(result = makePlan()) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (url !== "/api/plan-and-shop") throw new Error(`Unexpected request: ${url}`);
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function submit() {
  fireEvent.submit(screen.getByRole("form", { name: "Generér madplan" }));
}

function changeDays(value: string) {
  fireEvent.change(screen.getByLabelText("Antal dage"), { target: { value } });
}

describe("meal plan generation", () => {
  it("starts idle with documented days default, empty people and no request", () => {
    const fetchMock = respond();
    render(<MealPlanPage />);
    expect(document.title).toBe("Madplan · Tilbudstrolden");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByLabelText("Antal dage")).toHaveValue(7);
    expect(screen.getByLabelText("Antal personer (valgfrit)")).toHaveValue(null);
    expect(screen.getByText("Tomt felt bruger husstandens indstilling.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits the exact relative POST body, omitting empty people and advanced constraints", async () => {
    const fetchMock = respond();
    render(<MealPlanPage />);
    changeDays("2");
    await userEvent.setup().click(screen.getByRole("button", { name: "Generér madplan" }));
    await screen.findByRole("heading", { name: "Din madplan" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/plan-and-shop",
      expect.objectContaining({
        method: "POST",
        body: '{"days":2}',
        signal: expect.any(AbortSignal),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      }),
    );
  });

  it("supports a people override and keyboard form submission", async () => {
    const user = userEvent.setup();
    const fetchMock = respond();
    render(<MealPlanPage />);
    changeDays("2");
    await user.type(screen.getByLabelText("Antal personer (valgfrit)"), "5{Enter}");
    await screen.findByRole("heading", { name: "Din madplan" });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"days":2,"people":5}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["", "0", "-1", "1.5", "8"])("rejects invalid day input %j without fetching", (value) => {
    const fetchMock = respond();
    render(<MealPlanPage />);
    changeDays(value);
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "9007199254740992",
  ])("rejects invalid people input %j without fetching", (value) => {
    const fetchMock = respond();
    render(<MealPlanPage />);
    fireEvent.change(screen.getByLabelText("Antal personer (valgfrit)"), { target: { value } });
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks synchronous double submission and announces the pending request", () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<MealPlanPage />);
    act(() => {
      submit();
      submit();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Genererer…" })).toBeDisabled();
    expect(screen.getByLabelText("Antal dage")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Finder tilbud og sammensætter madplanen…",
    );
  });

  it("renders response order, effective context, estimates and confidence without shopping UI", async () => {
    respond();
    render(<MealPlanPage />);
    changeDays("2");
    submit();
    const heading = await screen.findByRole("heading", { name: "Din madplan" });
    expect(heading).toHaveFocus();
    const region = screen.getByRole("region", { name: "Din madplan" });
    expect(within(region).getByText("2 dage · 3 personer")).toBeInTheDocument();
    const cards = within(region).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("Dag 1Zeta-ret");
    expect(cards[1]).toHaveTextContent("Dag 2Alfa-ret");
    expect(region).toHaveTextContent("41,50");
    expect(region).toHaveTextContent("3,50");
    expect(region).toHaveTextContent("34,00");
    expect(region).toHaveTextContent("11,00");
    expect(
      within(region).getByText("Unikke ingredienser med matchet tilbud").nextElementSibling,
    ).toHaveTextContent("4");
    expect(region).toHaveTextContent("Det er ikke et fuldt madbudget eller en indkøbspris.");
    expect(region).toHaveTextContent("Varer uden matchet tilbudspris er ikke gratis.");
    expect(within(cards[0]).getByText("Usikre tilbudsmatch").nextElementSibling).toHaveTextContent(
      "1",
    );
    expect(
      within(cards[0]).getByText("Bekræftede tilbudsmatch").nextElementSibling,
    ).toHaveTextContent("1");
    expect(
      within(cards[0]).getByText("Ingredienser uden matchet tilbudspris").nextElementSibling,
    ).toHaveTextContent("1");
    expect(region).not.toHaveTextContent(
      /grandTotal|123,45|Shopping-only store|billigste madplan|Mandag/,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does not present unmatched-only recipes as free", async () => {
    const result = makePlan();
    result.planningEstimate = {
      matchedDealPlanningEstimate: 0,
      sharedMatchedDealEstimateSavings: 0,
      uniqueMatchedDealIngredientCount: 0,
    };
    for (const day of result.plan) {
      day.matchedDealEstimate = 0;
      day.recipe.matchSummary = {
        ...day.recipe.matchSummary,
        confirmedMatchCount: 0,
        lowConfidenceMatchCount: 0,
        unmatchedItemCount: 3,
      };
    }
    respond(result);
    render(<MealPlanPage />);
    submit();
    await screen.findByRole("heading", { name: "Din madplan" });
    for (const card of screen.getAllByRole("listitem")) {
      expect(card).toHaveTextContent("Ingen matchede tilbud med pris.");
      expect(card).not.toHaveTextContent("0,00");
    }
    expect(
      screen.getByText("Tilbudsmatchet estimat for planen").nextElementSibling,
    ).toHaveTextContent("Ingen matchede tilbud med pris.");
  });

  it.each([
    {
      status: "insufficient-recipes",
      code: "INSUFFICIENT_RECIPES",
      message: "Der er ikke nok opskrifter til 7 dage. Der er 2 tilgængelige opskrifter.",
    },
    {
      status: "no-valid-plan",
      code: "NO_VALID_PLAN",
      message: "Der kunne ikke sammensættes en plan for 7 dage",
    },
  ])("renders $status as a domain outcome from the actual 422 envelope", async ({
    status,
    code,
    message,
  }) => {
    const {
      plan: _plan,
      shopping: _shopping,
      selectedRecipes: _recipes,
      planningEstimate: _estimate,
      ...context
    } = makePlan();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: { code, message: "Do not render generic server message" },
          result: {
            ...context,
            days: 7,
            status,
            ...(status === "insufficient-recipes" ? { availableRecipeCount: 2 } : {}),
          },
        },
        { status: 422 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<MealPlanPage />);
    submit();
    await screen.findByRole("heading", { name: "Madplanen kunne ikke genereres" });
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Madplanen kunne ikke genereres" })).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    400, 500, 503,
  ])("shows HTTP %s through ErrorState without retry or result dump", async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: { code: "INTERNAL_ERROR", message: "Anmodningen kunne ikke gennemføres." },
          stack: "private stack",
          result: { internal: "private result" },
        },
        { status },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<MealPlanPage />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Anmodningen kunne ikke gennemføres.",
    );
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Generér madplan" })).toBeEnabled();
  });

  it("shows a neutral network error without retry", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("private network detail"));
    vi.stubGlobal("fetch", fetchMock);
    render(<MealPlanPage />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Kunne ikke kontakte backend.");
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "success",
    "error",
  ])("ignores late A %s after cancellation and successful B", async (lateOutcome) => {
    let finishA: ((response: Response) => void) | undefined;
    const fresh = makePlan();
    fresh.plan[0].recipeName = "Fresh B";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      )
      .mockImplementationOnce(async () => Response.json(fresh));
    vi.stubGlobal("fetch", fetchMock);
    render(<MealPlanPage />);
    submit();
    fireEvent.click(screen.getByRole("button", { name: "Afbryd" }));
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Generér madplan" })).toHaveFocus();
    submit();
    await screen.findByText("Fresh B");
    const stale = makePlan();
    stale.plan[0].recipeName = "Stale A";
    await act(async () =>
      finishA?.(
        lateOutcome === "success"
          ? Response.json(stale)
          : Response.json({ error: { message: "Stale error" } }, { status: 500 }),
      ),
    );
    expect(screen.getByText("Fresh B")).toBeInTheDocument();
    expect(screen.queryByText(/Stale/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let A's finalizer release B while B is still pending", async () => {
    let finishA: ((response: Response) => void) | undefined;
    let finishB: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishB = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<MealPlanPage />);
    submit();
    fireEvent.click(screen.getByRole("button", { name: "Afbryd" }));
    submit();
    await act(async () => finishA?.(Response.json(makePlan())));
    expect(screen.getByRole("button", { name: "Genererer…" })).toBeDisabled();
    const fresh = makePlan();
    fresh.plan[0].recipeName = "Fresh B";
    await act(async () => finishB?.(Response.json(fresh)));
    expect(screen.getByText("Fresh B")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles transport abort rejection and can generate again", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      )
      .mockImplementationOnce(async () => Response.json(makePlan()));
    vi.stubGlobal("fetch", fetchMock);
    render(<MealPlanPage />);
    submit();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Afbryd" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    submit();
    await screen.findByRole("heading", { name: "Din madplan" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
