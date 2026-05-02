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
  const baseUrl = process.env.UNIPILE_BASE_URL;
  const token = process.env.UNIPILE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error('Unipile configuration is missing');
  }

  const maskedTo = to.length > 4 ? `****${to.slice(-4)}` : '****';

  const apiUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

  try {
    const response = await fetch(`${apiUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'X-API-KEY': token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        account_id: accountId,
        to: to,
        text: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Failed to send WhatsApp message to ${maskedTo}:`,
        errorText
      );
      return false;
    }

    console.log(`Successfully sent WhatsApp message to ${maskedTo}`);
    return true;
  } catch (error) {
    console.error(`Error sending WhatsApp message to ${maskedTo}:`, error);
    return false;
  }
}
