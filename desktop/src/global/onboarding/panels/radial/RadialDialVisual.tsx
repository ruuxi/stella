import { Paperclip, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { runVacuumEffect } from "./region-capture-vacuum";
import { makeCaptureThumbnail } from "./capture-thumbnail";
import { RADIAL_WEDGES } from "./data";

function CaptureVacuumCanvas({
  active,
  wedgeKey,
}: {
  active: boolean;
  wedgeKey: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = canvasRef.current;
    if (!el) return;
    void runVacuumEffect(el, makeCaptureThumbnail(), 0.5, 0.5);
  }, [active, wedgeKey]);

  return <canvas ref={canvasRef} className="radial-result-vacuum" />;
}

export function RadialDialVisual({
  selectedIndex,
  isActive,
}: {
  selectedIndex: number;
  isActive: boolean;
}) {
  const activeWedge = RADIAL_WEDGES[selectedIndex];

  return (
    <div className="radial-demo radial-demo--visual-only">
      <div className="radial-desktop-mock">
        <div className="radial-desktop-mock__titlebar">
          <div className="radial-desktop-mock__traffic">
            <span />
            <span />
            <span />
          </div>
          <div className="radial-desktop-mock__chrome">
            <strong>Stella radial</strong>
            <span>hover a wedge on the left</span>
          </div>
        </div>
        <div className="radial-desktop-mock__screen" data-mode={activeWedge.id}>
          <div className="radial-desktop-mock__ambient">
            <div className="radial-desktop-mock__ambient-card">
              <span>Wedge</span>
              <strong>{activeWedge.label}</strong>
            </div>
            <div className="radial-desktop-mock__ambient-card radial-desktop-mock__ambient-card--soft">
              <span>What it does</span>
              <strong>{activeWedge.heading}</strong>
            </div>
          </div>

          {activeWedge.id === "capture" && (
            <div className="radial-scene radial-scene--capture">
              <div className="radial-scene__taskbar">
                <span className="radial-scene__taskbar-dot" />
                <span>Figma</span>
                <span>Chrome</span>
                <span>Slack</span>
              </div>
              <div className="radial-scene__window radial-scene__window--main">
                <div className="radial-scene__window-bar">
                  <span />
                  <span />
                  <span />
                  <strong>Figma — Homepage redesign</strong>
                </div>
                <div className="radial-scene__window-body radial-scene__design-canvas">
                  <div className="radial-scene__design-sidebar" />
                  <div className="radial-scene__design-artboard">
                    <div className="radial-scene__design-frame" />
                    <div className="radial-scene__design-frame radial-scene__design-frame--small" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeWedge.id === "chat" && (
            <div className="radial-scene radial-scene--chat">
              <div className="radial-scene__taskbar">
                <span className="radial-scene__taskbar-dot" />
                <span>Safari</span>
                <span>Notes</span>
              </div>
              <div className="radial-scene__window radial-scene__window--main">
                <div className="radial-scene__window-bar">
                  <span />
                  <span />
                  <span />
                  <strong>allrecipes.com — Thai basil chicken</strong>
                </div>
                <div className="radial-scene__window-body radial-scene__recipe">
                  <div className="radial-scene__recipe-hero" />
                  <div className="radial-scene__recipe-text">
                    <div className="radial-scene__text-line radial-scene__text-line--title" />
                    <div className="radial-scene__text-line" />
                    <div className="radial-scene__text-line radial-scene__text-line--short" />
                    <div className="radial-scene__text-line" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeWedge.id === "add" && (
            <div className="radial-scene radial-scene--add">
              <div className="radial-scene__taskbar">
                <span className="radial-scene__taskbar-dot" />
                <span>Chrome</span>
                <span>Stella</span>
              </div>
              <div className="radial-scene__window radial-scene__window--main">
                <div className="radial-scene__window-bar">
                  <span />
                  <span />
                  <span />
                  <strong>en.wikipedia.org — Photosynthesis</strong>
                </div>
                <div className="radial-scene__window-body radial-scene__article">
                  <div className="radial-scene__article-hero" />
                  <div className="radial-scene__article-body">
                    <div className="radial-scene__text-line radial-scene__text-line--title" />
                    <div className="radial-scene__text-line" />
                    <div className="radial-scene__text-line" />
                    <div className="radial-scene__text-line radial-scene__text-line--short" />
                    <div className="radial-scene__text-line" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeWedge.id === "voice" && (
            <div className="radial-scene radial-scene--voice">
              <div className="radial-scene__taskbar">
                <span className="radial-scene__taskbar-dot" />
                <span>Notes</span>
                <span>Calendar</span>
              </div>
              <div className="radial-scene__window radial-scene__window--main">
                <div className="radial-scene__window-bar">
                  <span />
                  <span />
                  <span />
                  <strong>Notes — Meeting prep</strong>
                </div>
                <div className="radial-scene__window-body radial-scene__notes">
                  <div className="radial-scene__notes-sidebar">
                    <div className="radial-scene__text-line radial-scene__text-line--short" />
                    <div className="radial-scene__text-line radial-scene__text-line--short" />
                    <div className="radial-scene__text-line radial-scene__text-line--short" />
                  </div>
                  <div className="radial-scene__notes-body">
                    <div className="radial-scene__text-line radial-scene__text-line--title" />
                    <div className="radial-scene__text-line" />
                    <div className="radial-scene__text-line radial-scene__text-line--short" />
                    <div className="radial-scene__text-line" />
                    <div className="radial-scene__text-line radial-scene__text-line--short" />
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="radial-desktop-mock__result radial-desktop-mock__result--visible">
            {activeWedge.id === "capture" && (
              <>
                <CaptureVacuumCanvas active={isActive} wedgeKey={selectedIndex} />
                <div className="radial-result-minishell radial-result-minishell--capture">
                  <div className="radial-result-minishell__badge">
                    Captured: Figma — Homepage redesign
                  </div>
                  <div className="radial-result-minishell__capture-thumb" />
                  <div className="radial-result-minishell__composer">
                    <Search size={13} />
                    <span>Ask about this design...</span>
                  </div>
                </div>
              </>
            )}

            {activeWedge.id === "chat" && (
              <div className="radial-result-minishell">
                <div className="radial-result-minishell__badge">
                  allrecipes.com — Thai basil chicken
                </div>
                <div className="radial-result-minishell__bubble radial-result-minishell__bubble--stella">
                  I can see you&apos;re reading a recipe. Need help with substitutions
                  or measurements?
                </div>
                <div className="radial-result-minishell__composer">
                  <Search size={13} />
                  <span>Ask Stella about this recipe...</span>
                </div>
              </div>
            )}

            {activeWedge.id === "add" && (
              <div className="radial-result-minishell radial-result-minishell--add">
                <div className="radial-result-minishell__badge">
                  Added to current chat
                </div>
                <div className="radial-result-minishell__chip">
                  <Paperclip size={12} />
                  <span>Wikipedia — Photosynthesis</span>
                  <em>region</em>
                </div>
                <div className="radial-result-minishell__bubble radial-result-minishell__bubble--stella">
                  Pinned. I&apos;ll keep this in mind for the rest of our chat.
                </div>
                <div className="radial-result-minishell__composer">
                  <Search size={13} />
                  <span>Keep going where you left off...</span>
                </div>
              </div>
            )}

            {activeWedge.id === "voice" && (
              <div className="radial-result-voice">
                <div className="radial-result-voice__wave">
                  <div className="radial-result-voice__bars">
                    {Array.from({ length: 24 }).map((_, i) => (
                      <span key={i} style={{ animationDelay: `${i * 60}ms` }} />
                    ))}
                  </div>
                </div>
                <div className="radial-result-minishell radial-result-minishell--voice">
                  <div className="radial-result-minishell__badge">
                    Voice transcription
                  </div>
                  <div className="radial-result-minishell__bubble radial-result-minishell__bubble--user">
                    &ldquo;Add the quarterly budget numbers to my meeting notes&rdquo;
                  </div>
                  <div className="radial-result-minishell__composer">
                    <Search size={13} />
                    <span>Listening...</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
