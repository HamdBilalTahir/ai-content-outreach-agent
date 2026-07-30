export interface UnipileAccount {
  accountId: string;
  status: string;
  phoneNumber: string | null;
  connectedAt?: string;
}

function getUnipileConfig(): { apiUrl: string; token: string } {
  const dsn = process.env.UNIPILE_DSN || process.env.UNIPILE_TOKEN;
  let baseUrl = process.env.UNIPILE_BASE_URL;
  let token = process.env.UNIPILE_TOKEN || '';

  if (dsn && dsn.includes('.unipile.com')) {
    const parts = dsn.split(':');
    if (parts.length >= 4) {
      // Embedded-token DSN: "https://api29.unipile.com:PORT:TOKEN"
      baseUrl = parts.slice(0, -1).join(':');
      token = parts[parts.length - 1];
    } else {
      // Plain base URL: "https://api29.unipile.com:PORT/" — token is in UNIPILE_TOKEN
      baseUrl = dsn;
    }
  }

  if (!baseUrl || !token) {
    throw new Error('Unipile configuration is missing');
  }

  const raw = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
  const clean = raw.replace(/\/$/, '').replace(/\/api$/, '');
  return { apiUrl: clean, token };
}

export async function createUnipileHostedAuthLink(
  userId: string,
  successUrl: string
): Promise<string> {
  const { apiUrl, token } = getUnipileConfig();

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
  return data.url;
}

export async function getConnectedAccounts(
  userId: string
): Promise<UnipileAccount[]> {
  const { apiUrl, token } = getUnipileConfig();

  const response = await fetch(`${apiUrl}/api/v1/accounts`, {
    method: 'GET',
    headers: {
      'X-API-KEY': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(
      `Failed to fetch Unipile accounts: ${response.status} ${errorText}`
    );
    throw new Error('Failed to fetch Unipile accounts');
  }

  const data = await response.json();

  const accounts = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.accounts)
      ? data.accounts
      : Array.isArray(data)
        ? data
        : [];

  return accounts
    .filter(
      (acc: any) =>
        acc.provider === 'WHATSAPP' && (acc.name?.includes(userId) || true)
    )
    .map((acc: any) => ({
      accountId: acc.id,
      status: acc.sources?.[0]?.status || 'UNKNOWN',
      phoneNumber: acc.name,
      connectedAt: acc.creation_date,
    }));
}

export async function deleteUnipileAccount(
  accountId: string
): Promise<boolean> {
  const { apiUrl, token } = getUnipileConfig();

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
  const { apiUrl, token } = getUnipileConfig();

  const formattedTo = to.startsWith('+') ? to : `+${to.replace(/\D/g, '')}`;
  const attendeeId = `${formattedTo.replace('+', '')}@s.whatsapp.net`;

  try {
    const response = await fetch(`${apiUrl}/api/v1/chats`, {
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
      `✅ [Unipile] WhatsApp message sent successfully to ${formattedTo}. Message ID: ${data.message_id || data.id}`
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
