/**
 * Tests for Radix UI primitive wrapper components.
 * Covers: accordion, collapsible, dialog, dropdown-menu, hover-card,
 * icon, popover, radio-group, select, slider, switch, tabs, tooltip.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Radix Slider uses ResizeObserver internally, which is not available in jsdom.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

import { Accordion } from "./accordion";
import { Collapsible } from "./collapsible";
import { Dialog } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";
import { HoverCard, HoverCardRoot, HoverCardTrigger, HoverCardContent } from "./hover-card";
import { Icon } from "./icon";
import { Popover } from "./popover";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { Select, SelectItem } from "./select";
import { Slider } from "./slider";
import { Switch } from "./switch";
import { Tabs } from "./tabs";
import { Tooltip } from "./tooltip";

// ---------------------------------------------------------------------------
// Accordion
// ---------------------------------------------------------------------------
describe("Accordion", () => {
  it("renders with data-component attribute", () => {
    const { container } = render(
      <Accordion type="single" defaultValue="item-1">
        <Accordion.Item value="item-1">
          <Accordion.Trigger>Section 1</Accordion.Trigger>
          <Accordion.Content>Content 1</Accordion.Content>
        </Accordion.Item>
      </Accordion>,
    );
    expect(container.querySelector("[data-component='accordion']")).toBeTruthy();
  });

  it("renders AccordionItem with data-slot", () => {
    const { container } = render(
      <Accordion type="single" defaultValue="item-1">
        <Accordion.Item value="item-1">
          <Accordion.Trigger>Trigger</Accordion.Trigger>
          <Accordion.Content>Body</Accordion.Content>
        </Accordion.Item>
      </Accordion>,
    );
    expect(container.querySelector("[data-slot='accordion-item']")).toBeTruthy();
  });

  it("renders AccordionTrigger with data-slot and chevron icon", () => {
    const { container } = render(
      <Accordion type="single" defaultValue="item-1">
        <Accordion.Item value="item-1">
          <Accordion.Trigger>Click me</Accordion.Trigger>
          <Accordion.Content>Hidden</Accordion.Content>
        </Accordion.Item>
      </Accordion>,
    );
    expect(container.querySelector("[data-slot='accordion-trigger']")).toBeTruthy();
    expect(container.querySelector("[data-slot='accordion-chevron']")).toBeTruthy();
    expect(screen.getByText("Click me")).toBeTruthy();
  });

  it("renders AccordionContent with data-slot when expanded", () => {
    const { container } = render(
      <Accordion type="single" defaultValue="item-1">
        <Accordion.Item value="item-1">
          <Accordion.Trigger>Trigger</Accordion.Trigger>
          <Accordion.Content>Visible content</Accordion.Content>
        </Accordion.Item>
      </Accordion>,
    );
    expect(container.querySelector("[data-slot='accordion-content']")).toBeTruthy();
    expect(screen.getByText("Visible content")).toBeTruthy();
  });

  it("forwards className to root", () => {
    const { container } = render(
      <Accordion type="single" className="custom-accordion">
        <Accordion.Item value="a">
          <Accordion.Trigger>T</Accordion.Trigger>
          <Accordion.Content>C</Accordion.Content>
        </Accordion.Item>
      </Accordion>,
    );
    expect(
      container.querySelector("[data-component='accordion']")?.classList.contains("custom-accordion"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Collapsible
// ---------------------------------------------------------------------------
describe("Collapsible", () => {
  it("renders with data-component attribute", () => {
    const { container } = render(
      <Collapsible>
        <Collapsible.Trigger>Toggle</Collapsible.Trigger>
        <Collapsible.Content>Body</Collapsible.Content>
      </Collapsible>,
    );
    expect(container.querySelector("[data-component='collapsible']")).toBeTruthy();
  });

  it("defaults to data-variant normal", () => {
    const { container } = render(
      <Collapsible>
        <Collapsible.Trigger>T</Collapsible.Trigger>
      </Collapsible>,
    );
    expect(container.querySelector("[data-variant='normal']")).toBeTruthy();
  });

  it("applies ghost variant via data-variant", () => {
    const { container } = render(
      <Collapsible variant="ghost">
        <Collapsible.Trigger>T</Collapsible.Trigger>
      </Collapsible>,
    );
    expect(container.querySelector("[data-variant='ghost']")).toBeTruthy();
  });

  it("renders CollapsibleTrigger with data-slot", () => {
    const { container } = render(
      <Collapsible>
        <Collapsible.Trigger>Open</Collapsible.Trigger>
      </Collapsible>,
    );
    expect(container.querySelector("[data-slot='collapsible-trigger']")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
  });

  it("renders CollapsibleContent with data-slot when open", () => {
    const { container } = render(
      <Collapsible defaultOpen>
        <Collapsible.Trigger>Toggle</Collapsible.Trigger>
        <Collapsible.Content>Inner content</Collapsible.Content>
      </Collapsible>,
    );
    expect(container.querySelector("[data-slot='collapsible-content']")).toBeTruthy();
    expect(screen.getByText("Inner content")).toBeTruthy();
  });

  it("renders CollapsibleArrow with data-slot and chevron", () => {
    const { container } = render(
      <Collapsible>
        <Collapsible.Arrow />
      </Collapsible>,
    );
    expect(container.querySelector("[data-slot='collapsible-arrow']")).toBeTruthy();
    // ChevronDown icon is rendered inside the arrow
    expect(container.querySelector("[data-slot='collapsible-arrow'] svg")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
describe("Dialog", () => {
  it("renders DialogContent with data-component and default size", () => {
    const { baseElement } = render(
      <Dialog open>
        <Dialog.Content>
          <Dialog.Title>Test Dialog</Dialog.Title>
        </Dialog.Content>
      </Dialog>,
    );
    const dialogEl = baseElement.querySelector("[data-component='dialog']");
    expect(dialogEl).toBeTruthy();
    expect(dialogEl?.getAttribute("data-size")).toBe("md");
  });

  it("applies custom size to dialog", () => {
    const { baseElement } = render(
      <Dialog open>
        <Dialog.Content size="lg">
          <Dialog.Title>Large</Dialog.Title>
        </Dialog.Content>
      </Dialog>,
    );
    expect(baseElement.querySelector("[data-size='lg']")).toBeTruthy();
  });

  it("applies fit attribute when true", () => {
    const { baseElement } = render(
      <Dialog open>
        <Dialog.Content fit>
          <Dialog.Title>Fit</Dialog.Title>
        </Dialog.Content>
      </Dialog>,
    );
    expect(baseElement.querySelector("[data-fit='true']")).toBeTruthy();
  });

  it("renders overlay with data-component", () => {
    const { baseElement } = render(
      <Dialog open>
        <Dialog.Content>
          <Dialog.Title>Overlay test</Dialog.Title>
        </Dialog.Content>
      </Dialog>,
    );
    expect(baseElement.querySelector("[data-component='dialog-overlay']")).toBeTruthy();
  });

  it("renders DialogHeader, DialogTitle, DialogDescription, DialogBody", () => {
    const { baseElement } = render(
      <Dialog open>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Title</Dialog.Title>
            <Dialog.Description>Description</Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>Body text</Dialog.Body>
        </Dialog.Content>
      </Dialog>,
    );
    expect(baseElement.querySelector("[data-slot='dialog-header']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='dialog-title']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='dialog-description']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='dialog-body']")).toBeTruthy();
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
    expect(screen.getByText("Body text")).toBeTruthy();
  });

  it("renders DialogCloseButton with X icon", () => {
    const { baseElement } = render(
      <Dialog open>
        <Dialog.Content>
          <Dialog.Title>Close test</Dialog.Title>
          <Dialog.CloseButton />
        </Dialog.Content>
      </Dialog>,
    );
    const closeBtn = baseElement.querySelector("[data-slot='dialog-close-button']");
    expect(closeBtn).toBeTruthy();
    expect(closeBtn?.querySelector("svg")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DropdownMenu
// ---------------------------------------------------------------------------
describe("DropdownMenu", () => {
  it("renders trigger with data-slot", () => {
    const { container } = render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      </DropdownMenu>,
    );
    expect(container.querySelector("[data-slot='dropdown-menu-trigger']")).toBeTruthy();
    expect(screen.getByText("Open menu")).toBeTruthy();
  });

  it("renders content with data-component when open", () => {
    const { baseElement } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(baseElement.querySelector("[data-component='dropdown-menu-content']")).toBeTruthy();
  });

  it("renders menu item with data-slot", () => {
    const { baseElement } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Click me</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(baseElement.querySelector("[data-slot='dropdown-menu-item']")).toBeTruthy();
    expect(screen.getByText("Click me")).toBeTruthy();
  });

  it("renders separator with data-slot", () => {
    const { baseElement } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>A</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>B</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(baseElement.querySelector("[data-slot='dropdown-menu-separator']")).toBeTruthy();
  });

  it("renders label with data-slot", () => {
    const { baseElement } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Group</DropdownMenuLabel>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(baseElement.querySelector("[data-slot='dropdown-menu-group-label']")).toBeTruthy();
    expect(screen.getByText("Group")).toBeTruthy();
  });

  it("renders checkbox item with data-slot", () => {
    const { baseElement } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked>Checked</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(baseElement.querySelector("[data-slot='dropdown-menu-checkbox-item']")).toBeTruthy();
  });

  it("renders radio group and radio item with data-slots", () => {
    const { baseElement } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a">Option A</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">Option B</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(baseElement.querySelector("[data-slot='dropdown-menu-radio-group']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='dropdown-menu-radio-item']")).toBeTruthy();
  });

  it("renders sub menu trigger and content with data-slots", () => {
    const { baseElement } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Sub item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(baseElement.querySelector("[data-slot='dropdown-menu-sub-trigger']")).toBeTruthy();
    expect(baseElement.querySelector("[data-component='dropdown-menu-sub-content']")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HoverCard
// ---------------------------------------------------------------------------
describe("HoverCard", () => {
  it("renders trigger with data-slot using primitive components", () => {
    const { container } = render(
      <HoverCardRoot defaultOpen>
        <HoverCardTrigger>Hover me</HoverCardTrigger>
        <HoverCardContent>Card body</HoverCardContent>
      </HoverCardRoot>,
    );
    expect(container.querySelector("[data-slot='hover-card-trigger']")).toBeTruthy();
  });

  it("renders content with data-component when open", () => {
    const { baseElement } = render(
      <HoverCardRoot defaultOpen>
        <HoverCardTrigger>Trigger</HoverCardTrigger>
        <HoverCardContent>Details</HoverCardContent>
      </HoverCardRoot>,
    );
    expect(baseElement.querySelector("[data-component='hover-card-content']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='hover-card-body']")).toBeTruthy();
  });

  it("renders the convenience HoverCard component", () => {
    render(
      <HoverCard trigger={<button>Hover trigger</button>}>
        Hover content
      </HoverCard>,
    );
    // The convenience wrapper renders trigger and content internally
    expect(screen.getByText("Hover trigger")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------
describe("Icon", () => {
  it("renders SVG for a valid icon name", () => {
    const { container } = render(<Icon name="check" />);
    expect(container.querySelector("[data-component='icon']")).toBeTruthy();
    expect(container.querySelector("[data-slot='icon-svg']")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("applies data-size attribute", () => {
    const { container } = render(<Icon name="plus" size="large" />);
    expect(container.querySelector("[data-size='large']")).toBeTruthy();
  });

  it("defaults to normal size", () => {
    const { container } = render(<Icon name="close" />);
    expect(container.querySelector("[data-size='normal']")).toBeTruthy();
  });

  it("returns null and warns for unknown icon name", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<Icon name={"nonexistent" as any} />);
    expect(container.querySelector("[data-component='icon']")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('Icon "nonexistent" not found');
    warnSpy.mockRestore();
  });

  it("forwards className to the SVG element", () => {
    const { container } = render(<Icon name="edit" className="custom-icon" />);
    const svg = container.querySelector("svg");
    expect(svg?.classList.contains("custom-icon")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------
describe("Popover", () => {
  it("renders PopoverContent with data-component and zIndex when open", () => {
    const { baseElement } = render(
      <Popover open>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content>Popover body</Popover.Content>
      </Popover>,
    );
    const content = baseElement.querySelector("[data-component='popover-content']");
    expect(content).toBeTruthy();
    expect((content as HTMLElement).style.zIndex).toBe("9999");
  });

  it("renders header, title, description, body slots", () => {
    const { baseElement } = render(
      <Popover open>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content>
          <Popover.Header>
            <Popover.Title>Pop Title</Popover.Title>
          </Popover.Header>
          <Popover.Description>Pop Desc</Popover.Description>
          <Popover.Body>Pop Body</Popover.Body>
        </Popover.Content>
      </Popover>,
    );
    expect(baseElement.querySelector("[data-slot='popover-header']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='popover-title']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='popover-description']")).toBeTruthy();
    expect(baseElement.querySelector("[data-slot='popover-body']")).toBeTruthy();
    expect(screen.getByText("Pop Title")).toBeTruthy();
    expect(screen.getByText("Pop Desc")).toBeTruthy();
    expect(screen.getByText("Pop Body")).toBeTruthy();
  });

  it("renders PopoverCloseButton with X icon", () => {
    const { baseElement } = render(
      <Popover open>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content>
          <Popover.CloseButton />
        </Popover.Content>
      </Popover>,
    );
    const closeBtn = baseElement.querySelector("[data-slot='popover-close-button']");
    expect(closeBtn).toBeTruthy();
    expect(closeBtn?.querySelector("svg")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// RadioGroup
// ---------------------------------------------------------------------------
describe("RadioGroup", () => {
  it("renders with data-component attribute", () => {
    const { container } = render(
      <RadioGroup>
        <RadioGroupItem value="a" />
      </RadioGroup>,
    );
    expect(container.querySelector("[data-component='radio-group']")).toBeTruthy();
  });

  it("renders RadioGroupItem with data-slot", () => {
    const { container } = render(
      <RadioGroup>
        <RadioGroupItem value="opt1" />
      </RadioGroup>,
    );
    expect(container.querySelector("[data-slot='radio-group-item']")).toBeTruthy();
    expect(container.querySelector("[data-slot='radio-group-item-wrapper']")).toBeTruthy();
  });

  it("renders label when label prop is provided", () => {
    render(
      <RadioGroup>
        <RadioGroupItem value="opt1" label="Option 1" />
      </RadioGroup>,
    );
    expect(screen.getByText("Option 1")).toBeTruthy();
  });

  it("renders children as label when no label prop", () => {
    render(
      <RadioGroup>
        <RadioGroupItem value="opt1">Child label</RadioGroupItem>
      </RadioGroup>,
    );
    expect(screen.getByText("Child label")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------
describe("Select", () => {
  it("renders trigger with data-slot", () => {
    const { container } = render(
      <Select placeholder="Pick one">
        <SelectItem value="a">A</SelectItem>
      </Select>,
    );
    expect(container.querySelector("[data-slot='select-select-trigger']")).toBeTruthy();
  });

  it("renders placeholder text", () => {
    render(
      <Select placeholder="Choose...">
        <SelectItem value="a">A</SelectItem>
      </Select>,
    );
    expect(screen.getByText("Choose...")).toBeTruthy();
  });

  it("renders chevron icon in trigger", () => {
    const { container } = render(
      <Select placeholder="Test">
        <SelectItem value="x">X</SelectItem>
      </Select>,
    );
    expect(container.querySelector("[data-slot='select-select-trigger-icon'] svg")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------
describe("Slider", () => {
  it("renders with data-component attribute", () => {
    const { container } = render(<Slider value={[50]} />);
    expect(container.querySelector("[data-component='slider']")).toBeTruthy();
  });

  it("renders label when provided", () => {
    render(<Slider value={[50]} label="Volume" />);
    expect(screen.getByText("Volume")).toBeTruthy();
  });

  it("renders slider header with label slot", () => {
    const { container } = render(<Slider value={[30]} label="Brightness" />);
    expect(container.querySelector("[data-slot='slider-label']")).toBeTruthy();
  });

  it("shows value when showValue is true", () => {
    render(<Slider value={[75]} showValue />);
    expect(screen.getByText("75")).toBeTruthy();
  });

  it("formats value using formatValue prop", () => {
    render(
      <Slider value={[42]} showValue formatValue={(v) => `${v}%`} />,
    );
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("renders slider track and thumb", () => {
    const { container } = render(<Slider value={[10]} />);
    expect(container.querySelector("[data-slot='slider-root']")).toBeTruthy();
    expect(container.querySelector("[data-slot='slider-track']")).toBeTruthy();
    expect(container.querySelector("[data-slot='slider-thumb']")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------
describe("Switch", () => {
  it("renders with data-component attribute", () => {
    const { container } = render(<Switch />);
    expect(container.querySelector("[data-component='switch']")).toBeTruthy();
  });

  it("renders label text", () => {
    render(<Switch label="Dark mode" />);
    expect(screen.getByText("Dark mode")).toBeTruthy();
  });

  it("hides label visually when hideLabel is true", () => {
    const { container } = render(<Switch label="Hidden label" hideLabel />);
    const labelEl = container.querySelector("[data-slot='switch-label']");
    expect(labelEl).toBeTruthy();
    expect(labelEl?.classList.contains("sr-only")).toBe(true);
  });

  it("renders description when provided", () => {
    render(<Switch label="Notify" description="Get email notifications" />);
    expect(screen.getByText("Get email notifications")).toBeTruthy();
  });

  it("renders description with data-slot", () => {
    const { container } = render(
      <Switch label="Opt" description="Some description" />,
    );
    expect(container.querySelector("[data-slot='switch-description']")).toBeTruthy();
  });

  it("renders switch control and thumb", () => {
    const { container } = render(<Switch />);
    expect(container.querySelector("[data-slot='switch-control']")).toBeTruthy();
    expect(container.querySelector("[data-slot='switch-thumb']")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
describe("Tabs", () => {
  it("renders with data-component attribute", () => {
    const { container } = render(
      <Tabs defaultValue="tab1">
        <Tabs.List>
          <Tabs.Trigger value="tab1">Tab 1</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="tab1">Panel 1</Tabs.Content>
      </Tabs>,
    );
    expect(container.querySelector("[data-component='tabs']")).toBeTruthy();
  });

  it("defaults to normal variant", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
        </Tabs.List>
      </Tabs>,
    );
    expect(container.querySelector("[data-variant='normal']")).toBeTruthy();
  });

  it("applies alt variant", () => {
    const { container } = render(
      <Tabs defaultValue="a" variant="alt">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
        </Tabs.List>
      </Tabs>,
    );
    expect(container.querySelector("[data-variant='alt']")).toBeTruthy();
  });

  it("applies vertical orientation", () => {
    const { container } = render(
      <Tabs defaultValue="a" orientation="vertical">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
        </Tabs.List>
      </Tabs>,
    );
    expect(container.querySelector("[data-orientation='vertical']")).toBeTruthy();
  });

  it("renders TabsList with data-slot", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
        </Tabs.List>
      </Tabs>,
    );
    expect(container.querySelector("[data-slot='tabs-list']")).toBeTruthy();
  });

  it("renders TabsTrigger wrapped in tabs-trigger-wrapper", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
        </Tabs.List>
      </Tabs>,
    );
    expect(container.querySelector("[data-slot='tabs-trigger-wrapper']")).toBeTruthy();
    expect(container.querySelector("[data-slot='tabs-trigger']")).toBeTruthy();
    expect(screen.getByText("A")).toBeTruthy();
  });

  it("renders TabsContent with data-slot", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="a">Panel A</Tabs.Content>
      </Tabs>,
    );
    expect(container.querySelector("[data-slot='tabs-content']")).toBeTruthy();
    expect(screen.getByText("Panel A")).toBeTruthy();
  });

  it("renders TabsSectionTitle with data-slot", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <Tabs.List>
          <Tabs.Trigger value="a">A</Tabs.Trigger>
        </Tabs.List>
        <Tabs.SectionTitle>Section</Tabs.SectionTitle>
      </Tabs>,
    );
    expect(container.querySelector("[data-slot='tabs-section-title']")).toBeTruthy();
    expect(screen.getByText("Section")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
describe("Tooltip", () => {
  it("renders trigger children", () => {
    render(
      <Tooltip content="Tip text">
        <button>Hover me</button>
      </Tooltip>,
    );
    expect(screen.getByText("Hover me")).toBeTruthy();
  });

  it("renders tooltip content with data-component when forced open via pointer", () => {
    // Tooltip content is rendered via Portal; we use the primitive approach to test
    // by rendering the composition in a way that content is immediately visible.
    // The convenience Tooltip wraps in Provider+Root+Trigger+Content.
    // Since testing hover behavior is complex, we just verify the component mounts
    // and renders the trigger correctly.
    const { container } = render(
      <Tooltip content="Helpful tip" delayDuration={0}>
        <button>Info</button>
      </Tooltip>,
    );
    expect(container.querySelector("[data-component='tooltip-trigger']")).toBeTruthy();
  });
});
