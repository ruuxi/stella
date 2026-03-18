import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { TextField } from "../../../src/ui/text-field";

describe("TextField", () => {
  it("renders input by default", () => {
    render(<TextField label="Name" />);
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.getByText("Name")).toBeTruthy();
  });

  it("renders textarea when multiline", () => {
    render(<TextField label="Bio" multiline />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.tagName.toLowerCase()).toBe("textarea");
  });

  it("shows description", () => {
    render(<TextField label="Email" description="We won't share it" />);
    expect(screen.getByText("We won't share it")).toBeTruthy();
  });

  it("shows error message", () => {
    render(<TextField label="Email" error="Invalid email" />);
    expect(screen.getByText("Invalid email")).toBeTruthy();
  });

  it("hides label visually when hideLabel is true", () => {
    const { container } = render(<TextField label="Hidden" hideLabel />);
    expect(container.querySelector(".sr-only")).toBeTruthy();
  });

  it("applies ghost variant", () => {
    const { container } = render(<TextField label="Input" variant="ghost" />);
    expect(container.querySelector("[data-variant='ghost']")).toBeTruthy();
  });

  it("handles onChange", () => {
    const onChange = vi.fn();
    render(<TextField label="Field" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "test" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("forwards shared props to textarea in multiline mode", () => {
    const onChange = vi.fn();
    render(
      <TextField
        label="Bio"
        multiline
        name="bio"
        placeholder="Tell us more"
        value="hello"
        onChange={onChange}
      />,
    );

    const textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("name")).toBe("bio");
    expect(textarea.getAttribute("placeholder")).toBe("Tell us more");
    expect((textarea as HTMLTextAreaElement).value).toBe("hello");

    fireEvent.change(textarea, { target: { value: "updated" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("forwards refs to textarea in multiline mode", () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(<TextField label="Bio" multiline ref={ref} />);

    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });
});
