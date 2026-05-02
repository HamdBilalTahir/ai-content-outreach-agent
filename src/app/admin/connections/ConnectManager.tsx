'use client';

import { useState } from 'react';
import type { Connection } from '../../../../lib/types';
import type { UnipileAccount } from '../../../../lib/services/unipile';
import { useRouter } from 'next/navigation';

import PhoneInput, { parsePhoneNumber } from 'react-phone-number-input';
// @ts-ignore
import 'react-phone-number-input/style.css';

export default function ConnectManager({
  initialConnection,
  accounts,
}: {
  initialConnection: any;
  accounts: UnipileAccount[];
}) {
  const router = useRouter();
  const [phoneValue, setPhoneValue] = useState<string | undefined>(
    initialConnection &&
      initialConnection.phoneNumber &&
      initialConnection.phoneNumber !== 'Unknown'
      ? `+${initialConnection.countryCode || ''}${initialConnection.phoneNumber}`
      : undefined
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const isConnected = initialConnection?.status === 'connected';

  const handleConnect = async () => {
    if (!phoneValue) {
      setErrorMsg('Please enter a valid phone number');
      return;
    }

    const parsed = parsePhoneNumber(phoneValue);
    if (!parsed) {
      setErrorMsg('Invalid phone number format');
      return;
    }

    const countryCode = parsed.countryCallingCode;
    const phoneNumber = parsed.nationalNumber;

    setIsConnecting(true);
    setErrorMsg('');

    try {
      const res = await fetch('/api/admin/unipile/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          successUrl: `${window.location.origin}/admin/connections?success=true&countryCode=${countryCode}&phoneNumber=${phoneNumber}`,
        }),
      });

      const data = await res.json();

      if (!res.ok)
        throw new Error(data.error || 'Failed to generate connect link');

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message);
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setIsConnecting(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/admin/connections', {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Failed to disconnect WhatsApp');

      router.refresh();
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message);
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          Connect WhatsApp
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Connect your WhatsApp account using Unipile to allow the pipeline to
          dispatch messages.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-6">
        {errorMsg && (
          <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md">
            {errorMsg}
          </div>
        )}

        {isConnected || accounts.length > 0 ? (
          <div className="space-y-4">
            <h2 className="text-lg font-medium text-gray-900">
              Connected Accounts
            </h2>

            {isConnected && (
              <div className="flex flex-col items-center justify-center space-y-4 py-6 border border-green-200 rounded-lg bg-green-50 mb-6">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                  <svg
                    className="h-8 w-8 text-green-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth="1.5"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                    />
                  </svg>
                </div>
                <div className="text-center">
                  <h2 className="text-lg font-medium text-gray-900">
                    Active Connection
                  </h2>
                  <p className="text-sm text-gray-500">
                    Messages will be sent from{' '}
                    <span className="font-mono font-bold text-gray-800">
                      +{initialConnection.countryCode || ''}
                      {initialConnection.phoneNumber}
                    </span>
                  </p>
                </div>
                <button
                  onClick={handleDisconnect}
                  disabled={isConnecting}
                  className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-600 shadow-sm hover:bg-red-100 disabled:opacity-50"
                >
                  Disconnect All
                </button>
              </div>
            )}

            {accounts.map((acc) => (
              <div
                key={acc.accountId}
                className="flex items-center justify-between p-4 border border-gray-200 rounded-md bg-white"
              >
                <div>
                  <div className="font-medium text-gray-900">
                    {acc.phoneNumber || 'Unknown Number'}
                  </div>
                  <div className="text-sm text-gray-500">
                    Status:{' '}
                    <span className="font-medium capitalize">
                      {acc.status.toLowerCase()}
                    </span>
                  </div>
                  {acc.connectedAt && (
                    <div className="text-xs text-gray-400 mt-1">
                      Connected:{' '}
                      {new Date(acc.connectedAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label
                htmlFor="phoneNumber"
                className="block text-sm font-medium leading-6 text-gray-900 mb-2"
              >
                WhatsApp Number
              </label>
              <div className="[&>.PhoneInput]:flex [&>.PhoneInput]:gap-4 [&_.PhoneInputInput]:block [&_.PhoneInputInput]:w-full [&_.PhoneInputInput]:rounded-md [&_.PhoneInputInput]:border-0 [&_.PhoneInputInput]:py-1.5 [&_.PhoneInputInput]:pl-3 [&_.PhoneInputInput]:text-gray-900 [&_.PhoneInputInput]:ring-1 [&_.PhoneInputInput]:ring-inset [&_.PhoneInputInput]:ring-gray-300 placeholder:text-gray-400 [&_.PhoneInputInput]:focus:ring-2 [&_.PhoneInputInput]:focus:ring-inset [&_.PhoneInputInput]:focus:ring-green-600 sm:text-sm sm:leading-6">
                <PhoneInput
                  placeholder="Enter phone number"
                  value={phoneValue}
                  onChange={setPhoneValue}
                  defaultCountry="US"
                />
              </div>
            </div>

            <p className="text-sm text-gray-600">
              Enter your WhatsApp Business country code and phone number, then
              click to connect your account securely via Unipile.
            </p>

            <button
              onClick={handleConnect}
              disabled={isConnecting || !phoneValue}
              className="flex w-full justify-center rounded-md bg-green-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 disabled:opacity-50"
            >
              {isConnecting
                ? 'Generating Link...'
                : 'Connect WhatsApp via Unipile'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
