'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_CATEGORIES = [
  {
    header: 'Analytics',
    links: [
      { href: '/admin', label: 'Dashboard' },
      { href: '/admin/leads', label: 'Leads' },
    ],
  },
  {
    header: 'Workflows',
    links: [{ href: '/admin/pipelines', label: 'Pipelines Control Room' }],
  },
  {
    header: 'AI Strategy',
    links: [{ href: '/admin/niches', label: 'Niche Intelligence' }],
  },
  {
    header: 'The Engine Room',
    links: [
      { href: '/admin/sessions', label: 'Manual Test Crawl' },
      { href: '/admin/connections', label: 'Connections' },
      { href: '/admin/settings', label: 'Settings & Integrations' },
    ],
  },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
      {NAV_CATEGORIES.map((category) => (
        <div key={category.header}>
          <h3 className="px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            {category.header}
          </h3>
          <div className="space-y-1">
            {category.links.map(({ href, label }) => {
              // Active logic: if href is '/admin', it must match exactly to avoid matching everything.
              // Otherwise, match if pathname starts with href.
              const isActive =
                href === '/admin'
                  ? pathname === '/admin'
                  : pathname.startsWith(href);

              return (
                <Link
                  key={href}
                  href={href}
                  className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700 font-medium'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
