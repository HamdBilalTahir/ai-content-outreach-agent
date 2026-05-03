export interface UnipileAccount {
  accountId: string;
  status: string;
  phoneNumber: string | null;
  connectedAt?: string;
}

export async function createUnipileHostedAuthLink(
  userId: string,
  successUrl: string
): Promise<string> {
  const baseUrl = process.env.UNIPILE_BASE_URL;
  const token = process.env.UNIPILE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error('Unipile configuration is missing');
  }

  const apiUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

  const response = await fetch(`${apiUrl}/api/v1/hosted/accounts/link`, {
    method: 'POST',
    headers: {
      'X-API-KEY': token,
      'Content-Type': 'application/json',

      Accept: 'application/json',
    },
    body: JSON.stringify({
      type: 'create',
      providers: ['WHATSAPP'],
      api_url: apiUrl,
      name: `WhatsApp Connection for ${userId}`,
      success_redirect_url: successUrl,
      failure_redirect_url: successUrl.replace('success=true', 'canceled=true'),
      expiresOn: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Failed to create Unipile hosted auth link:', error);
    throw new Error('Failed to create Unipile hosted auth link');
  }

  const data = await response.json();
  // We'll return the url provided by unipile
  return data.url;
}

export async function getConnectedAccounts(
  userId: string
): Promise<UnipileAccount[]> {
  const baseUrl = process.env.UNIPILE_BASE_URL;
  const token = process.env.UNIPILE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error('Unipile configuration is missing');
  }

  const apiUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

  const response = await fetch(`${apiUrl}/api/v1/accounts`, {
    method: 'GET',
    headers: {
      'X-API-KEY': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    console.error('Failed to fetch Unipile accounts');
    return [];
  }

  const data = await response.json();

  // Unipile typically returns a list of accounts
  // We map them to our interface
  const accounts = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.accounts)
      ? data.accounts
      : Array.isArray(data)
        ? data
        : [];

  // Filter or map as needed based on the response format
  // Assuming the name or some metadata contains the userId
  return accounts
    .filter(
      (acc: any) =>
        acc.provider === 'WHATSAPP' && (acc.name?.includes(userId) || true)
    ) // Ideally filtered by reference if Unipile supports it
    .map((acc: any) => ({
      accountId: acc.id,
      status: acc.sources?.[0]?.status || 'UNKNOWN',
      phoneNumber: acc.name, // Unipile often uses name for phone number in WA, or specific fields
      connectedAt: acc.creation_date,
    }));
}

export async function deleteUnipileAccount(
  accountId: string
): Promise<boolean> {
  const baseUrl = process.env.UNIPILE_BASE_URL;
  const token = process.env.UNIPILE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error('Unipile configuration is missing');
  }

  const apiUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

  try {
    const response = await fetch(`${apiUrl}/api/v1/accounts/${accountId}`, {
      method: 'DELETE',
      headers: {
        'X-API-KEY': token,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.error('Failed to delete Unipile account:', await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error deleting Unipile account:', error);
    return false;
  }
}

export async function sendWhatsappMessage(
  accountId: string,
  to: string,
  message: string
): Promise<boolean> {
  const dsn = process.env.UNIPILE_DSN || process.env.UNIPILE_TOKEN;
  let baseUrl = process.env.UNIPILE_BASE_URL;
  let token = process.env.UNIPILE_TOKEN;

  if (dsn && dsn.includes('api.unipile.com')) {
    const parts = dsn.split(':');
    baseUrl = parts.slice(0, -1).join(':');
    token = parts[parts.length - 1];
  } else if (!baseUrl && dsn) {
    // fallback if using token format
    token = dsn;
  }

  if (!baseUrl || !token) {
    throw new Error('Unipile configuration is missing');
  }

  const apiUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

  // Make sure to format to strictly to E.164 if possible. We assume it's done before calling this, but we can do a basic check here:
  const formattedTo = to.startsWith('+') ? to : `+${to.replace(/\D/g, '')}`;

  try {
    const cleanApiUrl = apiUrl.replace(/\/api$/, '');
    // Usually Unipile hosted instance API endpoint for chats creation is `/api/v1/chats`
    // where you pass attendees_ids and text.
    // Wait, the API error from earlier for /api/v1/chats was 422:
    // "One or more request parameters are invalid or missing.\\n{\"type\":45,\"schema\":...\"path\":\"/attendees_ids\",\"message\":\"Required property\"}"
    // This implies /api/v1/chats EXISTS and just wants the correct payload.
    // The previous attempt failed because I sent `message: { text: message }` but maybe it expects `text` directly on the root?
    // Let's use `/api/v1/chats` and send `account_id`, `attendees_ids`, and `text` (based on Unipile API docs).

    const directMessagesEndpoint = `${cleanApiUrl}/api/v1/chats`;
    const attendeeId = `${formattedTo.replace('+', '')}@s.whatsapp.net`;

    const response = await fetch(directMessagesEndpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        account_id: accountId,
        attendees_ids: [attendeeId],
        text: message,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(
        `❌ [Unipile] Failed to send WhatsApp message to ${formattedTo}:`,
        JSON.stringify(errorData)
      );

      // If error indicates number is not on whatsapp
      if (
        errorData.message?.includes('not found') ||
        errorData.error === 'Not Found'
      ) {
        throw new Error('Number not on WhatsApp');
      }
      return false;
    }

    const data = await response.json();
    console.log(
      `✅ [Unipile] WhatsApp message sent successfully to ${formattedTo} via Unipile! Message ID: ${data.message_id || data.id}`
    );
    return true;
  } catch (error: any) {
    console.error(
      `❌ [Unipile] Error sending WhatsApp message to ${formattedTo}:`,
      error.message || error
    );
    if (error.message === 'Number not on WhatsApp') {
      throw error;
    }
    return false;
  }
}
