import { useState } from "react"
import { dispatchStellaSendMessage } from "@/shared/lib/stella-send-message"
import "./home-canvas.css"

export function HomeCanvas() {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (prompt: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(prompt)) next.delete(prompt)
      else next.add(prompt)
      return next
    })
  }

  const sendSelected = () => {
    if (selected.size === 0) return
    const text = [...selected].join("\n\n")
    dispatchStellaSendMessage({ text })
    setSelected(new Set())
  }

  return (
    <div className="hc">
      {/* ── Hero ── */}
      <section className="hc-hero">
        <div className="hc-hero-row">
          <h1 className="hc-hero-title">
            <em>Welcome</em> Name,<br />
            your home
          </h1>
          <button
            className="hc-cta"
            onClick={() => dispatchStellaSendMessage({ text: "Hey Stella!" })}
          >
            Say hi to Stella
          </button>
        </div>
        <p className="hc-lead">
          Stella lives on your computer and knows your projects, tools, and workflow.
        </p>
        <p className="hc-lead-subtle">Personalized to how you work.</p>
      </section>

      {/* ── Body ── */}
      <div className="hc-body">
        <div className="hc-left">
          <section className="hc-section">
            <h2 className="hc-heading">Projects</h2>
            <div className="hc-projects">
              <div className="hc-project">
                <span className="hc-project-name">nightowl</span>
                <span className="hc-project-desc">A sleep tracking app — React Native, Firebase</span>
              </div>
              <div className="hc-project">
                <span className="hc-project-name">bento</span>
                <span className="hc-project-desc">Recipe manager with meal planning</span>
              </div>
              <div className="hc-project">
                <span className="hc-project-name">patchwork</span>
                <span className="hc-project-desc">Open source contribution tracker</span>
              </div>
            </div>
          </section>

          <hr className="hc-rule" />

          <section className="hc-section">
            <h2 className="hc-heading">Tools &amp; stack</h2>
            <div className="hc-tags">
              {["React", "TypeScript", "Figma", "Notion", "Linear", "Postgres", "Tailwind"].map((t) => (
                <span key={t} className="hc-tag">{t}</span>
              ))}
            </div>
          </section>

          <hr className="hc-rule" />

          <section className="hc-section">
            <h2 className="hc-heading">Learning</h2>
            <p className="hc-prose">
              Exploring systems design, accessibility patterns, and how to ship
              side projects faster without burning out.
            </p>
          </section>

          <hr className="hc-rule" />

          <section className="hc-section">
            <h2 className="hc-heading">Interests</h2>
            <div className="hc-tags">
              {["Film photography", "Bouldering", "Vinyl records", "Sci-fi novels"].map((t) => (
                <span key={t} className="hc-tag">{t}</span>
              ))}
            </div>
          </section>
        </div>

        {/* ── Guide: selectable prompts ── */}
        <div className="hc-guide">
          <h3 className="hc-guide-title">Try something with Stella</h3>

          <GuideGroup title="Build &amp; Create" selected={selected} toggle={toggle} items={[
            { label: "Build an app", prompt: "Build a habit tracker with weekly streaks" },
            { label: "Generate media", prompt: "Design a minimal poster for my bouldering gym" },
            { label: "Generate music", prompt: "Lo-fi beats with soft piano for focusing" },
          ]} />

          <GuideGroup title="Automate &amp; Schedule" selected={selected} toggle={toggle} items={[
            { label: "Morning briefing", prompt: "Every morning, check the weather and my calendar" },
            { label: "Monitor a topic", prompt: "Watch for new sci-fi book releases this month" },
          ]} />

          <GuideGroup title="Use Your Computer" selected={selected} toggle={toggle} items={[
            { label: "Browse for you", prompt: "Open Notion and find my meal planning page" },
            { label: "Search your files", prompt: "Find all the TODO comments in my nightowl project" },
          ]} />

          {selected.size > 0 && (
            <button className="hc-guide-send" onClick={sendSelected}>
              Send {selected.size} to Stella
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function GuideGroup({ title, items, selected, toggle }: {
  title: string
  items: { label: string; prompt: string }[]
  selected: Set<string>
  toggle: (prompt: string) => void
}) {
  return (
    <div className="hc-guide-category">
      <div className="hc-guide-category-title">{title}</div>
      <div className="hc-guide-items">
        {items.map((item) => (
          <button
            key={item.prompt}
            className={`hc-guide-chip${selected.has(item.prompt) ? " hc-guide-chip--selected" : ""}`}
            onClick={() => toggle(item.prompt)}
          >
            <span className="hc-guide-chip-label">{item.label}</span>
            <span className="hc-guide-chip-prompt">{item.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
