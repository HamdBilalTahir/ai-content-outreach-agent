import Link from 'next/link';
import { LogoutButton } from '../../components/LogoutButton';

const NAV_LINKS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/leads', label: 'Leads' },
  { href: '/admin/outcomes', label: 'Outcome Logger' },
  { href: '/admin/niches', label: 'Niches' },
  { href: '/admin/sessions', label: 'Crawl Sessions' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/connect', label: 'Connect WhatsApp' },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-gray-50 text-gray-900">
      <aside className="w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-5 py-5 border-b border-gray-200">
          <span className="text-sm font-semibold leading-tight text-gray-800">
            AI Content Outreach Agent
          </span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="block rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
            >
              {label}
            </Link>
          ))}
        </nav>
        <LogoutButton />
      </aside>
      <main className="flex-1 overflow-auto p-8">{children}</main>
    </div>
  );
}
