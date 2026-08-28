import Link from "next/link";
import { githubUrl } from "@/lib/shared";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <Link className="brand" href="/" aria-label="Cinesim home">
          <span>Cinesim</span>
        </Link>
        <nav className="site-nav" aria-label="Primary navigation">
          <Link href="/#product">Product</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <div className="header-actions">
          <a className="quiet-link" href={githubUrl} rel="noreferrer">
            GitHub
          </a>
          <Link className="pill" href="/docs">
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
