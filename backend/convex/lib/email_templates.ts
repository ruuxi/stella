import { emailDir, getEmailStrings } from "./email_i18n";

/**
 * Build the magic-link sign-in email. Locale is the user's stored
 * preference (BCP-47); when missing, falls back to English. The
 * `<html>` element gets `lang` and `dir` attributes so screen readers
 * and email clients render the body in the correct script direction.
 */
export const buildMagicLinkEmail = (
  logoSrc: string,
  signInUrl: string,
  locale?: string | null,
): string => {
  const strings = getEmailStrings(locale);
  const dir = emailDir(locale);
  const lang = locale && locale.trim() ? locale.trim() : "en";

  return `
<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300&family=Manrope:wght@400;500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background-color:#f2f4f8;font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2f4f8;padding:64px 24px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;">
          <!-- Logo -->
          <tr>
            <td style="padding-bottom:40px;text-align:center;">
              <img src="${logoSrc}" alt="Stella" width="48" height="48" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;">
            </td>
          </tr>
          <!-- Card -->
          <tr>
            <td style="background-color:rgba(255,255,255,0.92);border:1px solid rgba(22,22,22,0.08);border-radius:10px;padding:40px 36px;">
              <!-- Title -->
              <h1 style="margin:0 0 6px;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;font-style:italic;letter-spacing:-0.02em;line-height:1.1;color:#161616;">
                ${strings.signInTitle}
              </h1>
              <p style="margin:0 0 32px;font-size:14px;color:rgba(22,22,22,0.52);line-height:1.55;letter-spacing:-0.01em;">
                ${strings.signInDescription}
              </p>
              <!-- Divider -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr><td style="border-top:1px solid rgba(22,22,22,0.1);font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
              <!-- Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${signInUrl}" style="display:inline-block;padding:12px 36px;border:1px solid rgba(22,22,22,0.18);border-radius:6px;background-color:transparent;color:#161616;font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:500;text-decoration:none;letter-spacing:-0.01em;">
                      ${strings.signInButton}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding-top:28px;text-align:center;">
              <p style="margin:0;font-size:12px;color:rgba(22,22,22,0.35);line-height:1.5;letter-spacing:-0.01em;">
                ${strings.ignoreFooter}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

export const getMagicLinkSubject = (
  locale: string | null | undefined,
): string => getEmailStrings(locale).subjectMagicLink;
