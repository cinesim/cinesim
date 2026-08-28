import Link from "next/link";
import type { Metadata } from "next";
import "@/styles/pricing.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "A preview of Cinesim plans.",
};

const plans = [
  {
    name: "Local",
    price: "Free",
    note: "For editing projects on your machine.",
    items: [
      "Local projects",
      "Timeline editing",
      "CLI and local agent workflows",
      "Portable project files",
    ],
  },
  {
    name: "Cloud",
    price: "Planned",
    note: "For private originals and cloud projects.",
    items: [
      "Private original storage",
      "Cloud project catalog",
      "Resumable transfers",
      "Account-based storage choices",
    ],
  },
];

export default function PricingPage() {
  return (
    <>
      <section className="page-hero wrap">
        <p className="chip">Pricing</p>
        <h1 className="display">Simple by design.</h1>
        <p className="lede">
          Cinesim is being built local-first. Pricing is a product preview, not a checkout.
        </p>
      </section>

      <section className="plans wrap">
        {plans.map((plan) => (
          <article key={plan.name} className="plan">
            <p className="plan-name">{plan.name}</p>
            <h2 className="plan-price">{plan.price}</h2>
            <p className="plan-note">{plan.note}</p>
            <ul>
              {plan.items.map((item) => (
                <li key={item}>
                  <span aria-hidden="true">✓</span>
                  {item}
                </li>
              ))}
            </ul>
            <span className="plan-state">Not available yet</span>
          </article>
        ))}
      </section>

      <section className="pricing-note wrap">
        <div className="section-head">
          <p className="eyebrow">A promise for the foundation</p>
          <h2 className="headline">Your project files stay local and portable.</h2>
          <p>
            Cloud features are optional. The editor remains useful when you are offline, signed out,
            or working from an ordinary folder.
          </p>
        </div>
        <div className="pricing-actions">
          <Link className="button primary" href="/docs">
            Read the docs <span className="arrow">→</span>
          </Link>
          <Link className="button" href="/#product">
            See the product <span className="arrow">→</span>
          </Link>
        </div>
      </section>
    </>
  );
}
