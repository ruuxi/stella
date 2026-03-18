export const buildMagicLinkEmail = (logoSrc: string, signInUrl: string): string => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f7f8;padding:48px 24px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;">
          <tr>
            <td style="padding-bottom:32px;text-align:center;">
              <img src="${logoSrc}" alt="Stella logo" width="72" height="72" style="display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">
              <span style="font-size:16px;font-weight:500;letter-spacing:0.2em;color:#5a5a5a;text-transform:uppercase;">Stella</span>
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:32px;">
              <p style="margin:0 0 8px;font-size:16px;font-weight:500;color:#1a1a1a;">Sign in</p>
              <p style="margin:0 0 24px;font-size:14px;color:#6b6b6b;line-height:1.5;">
                Click the button below to sign in to your account. This link will expire in 10 minutes.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${signInUrl}" style="display:inline-block;padding:10px 32px;background-color:#1a1a1a;border-radius:6px;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.04em;">
                      Sign in to Stella
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:12px;color:#999999;line-height:1.5;">
                If you didn't request this email, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
