import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ApiErrorNote, errorMessage } from "./ApiErrorNote";
import { ApiError } from "../api/client";

const show = (error: unknown) =>
  render(
    <MantineProvider>
      <ApiErrorNote error={error} />
    </MantineProvider>,
  );

describe("ApiErrorNote", () => {
  it("shows the rejected field and the id a support ticket quotes", () => {
    show(
      new ApiError(422, "invalid", "items[2].kind is unknown.", "req_9f2c1ab47e", [
        { field: "items[2].kind", message: "unknown kind" },
      ]),
    );
    expect(screen.getByTestId("error-details")).toHaveTextContent(
      "items[2].kind: unknown kind",
    );
    expect(screen.getByTestId("error-request-id")).toHaveTextContent("req_9f2c1ab47e");
  });

  it("renders a spreadsheet row alongside its column", () => {
    show(
      new ApiError(422, "invalid", "bad file", "req_1", [
        { row: 4, field: "answer", message: "output is empty" },
      ]),
    );
    expect(screen.getByTestId("error-details")).toHaveTextContent(
      "answer, row 4: output is empty",
    );
  });

  it("shows only the id when there is nothing to point at — the common 404", () => {
    show(new ApiError(404, "not_found", "Conversation 'nope' not found.", "req_2"));
    expect(screen.queryByTestId("error-details")).toBeNull();
    expect(screen.getByTestId("error-request-id")).toBeInTheDocument();
  });

  it("renders nothing for a plain Error — no empty Reference line", () => {
    show(new Error("network down"));
    expect(screen.queryByTestId("error-details")).toBeNull();
    expect(screen.queryByTestId("error-request-id")).toBeNull();
  });

  it("errorMessage survives whatever was actually thrown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(undefined)).toBe("Something went wrong.");
  });
});
