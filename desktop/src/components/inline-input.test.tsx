import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InlineInput } from "./inline-input";

describe("InlineInput", () => {
  it("renders with default value", () => {
    render(<InlineInput defaultValue="Hello" />);
    const input = screen.getByRole("textbox");
    expect(input).toBeTruthy();
  });

  it("enters edit mode on click", () => {
    const { container } = render(<InlineInput defaultValue="Click me" />);
    const input = screen.getByRole("textbox");
    fireEvent.click(input);
    // Should set data-editing attribute
    expect(container.querySelector("[data-editing='true']")).toBeTruthy();
  });

  it("calls onSave on blur", () => {
    const onSave = vi.fn();
    render(<InlineInput defaultValue="initial" onSave={onSave} />);
    const input = screen.getByRole("textbox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "updated" } });
    fireEvent.blur(input);

    expect(onSave).toHaveBeenCalledWith("updated");
  });

  it("calls onSave on Enter key", () => {
    const onSave = vi.fn();
    render(<InlineInput defaultValue="initial" onSave={onSave} />);
    const input = screen.getByRole("textbox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "new value" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSave).toHaveBeenCalledWith("new value");
  });

  it("reverts on Escape key", () => {
    const onSave = vi.fn();
    render(<InlineInput defaultValue="original" onSave={onSave} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    expect(input.value).toBe("original");
  });
});
