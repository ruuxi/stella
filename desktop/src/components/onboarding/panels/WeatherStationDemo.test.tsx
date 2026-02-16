import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import WeatherStation from "./WeatherStationDemo";

describe("WeatherStationDemo", () => {
  describe("initial rendering", () => {
    it("renders the weather station root", () => {
      const { container } = render(<WeatherStation />);
      expect(container.querySelector(".wx-root")).toBeTruthy();
    });

    it("renders location select with all four locations", () => {
      render(<WeatherStation />);
      const options = screen.getAllByRole("option");
      expect(options.length).toBe(4);
      expect(options[0].textContent).toBe("San Francisco, CA");
      expect(options[1].textContent).toBe("New York, NY");
      expect(options[2].textContent).toBe("London, UK");
      expect(options[3].textContent).toBe("Tokyo, JP");
    });

    it("defaults to New York (index 1) as the initial location", () => {
      render(<WeatherStation />);
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("1");
    });

    it("displays New York temperature in Fahrenheit by default", () => {
      render(<WeatherStation />);
      // New York temp is 55F
      expect(screen.getByText("55\u00B0")).toBeTruthy();
    });

    it("displays New York condition text", () => {
      render(<WeatherStation />);
      expect(screen.getByText("Light Rain")).toBeTruthy();
    });

    it("renders unit toggle buttons for F and C", () => {
      render(<WeatherStation />);
      expect(screen.getByText("\u00B0F")).toBeTruthy();
      expect(screen.getByText("\u00B0C")).toBeTruthy();
    });

    it("renders 7-Day Forecast header", () => {
      render(<WeatherStation />);
      expect(screen.getByText("7-Day Forecast")).toBeTruthy();
    });

    it("renders all 7 forecast days for New York", () => {
      render(<WeatherStation />);
      expect(screen.getByText("Mon")).toBeTruthy();
      expect(screen.getByText("Tue")).toBeTruthy();
      expect(screen.getByText("Wed")).toBeTruthy();
      expect(screen.getByText("Thu")).toBeTruthy();
      expect(screen.getByText("Fri")).toBeTruthy();
      expect(screen.getByText("Sat")).toBeTruthy();
      expect(screen.getByText("Sun")).toBeTruthy();
    });

    it("renders weather stats labels", () => {
      render(<WeatherStation />);
      expect(screen.getByText("Humidity")).toBeTruthy();
      expect(screen.getByText("Wind")).toBeTruthy();
      expect(screen.getByText("UV Index")).toBeTruthy();
      expect(screen.getByText("Pressure")).toBeTruthy();
      expect(screen.getByText("Visibility")).toBeTruthy();
      expect(screen.getByText("Dew Point")).toBeTruthy();
    });

    it("renders New York weather stats values", () => {
      render(<WeatherStation />);
      expect(screen.getByText("82%")).toBeTruthy();
      expect(screen.getByText("18 mph")).toBeTruthy();
      expect(screen.getByText("2")).toBeTruthy(); // UV
      expect(screen.getByText("29.8 in")).toBeTruthy();
      expect(screen.getByText("5 mi")).toBeTruthy();
    });
  });

  describe("location switching", () => {
    it("switches to San Francisco when selected", () => {
      render(<WeatherStation />);
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "0" } });

      expect(screen.getByText("Partly Cloudy")).toBeTruthy();
      expect(screen.getByText("72\u00B0")).toBeTruthy();
    });

    it("switches to London when selected", () => {
      render(<WeatherStation />);
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "2" } });

      expect(screen.getByText("Overcast")).toBeTruthy();
      // London temp = 48F, but 48 also appears as NY dew point when that was previously active.
      // After switching to London, the hero shows 48 degrees.
      expect(screen.getByText("Overcast")).toBeTruthy();
      // Verify the condition changed from "Light Rain" to "Overcast"
      expect(screen.queryByText("Light Rain")).toBeNull();
    });

    it("switches to Tokyo when selected", () => {
      render(<WeatherStation />);
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "3" } });

      expect(screen.getByText("Clear Sky")).toBeTruthy();
      expect(screen.getByText("82\u00B0")).toBeTruthy();
    });

    it("updates stats when switching locations", () => {
      render(<WeatherStation />);
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "0" } });

      // San Francisco stats
      expect(screen.getByText("58%")).toBeTruthy();
      expect(screen.getByText("12 mph")).toBeTruthy();
    });
  });

  describe("temperature unit conversion", () => {
    it("converts to Celsius when C button is clicked", () => {
      render(<WeatherStation />);
      // Default location is New York at 55F
      expect(screen.getByText("55\u00B0")).toBeTruthy();
      fireEvent.click(screen.getByText("\u00B0C"));

      // 55F -> (55-32)*5/9 = 12.78 -> rounded = 13
      // The hero temp should no longer be 55
      expect(screen.queryByText("55\u00B0")).toBeNull();
      // 13 degrees should appear (main temp)
      expect(screen.getAllByText("13\u00B0").length).toBeGreaterThan(0);
    });

    it("converts dew point to Celsius", () => {
      render(<WeatherStation />);
      // New York dew point is 48F
      fireEvent.click(screen.getByText("\u00B0C"));

      // 48F -> (48-32)*5/9 = 8.89 -> rounded = 9
      expect(screen.getAllByText("9\u00B0").length).toBeGreaterThan(0);
    });

    it("switches back to Fahrenheit", () => {
      render(<WeatherStation />);

      // Switch to C first
      fireEvent.click(screen.getByText("\u00B0C"));
      expect(screen.queryByText("55\u00B0")).toBeNull();

      // Switch back to F
      fireEvent.click(screen.getByText("\u00B0F"));
      expect(screen.getByText("55\u00B0")).toBeTruthy();
    });

    it("converts forecast temperatures to Celsius", () => {
      render(<WeatherStation />);
      fireEvent.click(screen.getByText("\u00B0C"));

      // New York Monday high is 56F -> (56-32)*5/9 = 13.33 -> 13
      // New York Monday low is 44F -> (44-32)*5/9 = 6.67 -> 7
      expect(screen.getAllByText("13\u00B0").length).toBeGreaterThan(0);
      expect(screen.getAllByText("7\u00B0").length).toBeGreaterThan(0);
    });
  });

  describe("forecast rendering", () => {
    it("renders forecast high and low temperatures", () => {
      render(<WeatherStation />);
      // New York Monday: high 56, low 44
      expect(screen.getByText("56\u00B0")).toBeTruthy();
      expect(screen.getByText("44\u00B0")).toBeTruthy();
    });

    it("renders forecast items with weather icon containers", () => {
      const { container } = render(<WeatherStation />);
      const forecastIcons = container.querySelectorAll(".wx-forecast-icon");
      expect(forecastIcons.length).toBe(7);
    });

    it("sets correct data-weather attributes on forecast icons", () => {
      const { container } = render(<WeatherStation />);
      const forecastIcons = container.querySelectorAll(".wx-forecast-icon");
      // New York forecast day 1 is rainy
      expect(forecastIcons[0].getAttribute("data-weather")).toBe("rainy");
    });
  });

  describe("hero section", () => {
    it("sets data-weather attribute on hero element", () => {
      const { container } = render(<WeatherStation />);
      const hero = container.querySelector(".wx-hero");
      // Default location is New York which is "rainy"
      expect(hero?.getAttribute("data-weather")).toBe("rainy");
    });

    it("updates hero data-weather when location changes", () => {
      const { container } = render(<WeatherStation />);
      const select = screen.getByRole("combobox") as HTMLSelectElement;

      // Switch to Tokyo (sunny)
      fireEvent.change(select, { target: { value: "3" } });
      const hero = container.querySelector(".wx-hero");
      expect(hero?.getAttribute("data-weather")).toBe("sunny");
    });

    it("renders rain effect elements", () => {
      const { container } = render(<WeatherStation />);
      const raindrops = container.querySelectorAll(".wx-raindrop");
      expect(raindrops.length).toBe(30);
    });

    it("renders cloud effect elements", () => {
      const { container } = render(<WeatherStation />);
      const clouds = container.querySelectorAll(".wx-cloud");
      expect(clouds.length).toBe(4);
    });

    it("renders sun ray elements", () => {
      const { container } = render(<WeatherStation />);
      const rays = container.querySelectorAll(".wx-sun-ray");
      expect(rays.length).toBe(12);
    });
  });
});
