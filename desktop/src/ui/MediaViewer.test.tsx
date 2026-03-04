import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MediaViewer } from "./MediaViewer";
import type { MediaItem } from "./MediaViewer";

describe("MediaViewer", () => {
  describe("empty state", () => {
    it("shows placeholder when item is null", () => {
      render(<MediaViewer item={null} />);
      expect(screen.getByText("Media Viewer")).toBeTruthy();
      expect(screen.getByText("Select an attachment to preview here.")).toBeTruthy();
    });
  });

  describe("media type inference from mimeType", () => {
    it("renders an image for image/* mimeType", () => {
      const item: MediaItem = {
        url: "https://example.com/photo.png",
        mimeType: "image/png",
        label: "Photo",
      };
      render(<MediaViewer item={item} />);
      const img = screen.getByRole("img");
      expect(img).toBeTruthy();
      expect(img.getAttribute("src")).toBe("https://example.com/photo.png");
      expect(img.getAttribute("alt")).toBe("Photo");
    });

    it("renders a video for video/* mimeType", () => {
      const item: MediaItem = {
        url: "https://example.com/clip.mp4",
        mimeType: "video/mp4",
      };
      const { container } = render(<MediaViewer item={item} />);
      const video = container.querySelector("video");
      expect(video).toBeTruthy();
      expect(video?.getAttribute("src")).toBe("https://example.com/clip.mp4");
    });

    it("renders audio for audio/* mimeType", () => {
      const item: MediaItem = {
        url: "https://example.com/track.mp3",
        mimeType: "audio/mpeg",
      };
      const { container } = render(<MediaViewer item={item} />);
      const audio = container.querySelector("audio");
      expect(audio).toBeTruthy();
    });
  });

  describe("media type inference from file extension", () => {
    it("detects image from extension when no mimeType", () => {
      const item: MediaItem = { url: "https://example.com/img.jpg" };
      render(<MediaViewer item={item} />);
      expect(screen.getByRole("img")).toBeTruthy();
    });

    it("detects video from extension", () => {
      const item: MediaItem = { url: "https://example.com/movie.webm" };
      const { container } = render(<MediaViewer item={item} />);
      expect(container.querySelector("video")).toBeTruthy();
    });

    it("detects audio from extension", () => {
      const item: MediaItem = { url: "https://example.com/song.wav" };
      const { container } = render(<MediaViewer item={item} />);
      expect(container.querySelector("audio")).toBeTruthy();
    });

    it("detects image from localPath extension", () => {
      const item: MediaItem = { localPath: "C:\\images\\photo.png" };
      render(<MediaViewer item={item} />);
      expect(screen.getByRole("img")).toBeTruthy();
    });
  });

  describe("unknown media type", () => {
    it("shows unsupported message for unknown type", () => {
      const item: MediaItem = { url: "https://example.com/file.xyz" };
      render(<MediaViewer item={item} />);
      expect(screen.getByText("Unsupported media type.")).toBeTruthy();
    });

    it("shows open source link when URL is available", () => {
      const item: MediaItem = { url: "https://example.com/file.xyz" };
      render(<MediaViewer item={item} />);
      const link = screen.getByText("Open source");
      expect(link.getAttribute("href")).toBe("https://example.com/file.xyz");
    });

    it("does not show open source link when no URL", () => {
      const item: MediaItem = { mimeType: "application/octet-stream" };
      render(<MediaViewer item={item} />);
      expect(screen.queryByText("Open source")).toBeNull();
    });
  });

  describe("localPath URL conversion", () => {
    it("converts backslash paths to file:// URLs", () => {
      const item: MediaItem = {
        localPath: "C:\\folder\\image.png",
        mimeType: "image/png",
      };
      render(<MediaViewer item={item} />);
      const img = screen.getByRole("img");
      const src = img.getAttribute("src");
      expect(src).toContain("file://");
      expect(src).toContain("C");
    });

    it("prefers url over localPath", () => {
      const item: MediaItem = {
        url: "https://cdn.example.com/img.png",
        localPath: "/local/img.png",
        mimeType: "image/png",
      };
      render(<MediaViewer item={item} />);
      const img = screen.getByRole("img");
      expect(img.getAttribute("src")).toBe("https://cdn.example.com/img.png");
    });
  });

  describe("clear button", () => {
    it("shows clear button when onClear is provided", () => {
      const item: MediaItem = { url: "https://example.com/img.png", mimeType: "image/png" };
      render(<MediaViewer item={item} onClear={() => {}} />);
      expect(screen.getByText("Clear")).toBeTruthy();
    });

    it("does not show clear button when onClear is omitted", () => {
      const item: MediaItem = { url: "https://example.com/img.png", mimeType: "image/png" };
      render(<MediaViewer item={item} />);
      expect(screen.queryByText("Clear")).toBeNull();
    });

    it("calls onClear when button is clicked", () => {
      const onClear = vi.fn();
      const item: MediaItem = { url: "https://example.com/img.png", mimeType: "image/png" };
      render(<MediaViewer item={item} onClear={onClear} />);

      fireEvent.click(screen.getByText("Clear"));
      expect(onClear).toHaveBeenCalledTimes(1);
    });
  });

  describe("header", () => {
    it("uses label as title when provided", () => {
      const item: MediaItem = { url: "https://example.com/img.png", mimeType: "image/png", label: "Custom Title" };
      render(<MediaViewer item={item} />);
      expect(screen.getByText("Custom Title")).toBeTruthy();
    });

    it("falls back to Media Viewer when no label", () => {
      const item: MediaItem = { url: "https://example.com/img.png", mimeType: "image/png" };
      render(<MediaViewer item={item} />);
      expect(screen.getByText("Media Viewer")).toBeTruthy();
    });
  });
});
