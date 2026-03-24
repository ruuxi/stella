import { dispatchStellaSendMessage } from "@/shared/lib/stella-send-message"
import "./home-canvas.css"

/* ── Content ── */

const USER_NAME = "Name"

const HERO_LEAD =
  "Stella lives on your computer and knows your projects, tools, and workflow."
const HERO_SUBTLE = "Personalized to how you work."

const SECTIONS = [
  {
    title: "Projects",
    kind: "list" as const,
    items: [
      { label: "nightowl", detail: "A sleep tracking app — React Native, Firebase" },
      { label: "bento", detail: "Recipe manager with meal planning" },
      { label: "patchwork", detail: "Open source contribution tracker" },
    ],
  },
  {
    title: "Tools & stack",
    kind: "tags" as const,
    tags: ["React", "TypeScript", "Figma", "Notion", "Linear", "Postgres", "Tailwind"],
  },
  {
    title: "Learning",
    kind: "prose" as const,
    text: "Exploring systems design, accessibility patterns, and how to ship side projects faster without burning out.",
  },
  {
    title: "Interests",
    kind: "tags" as const,
    tags: ["Film photography", "Bouldering", "Vinyl records", "Sci-fi novels"],
  },
]

type GuideItem = { title: string; example: string }
type GuideCategory = { title: string; items: GuideItem[] }

const GUIDE: GuideCategory[] = [
  {
    title: "Build & Create",
    items: [
      { title: "Build an app", example: "\"Build a habit tracker with weekly streaks\"" },
      { title: "Generate media", example: "\"Design a minimal poster for my bouldering gym\"" },
      { title: "Generate music", example: "\"Lo-fi beats with soft piano for focusing\"" },
    ],
  },
  {
    title: "Automate & Schedule",
    items: [
      { title: "Morning briefing", example: "\"Every morning, check the weather and my calendar\"" },
      { title: "Monitor a topic", example: "\"Watch for new sci-fi book releases this month\"" },
    ],
  },
  {
    title: "Use Your Computer",
    items: [
      { title: "Browse for you", example: "\"Open Notion and find my meal planning page\"" },
      { title: "Search your files", example: "\"Find all the TODO comments in my nightowl project\"" },
    ],
  },
  {
    title: "Connect Everywhere",
    items: [
      { title: "Text from your phone", example: "Reach Stella via iMessage, Discord, Slack, or Telegram" },
      { title: "Teach Stella about you", example: "\"Remember I like dark mode and minimal UI\"" },
    ],
  },
]

/* ── Component ── */

export function HomeCanvas() {
  const handleSayHi = () => {
    dispatchStellaSendMessage({ text: "Hey Stella!" })
  }

  return (
    <div className="hc">
      <section className="hc-hero">
        <div className="hc-hero-row">
          <h1 className="hc-hero-title">
            <em>Welcome</em> {USER_NAME},<br />
            your home
          </h1>
          <button className="hc-cta" onClick={handleSayHi}>Say hi to Stella</button>
        </div>
        <p className="hc-lead">{HERO_LEAD}</p>
        <p className="hc-lead-subtle">{HERO_SUBTLE}</p>
      </section>

      <div className="hc-body">
        <div className="hc-left">
          {SECTIONS.map((section, i) => (
            <div key={section.title}>
              {i > 0 && <hr className="hc-rule" />}
              <section className="hc-section">
                <h2 className="hc-heading">{section.title}</h2>

                {section.kind === "list" && (
                  <div className="hc-projects">
                    {section.items!.map((item) => (
                      <div key={item.label} className="hc-project">
                        <span className="hc-project-name">{item.label}</span>
                        <span className="hc-project-desc">{item.detail}</span>
                      </div>
                    ))}
                  </div>
                )}

                {section.kind === "tags" && (
                  <div className="hc-tags">
                    {section.tags!.map((t) => (
                      <span key={t} className="hc-tag">{t}</span>
                    ))}
                  </div>
                )}

                {section.kind === "prose" && (
                  <p className="hc-prose">{section.text}</p>
                )}
              </section>
            </div>
          ))}
        </div>

        <div className="hc-guide">
          <h3 className="hc-guide-title">Things Stella can do for you</h3>
          {GUIDE.map((cat) => (
            <div key={cat.title} className="hc-guide-category">
              <div className="hc-guide-category-title">{cat.title}</div>
              <div className="hc-guide-items">
                {cat.items.map((item) => (
                  <div
                    key={item.title}
                    className="hc-guide-item"
                  >
                    <span className="hc-guide-item-title">{item.title}</span>
                    <span className="hc-guide-item-example">{item.example}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
