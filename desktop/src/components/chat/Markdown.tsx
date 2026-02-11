import type { ImgHTMLAttributes } from "react";
import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import {
  createTwitchEmoteRemarkPlugin,
  isMarkedEmoteUrl,
  stripEmoteUrlMarker,
} from "./emotes/remark-twitch-emotes";
import { useEmojiEmoteLookup } from "./emotes/twitch-emotes";
import "./markdown.css";

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;
  isAnimating?: boolean;
  enableEmotes?: boolean;
}

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  node?: unknown;
};

export function Markdown({
  text,
  className,
  isAnimating = false,
  enableEmotes = false,
}: MarkdownProps) {
  const emojiLookup = useEmojiEmoteLookup(enableEmotes);
  const remarkPlugins = useMemo(() => {
    if (!enableEmotes || !emojiLookup || emojiLookup.size === 0) {
      return undefined;
    }
    return [createTwitchEmoteRemarkPlugin(emojiLookup)];
  }, [enableEmotes, emojiLookup]);

  const components = useMemo(() => {
    if (!enableEmotes) {
      return undefined;
    }

    return {
      img: ({ src, className, ...props }: MarkdownImageProps) => {
        const resolvedSrc = typeof src === "string" ? src : "";
        if (!resolvedSrc) {
          return <img {...props} src={resolvedSrc} className={className} />;
        }

        if (!isMarkedEmoteUrl(resolvedSrc)) {
          return <img {...props} src={resolvedSrc} className={className} />;
        }

        return (
          <img
            {...props}
            src={stripEmoteUrlMarker(resolvedSrc)}
            className={cn("stella-inline-emote", className)}
            draggable={false}
          />
        );
      },
    };
  }, [enableEmotes]);

  return (
    <Streamdown
      isAnimating={isAnimating}
      className={cn("markdown", className)}
      remarkPlugins={remarkPlugins}
      components={components}
    >
      {text}
    </Streamdown>
  );
}
