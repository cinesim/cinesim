import Link from "next/link";
import type { Metadata } from "next";
import "@/styles/home.css";

export const metadata: Metadata = {
  title: "Cinesim — Edit with intent",
  description: "A local-first, agent-native video editor.",
};

const principles = [
  ["Local", "Where the work lives", "Ordinary folders on your disk"],
  ["One model", "Editor, CLI, and agents", "Every tool speaks the same edits"],
  ["Readable", "Project format", "Deterministic files you can diff"],
  ["Undoable", "Every gesture", "One intentional, reversible edit"],
];

const faqs = [
  [
    "What is Cinesim?",
    "A local-first video editor where the timeline, the CLI, and agent tools all operate on the same validated project model — so the cut you see is the cut every tool is working from.",
  ],
  [
    "Where do my project files live?",
    "In an ordinary folder on your disk. A project is a cinesim.json manifest plus a .cinesim directory of deterministic JSON. Generated media stays in .video and is always disposable.",
  ],
  [
    "How do agents fit in?",
    "Local Codex or Claude Code sessions connect through a scoped bridge. Every change arrives as a reviewable edit: inspect the diff, undo it, or restore a checkpoint.",
  ],
  [
    "Do I need an account?",
    "No. The editor is useful offline, signed out, and working from a plain folder. Cloud storage is planned and optional.",
  ],
  [
    "Is Cinesim available yet?",
    "It is in active development. This site previews V1 — the pricing page is a product preview rather than a checkout.",
  ],
];

export default function HomePage() {
  return (
    <>
      <section className="hero wrap">
        <div className="hero-copy">
          <h1 className="hero-title">A video editor that works with your agents.</h1>
          <div className="hero-actions">
            <a className="button primary" href="#product">
              Explore the editor <span className="arrow">↓</span>
            </a>
            <Link className="button" href="/docs">
              Read the docs <span className="arrow">→</span>
            </Link>
          </div>
        </div>

        <div className="hero-stage">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="stage-bg"
            src="/images/hero-coast.png"
            alt="A concrete coastal structure at blue hour"
          />
          <div className="editor-window" aria-hidden="true">
            <div className="window-bar">
              <span className="lights">
                <i />
                <i />
                <i />
              </span>
              <span>Cinesim — Mira</span>
              <span className="window-key">⌘K</span>
            </div>
            <div className="editor-body">
              <aside className="pane media-pool">
                <p className="pane-title">Media pool</p>
                <div className="asset selected" />
                <div className="asset" />
                <div className="asset short" />
              </aside>
              <section className="viewer">
                <div className="pane-bar">
                  <span>Viewer</span>
                  <span>Fit · 00:01:42:12</span>
                </div>
                <div className="viewer-frame">
                  <img src="/images/salt-flat.png" alt="" />
                </div>
              </section>
              <aside className="pane inspector">
                <p className="pane-title">Inspector</p>
                <div className="field">
                  <span>Position</span>
                  <b>0.0, 0.0</b>
                </div>
                <div className="field">
                  <span>Scale</span>
                  <b>100%</b>
                </div>
                <div className="field">
                  <span>Opacity</span>
                  <b>100%</b>
                </div>
              </aside>
              <section className="timeline">
                <div className="pane-bar">
                  <span>Timeline · Mira</span>
                  <span>{"↶  ↷"}</span>
                </div>
                <div className="ruler">
                  <span>00:00</span>
                  <span>00:30</span>
                  <span>01:00</span>
                  <span>01:30</span>
                </div>
                <div className="track">
                  <span>V1</span>
                  <div className="clip clip-one">coastline_master.mov</div>
                  <div className="clip clip-two" />
                  <i className="playhead" />
                </div>
                <div className="track audio">
                  <span>A1</span>
                  <div className="wave" />
                  <i className="playhead" />
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>

      <section id="product" className="section wrap">
        <div className="section-head">
          <p className="eyebrow">One project, one set of rules</p>
          <h2 className="headline">Stay close to the cut.</h2>
          <p>
            Cinesim keeps the creative work local and inspectable. The editor, the CLI, and agent
            tools all move through the same validated edits.
          </p>
        </div>

        <div className="features">
          <article id="timeline" className="feature">
            <div className="feature-copy">
              <p className="feature-number">01</p>
              <h3>A timeline made for the cut.</h3>
              <p>
                Trim, split, snap, layer, and shape fades. A finished gesture is one intentional,
                undoable edit — never a pile of half-applied state.
              </p>
              <Link className="link-arrow" href="/docs/guides/timeline">
                Explore editing <span>↗</span>
              </Link>
            </div>
            <div className="feature-visual">
              <div className="mock mock-timeline">
                <div className="mock-bar">
                  <span>Timeline · Mira</span>
                  <span>00:01:42:12</span>
                </div>
                <div className="mock-ruler" />
                <div className="mock-track">
                  <span>V1</span>
                  <i className="clip-a" />
                  <i className="clip-b" />
                  <i className="clip-c" />
                </div>
                <div className="mock-track">
                  <span>V2</span>
                  <i className="clip-d" />
                </div>
                <div className="mock-track">
                  <span>A1</span>
                  <em />
                </div>
                <div className="mock-track">
                  <span>A2</span>
                  <em className="short" />
                </div>
                <i className="mock-playhead" />
              </div>
            </div>
          </article>

          <article id="agents" className="feature reverse">
            <div className="feature-copy">
              <p className="feature-number">02</p>
              <h3>An agent that respects the project.</h3>
              <p>
                Use local Codex or Claude Code sessions through a scoped bridge — supervise the
                edit, inspect the diff, restore a checkpoint.
              </p>
              <Link className="link-arrow" href="/docs/guides/agents">
                See agent workflows <span>↗</span>
              </Link>
            </div>
            <div className="feature-visual">
              <div className="mock mock-agent">
                <div className="mock-bar">
                  <span className="signal" />
                  <span>Agent session</span>
                  <small>active</small>
                </div>
                <div className="agent-body">
                  <p className="agent-prompt">
                    Arrange the coastal sequence with a slower opening.
                  </p>
                  <ul className="agent-steps">
                    <li>
                      <i>✓</i>
                      <span>Inspected timeline</span>
                      <b>1.2s</b>
                    </li>
                    <li>
                      <i>✓</i>
                      <span>Resolved 3 clips</span>
                      <b>0.4s</b>
                    </li>
                    <li>
                      <i>✓</i>
                      <span>Prepared one edit</span>
                      <b>0.2s</b>
                    </li>
                  </ul>
                  <div className="agent-diff">
                    <span>.cinesim/timeline.json</span>
                    <b className="add">+12</b>
                    <b className="del">−4</b>
                  </div>
                  <div className="agent-input">
                    <span>Review proposed change</span>
                    <b>↵</b>
                  </div>
                </div>
              </div>
            </div>
          </article>

          <article id="files" className="feature">
            <div className="feature-copy">
              <p className="feature-number">03</p>
              <h3>Projects you can open anywhere.</h3>
              <p>
                Canonical files stay deterministic and readable. Generated media stays disposable.
                Your work remains yours, in a folder you already understand.
              </p>
              <Link className="link-arrow" href="/docs/reference/project-files">
                Read the project format <span>↗</span>
              </Link>
            </div>
            <div className="feature-visual">
              <div className="mock mock-files">
                <div className="mock-bar">
                  <span>mira/</span>
                  <span>project</span>
                </div>
                <pre>
                  <code>
                    {
                      "mira/\n├── cinesim.json\n├── .cinesim/\n│   ├── assets.json\n│   └── timeline.json\n└── .video/          "
                    }
                    <span>generated</span>
                  </code>
                </pre>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="section wrap">
        <div className="cinema">
          <img src="/images/salt-flat.png" alt="Salt flat landscape at sunset" />
          <div className="cinema-copy">
            <p className="eyebrow">Made to disappear into the work</p>
            <h2 className="headline">Tools should hold the frame, not pull focus.</h2>
            <p>
              Viewer, Media Pool, Inspector, Notes, and a real timeline — arranged around the
              decisions you are making right now.
            </p>
          </div>
        </div>
      </section>

      <section className="section wrap">
        <div className="section-head">
          <p className="eyebrow">What the foundation guarantees</p>
          <h2 className="headline">Built on a few commitments.</h2>
        </div>
        <div className="principles">
          {principles.map(([value, title, note]) => (
            <article key={value} className="principle">
              <p className="principle-value">{value}</p>
              <div>
                <p className="principle-title">{title}</p>
                <p className="principle-note">{note}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section wrap faq-section">
        <h2 className="headline">Frequently asked questions</h2>
        <div className="faq">
          {faqs.map(([question, answer]) => (
            <details key={question} className="faq-item">
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="closing wrap">
        <p className="eyebrow">Cinesim is in active development</p>
        <h2 className="display">Begin with the project, not the platform.</h2>
        <div className="closing-actions">
          <Link className="button primary" href="/docs">
            Visit the docs <span className="arrow">→</span>
          </Link>
          <Link className="button" href="/pricing">
            View pricing <span className="arrow">→</span>
          </Link>
        </div>
      </section>
    </>
  );
}
