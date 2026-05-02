'use client';

import { useState } from 'react';
import type { Connection } from '../../../../lib/types';
import { useRouter } from 'next/navigation';
import PhoneInput, { parsePhoneNumber } from 'react-phone-number-input';
// @ts-ignore
import 'react-phone-number-input/style.css';

export default function ConnectManager({
  initialConnection,
}: {
  initialConnection: Connection | null;
}) {
  const router = useRouter();
  const [phoneValue, setPhoneValue] = useState<string | undefined>(
    initialConnection
      ? `+${initialConnection.countryCode}${initialConnection.phoneNumber}`
      : undefined
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const isConnected = initialConnection?.status === 'connected';

  const handleConnect = async () => {
    if (!phoneValue) {
      alert('Please enter a valid phone number');
      return;
    }

    const parsed = parsePhoneNumber(phoneValue);
    if (!parsed) {
      alert('Invalid phone number format');
      return;
    }

    const countryCode = parsed.countryCallingCode;
    const phoneNumber = parsed.nationalNumber;

    setIsConnecting(true);
    setSuccessMsg('');

    try {
      const res = await fetch('/api/admin/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode, phoneNumber }),
      });

      if (!res.ok) throw new Error('Failed to connect WhatsApp');

      // Simulate pairing delay
      await new Promise((resolve) => setTimeout(resolve, 1500));

      setSuccessMsg('WhatsApp Connected Successfully!');
      router.refresh();
    } catch (err: any) {
      console.error(err);
      alert(err.message);
    } finally {
      setIsConnecting(false);
      setTimeout(() => setSuccessMsg(''), 4000);
    }
  };

  const handleDisconnect = async () => {
    setIsConnecting(true);
    setSuccessMsg('');
    try {
      const res = await fetch('/api/admin/connections', {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Failed to disconnect WhatsApp');

      setSuccessMsg('WhatsApp Disconnected');
      router.refresh();
    } catch (err: any) {
      console.error(err);
      alert(err.message);
    } finally {
      setIsConnecting(false);
      setTimeout(() => setSuccessMsg(''), 4000);
    }
  };

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          Connect WhatsApp
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Enter your WhatsApp Business country code and phone number to pair it
          with the dispatcher.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-6">
        {isConnected ? (
          <div className="flex flex-col items-center justify-center space-y-4 py-6">
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
              <h2 className="text-lg font-medium text-gray-900">Connected</h2>
              <p className="text-sm text-gray-500">
                Messages will be sent from{' '}
                <span className="font-mono text-gray-800">
                  +{initialConnection?.countryCode}
                  {initialConnection?.phoneNumber}
                </span>
              </p>
            </div>
            <button
              onClick={handleDisconnect}
              disabled={isConnecting}
              className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-600 shadow-sm hover:bg-red-100 disabled:opacity-50"
            >
              Disconnect
            </button>
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
            <div className="pt-4 flex items-center justify-between">
              <span className="text-sm font-medium text-green-600">
                {successMsg}
              </span>
              <button
                type="button"
                onClick={handleConnect}
                disabled={isConnecting}
                className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-500 disabled:opacity-50"
              >
                {isConnecting ? 'Connecting...' : 'Connect WhatsApp'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
