import { LogoutButton } from '../../components/LogoutButton';
import { SidebarNav } from './SidebarNav';

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
            Autonomous Overseer
          </span>
        </div>
        <SidebarNav />
        <LogoutButton />
      </aside>
      <main className="flex-1 overflow-auto p-8">{children}</main>
    </div>
  );
}
