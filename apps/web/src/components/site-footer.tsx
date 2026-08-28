import Link from "next/link";
import { githubUrl } from "@/lib/shared";

const footerColumns = [
  {
    heading: "Product",
    links: [
      ["Overview", "/#product"],
      ["Timeline", "/#timeline"],
      ["Agents", "/#agents"],
      ["Project format", "/#files"],
      ["Pricing", "/pricing"],
    ],
  },
  {
    heading: "Documentation",
    links: [
      ["Getting started", "/docs/getting-started/local-projects"],
      ["Editing", "/docs/guides/timeline"],
      ["Agents", "/docs/guides/agents"],
      ["Project format", "/docs/reference/project-files"],
    ],
  },
  {
    heading: "Project",
    links: [
      ["GitHub", githubUrl],
      ["Internals", "/docs/internals/technical-decisions"],
      ["Docs", "/docs"],
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-top">
          <div className="footer-brand">
            <div className="brand">Cinesim</div>
            <p>
              Local-first editing for films in progress. People and agents work from the same
              project model.
            </p>
          </div>
          {footerColumns.map((column) => (
            <nav key={column.heading} className="footer-column" aria-label={column.heading}>
              <p className="footer-heading">{column.heading}</p>
              {column.links.map(([label, href]) =>
                href.startsWith("http") ? (
                  <a key={label} href={href} rel="noreferrer">
                    {label}
                  </a>
                ) : (
                  <Link key={label} href={href}>
                    {label}
                  </Link>
                ),
              )}
            </nav>
          ))}
        </div>
        <div className="footer-bottom">
          <p>&copy; 2026 Cinesim</p>
          <p>V1 preview &middot; in active development</p>
        </div>
      </div>
    </footer>
  );
}
