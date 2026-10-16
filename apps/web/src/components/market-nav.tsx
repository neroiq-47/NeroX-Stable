"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/market", label: "Browse" },
  { href: "/market/jobs", label: "My jobs" },
  { href: "/market/sell", label: "Sell an agent" },
  { href: "/market/evaluator", label: "Evaluator" },
];

export function MarketNav() {
  const path = usePathname();
  return (
    <div className="tabs" role="navigation" aria-label="Market">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} className="tab" aria-selected={i.href === "/market" ? path === "/market" || path.startsWith("/market/agent") : path.startsWith(i.href)}>
          {i.label}
        </Link>
      ))}
    </div>
  );
}
