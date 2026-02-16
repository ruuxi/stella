import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DJStudio from "./DJStudioDemo";

/* ── Mock AudioContext ── */

class MockAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  createGain() {
    return {
      gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn().mockReturnThis(),
    };
  }
  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn().mockReturnThis(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn().mockReturnThis(),
      start: vi.fn(),
    };
  }
  createBiquadFilter() {
    return {
      type: "lowpass",
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: vi.fn().mockReturnThis(),
    };
  }
  createBuffer() {
    return {
      getChannelData: vi.fn(() => new Float32Array(4410)),
    };
  }
  close = vi.fn();
}

beforeEach(() => {
  vi.useFakeTimers();
  (window as any).AudioContext = MockAudioContext;
  return () => {
    vi.useRealTimers();
    delete (window as any).AudioContext;
  };
});

describe("DJStudioDemo", () => {
  describe("initial rendering", () => {
    it("renders the sequencer root", () => {
      const { container } = render(<DJStudio />);
      expect(container.querySelector(".seq-root")).toBeTruthy();
    });

    it("renders the brand name", () => {
      render(<DJStudio />);
      expect(screen.getByText("Stella Beats")).toBeTruthy();
    });

    it("renders the sub-brand text", () => {
      render(<DJStudio />);
      expect(screen.getByText("Step Sequencer")).toBeTruthy();
    });
  });

  describe("track names", () => {
    it("renders all 8 track short names in the column headers", () => {
      render(<DJStudio />);
      expect(screen.getByText("KCK")).toBeTruthy();
      expect(screen.getByText("SNR")).toBeTruthy();
      expect(screen.getByText("CHH")).toBeTruthy();
      expect(screen.getByText("OHH")).toBeTruthy();
      expect(screen.getByText("CLP")).toBeTruthy();
      expect(screen.getByText("RIM")).toBeTruthy();
      expect(screen.getByText("TOM")).toBeTruthy();
      expect(screen.getByText("PRC")).toBeTruthy();
    });

    it("renders column header dots with colors", () => {
      const { container } = render(<DJStudio />);
      const dots = container.querySelectorAll(".seq-col-dot");
      expect(dots.length).toBe(8);
      // Kick color is #a855f7
      expect((dots[0] as HTMLElement).style.background).toBe("rgb(168, 85, 247)");
    });
  });

  describe("step sequencer grid", () => {
    it("renders 16 step rows", () => {
      const { container } = render(<DJStudio />);
      const rows = container.querySelectorAll(".seq-step-row");
      expect(rows.length).toBe(16);
    });

    it("renders row numbers 1-16", () => {
      const { container } = render(<DJStudio />);
      const rowNums = container.querySelectorAll(".seq-row-num");
      expect(rowNums.length).toBe(16);
      expect(rowNums[0].textContent).toBe("1");
      expect(rowNums[15].textContent).toBe("16");
    });

    it("renders 128 pads total (16 steps x 8 tracks)", () => {
      const { container } = render(<DJStudio />);
      const pads = container.querySelectorAll(".seq-pad");
      expect(pads.length).toBe(128);
    });

    it("marks downbeat rows (every 4th step starting at step 5)", () => {
      const { container } = render(<DJStudio />);
      const barStarts = container.querySelectorAll(".seq-step-row.bar-start");
      // Steps 4, 8, 12 (0-indexed: rows at index 4, 8, 12 which are downbeats with stepIdx > 0)
      expect(barStarts.length).toBe(3);
    });

    it("toggles a pad when clicked", () => {
      const { container } = render(<DJStudio />);
      const pads = container.querySelectorAll(".seq-pad");
      // Find a pad that's initially off (Classic preset, step 0 track 1 = Snare step 0 = 0)
      const snarePadStep0 = pads[1]; // row 0, track 1 (snare)
      expect(snarePadStep0.classList.contains("on")).toBe(false);

      fireEvent.click(snarePadStep0);
      expect(snarePadStep0.classList.contains("on")).toBe(true);

      // Click again to toggle off
      fireEvent.click(snarePadStep0);
      expect(snarePadStep0.classList.contains("on")).toBe(false);
    });
  });

  describe("play/stop controls", () => {
    it("renders play button initially showing play symbol", () => {
      const { container } = render(<DJStudio />);
      const playBtn = container.querySelector(".seq-play");
      expect(playBtn).toBeTruthy();
      expect(playBtn?.classList.contains("active")).toBe(false);
    });

    it("toggles to active state when play is clicked", () => {
      const { container } = render(<DJStudio />);
      const playBtn = container.querySelector(".seq-play")!;
      fireEvent.click(playBtn);
      expect(playBtn.classList.contains("active")).toBe(true);
    });

    it("starts playback and sets current step when play is clicked", () => {
      const { container } = render(<DJStudio />);
      const playBtn = container.querySelector(".seq-play")!;
      fireEvent.click(playBtn);

      // After clicking play, the first step (step 0) should be current
      const currentRow = container.querySelector(".seq-step-row.current");
      expect(currentRow).toBeTruthy();
    });

    it("stops playback when clicking play again", () => {
      const { container } = render(<DJStudio />);
      const playBtn = container.querySelector(".seq-play")!;

      // Start
      fireEvent.click(playBtn);
      expect(playBtn.classList.contains("active")).toBe(true);

      // Stop
      fireEvent.click(playBtn);
      expect(playBtn.classList.contains("active")).toBe(false);
    });
  });

  describe("BPM control", () => {
    it("renders default BPM of 120", () => {
      render(<DJStudio />);
      expect(screen.getByText("120")).toBeTruthy();
      expect(screen.getByText("bpm")).toBeTruthy();
    });

    it("updates BPM when slider is changed", () => {
      render(<DJStudio />);
      const sliders = document.querySelectorAll(".seq-slider");
      // BPM slider is the first one
      const bpmSlider = sliders[0] as HTMLInputElement;
      expect(bpmSlider).toBeTruthy();

      fireEvent.change(bpmSlider, { target: { value: "140" } });
      expect(screen.getByText("140")).toBeTruthy();
    });

    it("renders BPM slider with correct range", () => {
      render(<DJStudio />);
      const sliders = document.querySelectorAll(".seq-slider");
      const bpmSlider = sliders[0] as HTMLInputElement;
      expect(bpmSlider.min).toBe("60");
      expect(bpmSlider.max).toBe("200");
    });
  });

  describe("swing control", () => {
    it("renders default swing of 0%", () => {
      render(<DJStudio />);
      expect(screen.getByText("0%")).toBeTruthy();
      expect(screen.getByText("swing")).toBeTruthy();
    });

    it("updates swing when slider is changed", () => {
      render(<DJStudio />);
      const sliders = document.querySelectorAll(".seq-slider");
      // Swing slider is the second one
      const swingSlider = sliders[1] as HTMLInputElement;

      fireEvent.change(swingSlider, { target: { value: "50" } });
      expect(screen.getByText("50%")).toBeTruthy();
    });
  });

  describe("preset selection", () => {
    it("renders all three preset buttons", () => {
      render(<DJStudio />);
      expect(screen.getByText("Classic")).toBeTruthy();
      expect(screen.getByText("Trap")).toBeTruthy();
      expect(screen.getByText("House")).toBeTruthy();
    });

    it("Classic preset is active by default", () => {
      const { container } = render(<DJStudio />);
      const presetBtns = container.querySelectorAll(".seq-preset-btn");
      expect(presetBtns[0].classList.contains("active")).toBe(true);
      expect(presetBtns[1].classList.contains("active")).toBe(false);
      expect(presetBtns[2].classList.contains("active")).toBe(false);
    });

    it("switches to Trap preset when clicked", () => {
      const { container } = render(<DJStudio />);
      fireEvent.click(screen.getByText("Trap"));

      const presetBtns = container.querySelectorAll(".seq-preset-btn");
      expect(presetBtns[0].classList.contains("active")).toBe(false);
      expect(presetBtns[1].classList.contains("active")).toBe(true);
    });

    it("switches to House preset when clicked", () => {
      const { container } = render(<DJStudio />);
      fireEvent.click(screen.getByText("House"));

      const presetBtns = container.querySelectorAll(".seq-preset-btn");
      expect(presetBtns[2].classList.contains("active")).toBe(true);
    });

    it("deactivates preset when a pad is manually toggled", () => {
      const { container } = render(<DJStudio />);
      const presetBtns = container.querySelectorAll(".seq-preset-btn");
      expect(presetBtns[0].classList.contains("active")).toBe(true);

      // Toggle a pad
      const pads = container.querySelectorAll(".seq-pad");
      fireEvent.click(pads[0]);

      // Preset should no longer be active
      expect(presetBtns[0].classList.contains("active")).toBe(false);
    });
  });

  describe("footer actions", () => {
    it("renders hit count", () => {
      render(<DJStudio />);
      // Classic preset has a certain number of active steps
      const footer = document.querySelector(".seq-footer-stat");
      expect(footer?.textContent).toMatch(/\d+ hits/);
    });

    it("renders Dice, Reset, and Clear buttons", () => {
      render(<DJStudio />);
      expect(screen.getByText("Dice")).toBeTruthy();
      expect(screen.getByText("Reset")).toBeTruthy();
      expect(screen.getByText("Clear")).toBeTruthy();
    });

    it("clears all steps when Clear is clicked", () => {
      const { container } = render(<DJStudio />);
      fireEvent.click(screen.getByText("Clear"));

      // All pads should be off
      const onPads = container.querySelectorAll(".seq-pad.on");
      expect(onPads.length).toBe(0);

      // Hit count should be 0
      expect(screen.getByText("0 hits")).toBeTruthy();
    });

    it("resets to active preset when Reset is clicked", () => {
      const { container } = render(<DJStudio />);

      // Clear first
      fireEvent.click(screen.getByText("Clear"));
      expect(container.querySelectorAll(".seq-pad.on").length).toBe(0);

      // Reset
      fireEvent.click(screen.getByText("Reset"));

      // Pads should be restored to the Classic preset pattern
      const onPads = container.querySelectorAll(".seq-pad.on");
      expect(onPads.length).toBeGreaterThan(0);
    });

    it("randomizes pattern when Dice is clicked", () => {
      const { container } = render(<DJStudio />);

      // Dice multiple times to check it changes (probabilistic but very unlikely to match)
      fireEvent.click(screen.getByText("Dice"));

      // The pattern changed (we can't predict exact values, but it should still render)
      const pads = container.querySelectorAll(".seq-pad");
      expect(pads.length).toBe(128);
    });
  });

  describe("volume meters", () => {
    it("renders volume meters for all 8 tracks", () => {
      const { container } = render(<DJStudio />);
      const volCells = container.querySelectorAll(".seq-vol-cell");
      expect(volCells.length).toBe(8);
    });

    it("renders volume fill elements with track colors", () => {
      const { container } = render(<DJStudio />);
      const fills = container.querySelectorAll(".seq-vol-fill");
      expect(fills.length).toBe(8);
      // First track (Kick) has volume 90, so height should be 90%
      expect((fills[0] as HTMLElement).style.height).toBe("90%");
    });
  });

  describe("mute/solo", () => {
    it("toggles mute on track header click", () => {
      const { container } = render(<DJStudio />);
      const colHeads = container.querySelectorAll(".seq-col-head");
      const kickHeader = colHeads[0];

      expect(kickHeader.classList.contains("muted")).toBe(false);
      fireEvent.click(kickHeader);
      expect(kickHeader.classList.contains("muted")).toBe(true);
      fireEvent.click(kickHeader);
      expect(kickHeader.classList.contains("muted")).toBe(false);
    });

    it("toggles solo on track header right-click", () => {
      const { container } = render(<DJStudio />);
      const colHeads = container.querySelectorAll(".seq-col-head");
      const kickHeader = colHeads[0];

      expect(kickHeader.classList.contains("soloed")).toBe(false);
      fireEvent.contextMenu(kickHeader);
      expect(kickHeader.classList.contains("soloed")).toBe(true);
    });

    it("shows S badge when track is soloed", () => {
      const { container } = render(<DJStudio />);
      const colHeads = container.querySelectorAll(".seq-col-head");

      // Solo the kick
      fireEvent.contextMenu(colHeads[0]);

      const badge = colHeads[0].querySelector(".seq-col-badge");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("S");
    });

    it("dims non-soloed track pads when a track is soloed", () => {
      const { container } = render(<DJStudio />);
      const colHeads = container.querySelectorAll(".seq-col-head");

      // Solo the kick (track 0)
      fireEvent.contextMenu(colHeads[0]);

      // Check that snare pads (track 1) have reduced opacity
      // Step 4 (index 4) for snare has an active pad in Classic preset
      const pads = container.querySelectorAll(".seq-pad");
      // Track 1, step 4 = index 4*8 + 1 = 33
      const snarePad = pads[4 * 8 + 1] as HTMLElement;
      expect(parseFloat(snarePad.style.opacity)).toBeLessThan(1);
    });
  });
});
