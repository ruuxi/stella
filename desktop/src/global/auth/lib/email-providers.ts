export interface EmailProvider {
  /** Friendly display name, e.g. "Gmail". */
  name: string;
  /** URL to open the provider's webmail inbox. */
  url: string;
}

const PROVIDER_BY_DOMAIN: Record<string, EmailProvider> = {
  "gmail.com": { name: "Gmail", url: "https://mail.google.com" },
  "googlemail.com": { name: "Gmail", url: "https://mail.google.com" },

  "outlook.com": { name: "Outlook", url: "https://outlook.live.com/mail" },
  "hotmail.com": { name: "Hotmail", url: "https://outlook.live.com/mail" },
  "live.com": { name: "Outlook", url: "https://outlook.live.com/mail" },
  "msn.com": { name: "Outlook", url: "https://outlook.live.com/mail" },

  "yahoo.com": { name: "Yahoo Mail", url: "https://mail.yahoo.com" },
  "ymail.com": { name: "Yahoo Mail", url: "https://mail.yahoo.com" },
  "rocketmail.com": { name: "Yahoo Mail", url: "https://mail.yahoo.com" },

  "aol.com": { name: "AOL Mail", url: "https://mail.aol.com" },

  "icloud.com": { name: "iCloud Mail", url: "https://www.icloud.com/mail" },
  "me.com": { name: "iCloud Mail", url: "https://www.icloud.com/mail" },
  "mac.com": { name: "iCloud Mail", url: "https://www.icloud.com/mail" },

  "proton.me": { name: "Proton Mail", url: "https://mail.proton.me" },
  "protonmail.com": { name: "Proton Mail", url: "https://mail.proton.me" },
  "pm.me": { name: "Proton Mail", url: "https://mail.proton.me" },

  "fastmail.com": { name: "Fastmail", url: "https://app.fastmail.com" },
  "fastmail.fm": { name: "Fastmail", url: "https://app.fastmail.com" },

  "zoho.com": { name: "Zoho Mail", url: "https://mail.zoho.com" },
  "yandex.com": { name: "Yandex Mail", url: "https://mail.yandex.com" },
  "yandex.ru": { name: "Yandex Mail", url: "https://mail.yandex.com" },
  "gmx.com": { name: "GMX Mail", url: "https://www.gmx.com/mail" },
  "gmx.net": { name: "GMX Mail", url: "https://www.gmx.net/mail" },
  "mail.ru": { name: "Mail.ru", url: "https://e.mail.ru" },
  "tutanota.com": { name: "Tuta Mail", url: "https://app.tuta.com" },
  "tuta.io": { name: "Tuta Mail", url: "https://app.tuta.com" },
};

/**
 * Detect a known webmail provider from an email address. Returns null when the
 * domain isn't a recognized consumer webmail (e.g. custom/business domains
 * where we can't guess where the user reads their mail).
 */
export function detectEmailProvider(email: string): EmailProvider | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  return PROVIDER_BY_DOMAIN[domain] ?? null;
}

export function openEmailProvider(provider: EmailProvider): void {
  if (window.electronAPI?.system.openExternal) {
    window.electronAPI.system.openExternal(provider.url);
    return;
  }
  window.open(provider.url, "_blank", "noopener,noreferrer");
}
