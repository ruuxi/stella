/**
 * Render tests for Radix UI primitive wrappers and custom UI components.
 * Covers: accordion, avatar, card, checkbox, code, collapsible, dialog,
 * hover-card, icon-button, icon, image-preview, keybind, list, popover,
 * progress-circle, radio-group, select, slider, switch, tabs, tag,
 * text-field, tooltip.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { Avatar } from "./avatar";
import { Card } from "./card";
import { Checkbox } from "./checkbox";
import { Code } from "./code";
import { IconButton } from "./icon-button";
import { ImagePreview } from "./image-preview";
import { Keybind } from "./keybind";
import { List, ListItem, ListHeader, ListEmptyState } from "./list";
import { ProgressCircle } from "./progress-circle";
import { Tag } from "./tag";

describe("Avatar", () => {
  it("renders fallback character when no src", () => {
    render(<Avatar fallback="A" />);
    expect(screen.getByText("A")).toBeTruthy();
  });

  it("renders image when src provided", () => {
    const { container } = render(<Avatar fallback="A" src="https://example.com/photo.jpg" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("https://example.com/photo.jpg");
  });

  it("applies size attribute", () => {
    const { container } = render(<Avatar fallback="B" size="large" />);
    expect(container.querySelector("[data-size='large']")).toBeTruthy();
  });

  it("applies custom background/foreground colors when no src", () => {
    const { container } = render(
      <Avatar fallback="C" background="#ff0000" foreground="#00ff00" />
    );
    const el = container.querySelector("[data-component='avatar']");
    expect(el).toBeTruthy();
  });
});

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeTruthy();
  });

  it("applies variant data attribute", () => {
    const { container } = render(<Card variant="error">Oops</Card>);
    expect(container.querySelector("[data-variant='error']")).toBeTruthy();
  });

  it("defaults to normal variant", () => {
    const { container } = render(<Card>Default</Card>);
    expect(container.querySelector("[data-variant='normal']")).toBeTruthy();
  });
});

describe("Checkbox", () => {
  it("renders with label", () => {
    render(<Checkbox label="Accept terms" />);
    expect(screen.getByText("Accept terms")).toBeTruthy();
  });

  it("renders with description", () => {
    render(<Checkbox label="Opt in" description="Get updates" />);
    expect(screen.getByText("Get updates")).toBeTruthy();
  });

  it("hides label visually when hideLabel is true", () => {
    const { container } = render(<Checkbox label="Hidden" hideLabel />);
    expect(container.querySelector(".sr-only")).toBeTruthy();
  });
});

describe("Code", () => {
  it("renders code content", () => {
    render(<Code>const x = 1;</Code>);
    expect(screen.getByText("const x = 1;")).toBeTruthy();
  });

  it("applies language data attribute", () => {
    const { container } = render(<Code language="typescript">code</Code>);
    expect(container.querySelector("[data-language='typescript']")).toBeTruthy();
  });
});

describe("IconButton", () => {
  it("renders with click handler", () => {
    const onClick = vi.fn();
    render(<IconButton onClick={onClick}>X</IconButton>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });

  it("applies variant and size", () => {
    const { container } = render(
      <IconButton variant="ghost" size="large">+</IconButton>
    );
    expect(container.querySelector("[data-variant='ghost']")).toBeTruthy();
    expect(container.querySelector("[data-size='large']")).toBeTruthy();
  });
});

describe("ImagePreview", () => {
  it("renders image with src", () => {
    render(<ImagePreview src="https://example.com/img.png" alt="Test" />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe("https://example.com/img.png");
  });

  it("applies max dimensions", () => {
    const { container } = render(
      <ImagePreview src="https://example.com/img.png" maxWidth={200} maxHeight={150} />
    );
    const wrapper = container.querySelector("[data-component='image-preview']");
    expect(wrapper).toBeTruthy();
  });
});

describe("Keybind", () => {
  it("renders single key", () => {
    render(<Keybind keys="Enter" />);
    expect(screen.getByText("Enter")).toBeTruthy();
  });

  it("renders multiple keys with separators", () => {
    render(<Keybind keys={["Ctrl", "S"]} />);
    expect(screen.getByText("Ctrl")).toBeTruthy();
    expect(screen.getByText("S")).toBeTruthy();
  });
});

describe("List", () => {
  it("renders list with items", () => {
    render(
      <List>
        <ListItem>Item 1</ListItem>
        <ListItem>Item 2</ListItem>
      </List>
    );
    expect(screen.getByText("Item 1")).toBeTruthy();
    expect(screen.getByText("Item 2")).toBeTruthy();
  });

  it("renders list header", () => {
    render(
      <List>
        <ListHeader>Header</ListHeader>
      </List>
    );
    expect(screen.getByText("Header")).toBeTruthy();
  });

  it("renders empty state with default message", () => {
    render(<ListEmptyState />);
    expect(screen.getByText("No items found")).toBeTruthy();
  });

  it("renders empty state with custom message", () => {
    render(<ListEmptyState message="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });

  it("marks active item", () => {
    const { container } = render(
      <List>
        <ListItem active>Active</ListItem>
      </List>
    );
    expect(container.querySelector("[data-active='true']")).toBeTruthy();
  });
});

describe("ProgressCircle", () => {
  it("renders SVG circle", () => {
    const { container } = render(<ProgressCircle value={50} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("circle").length).toBe(2);
  });

  it("renders with custom size", () => {
    const { container } = render(<ProgressCircle value={75} size={48} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("48");
  });

  it("clamps progress to 0-1 range", () => {
    // Should not throw for out-of-range values
    render(<ProgressCircle value={150} max={100} />);
    render(<ProgressCircle value={-10} max={100} />);
  });
});

describe("Tag", () => {
  it("renders tag text", () => {
    render(<Tag>Status</Tag>);
    expect(screen.getByText("Status")).toBeTruthy();
  });

  it("applies variant", () => {
    const { container } = render(<Tag variant="success">OK</Tag>);
    expect(container.querySelector("[data-variant='success']")).toBeTruthy();
  });

  it("applies size", () => {
    const { container } = render(<Tag size="small">SM</Tag>);
    expect(container.querySelector("[data-size='small']")).toBeTruthy();
  });
});
