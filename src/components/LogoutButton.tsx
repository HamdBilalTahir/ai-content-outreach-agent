'use client';

import { useAuth } from '../app/AuthProvider';

export function LogoutButton() {
  const { signOut } = useAuth();

  return (
    <div className="p-4 border-t border-gray-200">
      <button
        onClick={signOut}
        className="w-full text-left rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
      >
        Logout
      </button>
    </div>
  );
}
